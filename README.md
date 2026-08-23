# Storj Compaction Orchestrator

Локальный dashboard для последовательного запуска тяжёлых `full compaction` на
нескольких Storj Storage Nodes. Ноды объединяются по физическим дискам:

- внутри одной группы full compaction выполняются строго по одной;
- разные физические диски могут обслуживаться параллельно;
- состояние и прогресс берутся из `GET /api/sno/compaction`;
- запуск выполняется через `POST /api/sno/compaction/start` с multinode API key;
- история запусков и разница runtime-счётчиков сохраняются локально.
- очереди дисков и отдельные ноды могут запускаться по недельному расписанию.

Для работы нужен storagenode с нашим API ручной compaction и включённой
настройкой:

```yaml
hashstore:
  compaction:
    manual-log-compaction: true
```

или:

```text
STORJ_HASHSTORE_COMPACTION_MANUAL_LOG_COMPACTION=true
```

## Сборка и запуск

```bash
go test ./...
CGO_ENABLED=1 go build -buildvcs=false -trimpath -o storj-compaction-orchestrator .
./storj-compaction-orchestrator
```

Драйвер SQLite тот же, что использует Storj Multinode (`mattn/go-sqlite3`),
поэтому для самостоятельной сборки нужен C-компилятор и `CGO_ENABLED=1`.
Готовый Linux-бинарник собирается статически: отдельная библиотека SQLite на
машине запуска ему не нужна.

## Автоматические сборки

GitHub Actions запускает тесты при каждом push и pull request. После отправки
тега `v*` release workflow собирает архивы для:

- Linux AMD64 и ARM64;
- Windows AMD64;
- macOS Intel и ARM64.

Версия внутри бинарника берётся из тега релиза. Вместе с архивами публикуется
`checksums.txt` с SHA-256. Архивы и файл контрольных сумм получают GitHub
Artifact Attestation, связывающую их с исходным коммитом и workflow. Подписанный
Sigstore bundle также прикладывается к релизу отдельным файлом.

После загрузки всех файлов workflow публикует release. Для новых релизов
включена неизменяемость: опубликованные assets нельзя заменить, а связанный тег
нельзя передвинуть или удалить. Проверка всего релиза и отдельного файла:

```bash
gh release verify v0.6.3 -R Aleksman4o/storj-compaction-orchestrator
gh release verify-asset v0.6.3 storj-compaction-orchestrator-v0.6.3-linux-amd64.tar.gz \
  -R Aleksman4o/storj-compaction-orchestrator
```

Дополнительная проверка build-provenance конкретного файла:

```bash
gh attestation verify storj-compaction-orchestrator-v0.6.3-linux-amd64.tar.gz \
  -R Aleksman4o/storj-compaction-orchestrator
```

Для публикации следующего релиза достаточно отправить новый тег. Сам GitHub
Release вручную создавать не нужно:

```bash
git tag v0.6.3
git push origin v0.6.3
```

Тот же workflow публикует multi-architecture Docker image для AMD64 и ARM64:

```bash
docker run -d --name storj-compaction-orchestrator \
  -p 14008:14008 \
  -v storj_compaction_data:/data \
  ghcr.io/aleksman4o/storj-compaction-orchestrator:latest
```

Версионный Docker-тег совпадает с тегом релиза, например `v0.6.3`.
Образ также получает проверяемую attestation:

```bash
gh auth token | docker login ghcr.io -u Aleksman4o --password-stdin
gh attestation verify \
  oci://ghcr.io/aleksman4o/storj-compaction-orchestrator:v0.6.3 \
  -R Aleksman4o/storj-compaction-orchestrator
```

Без параметров dashboard слушает все интерфейсы на порту `14008`:

```text
http://<адрес-сервера>:14008
```

Параметры можно задать флагами или окружением:

| Флаг | Переменная окружения | По умолчанию |
|---|---|---|
| `--listen` | `COMPACTION_ORCHESTRATOR_LISTEN` | `0.0.0.0:14008` |
| `--database` | `COMPACTION_ORCHESTRATOR_DATABASE` | `orchestrator.db` рядом с исполняемым файлом |
| — | `COMPACTION_ORCHESTRATOR_PASSWORD` | `orchestra` |

Форма входа запрашивает только пароль, логина нет. После успешного входа
создаётся защищённая `HttpOnly` session cookie, действующая до закрытия
браузера или перезапуска orchestrator. При доступе через недоверенную сеть
обязательно замените стандартный пароль и используйте HTTPS reverse proxy или
VPN: пароль и multinode keys нельзя передавать по открытому HTTP.

## Настройка нод

Адрес ноды — это адрес её web dashboard, а не публичный Storj-порт:

```text
http://192.168.1.20:14002
```

Создание multinode key в Docker:

```bash
docker exec -it <container> /app/bin/storagenode issue-apikey \
  --config-dir /app/config --identity-dir /app/identity
```

В старых образах бинарник может находиться по пути `/app/storagenode`.

При самостоятельной установке:

```bash
storagenode issue-apikey \
  --config-dir <config-dir> --identity-dir <identity-dir>
```

Ключи не возвращаются frontend после сохранения. Они находятся только в
`orchestrator.db`; база создаётся с правами `0600`.
Кнопка «Проверить адрес» проверяет доступность read-only API. Проверить права
самого ключа без запуска невозможно: на ноде ключ требуется именно endpoint-у
старта, поэтому фактическая авторизация проверяется при первом запуске.

## Гарантии очереди

Перед запуском orchestrator заново опрашивает **все включённые ноды группы**.
Запуск отклоняется, если хотя бы одна из них недоступна либо уже выполняет
manual full compaction. Это fail-closed поведение не позволяет начать вторую
тяжёлую операцию на диске, состояние которого неизвестно.

После принятого POST временная потеря связи с текущей нодой не считается
завершением. Orchestrator продолжит ждать и не перейдёт к следующей ноде.
Кнопка «Остановить после текущей» останавливает только дальнейшую очередь:
API ноды не умеет отменять уже начатую compaction.

Если orchestrator перезапущен, незавершённая очередь восстанавливается из
SQLite. Orchestrator подключается к текущей ноде, проверяет сохранённый
`nodeJobId`, ждёт завершения именно этой compaction и затем продолжает очередь.
Если нода недоступна, диск остаётся заблокированным: отсутствие HTTP-связи не
доказывает, что compaction остановилась. При несовпадении job ID следующая нода
также не запускается, пока обнаруженная сторонняя работа не завершится.

Защититься от запуска full compaction сторонней командой уже **после**
preflight невозможно без общей межпроцессной блокировки. Для сохранения
гарантии используйте orchestrator как единственную точку ручного запуска.

## Расписание

На отдельной вкладке можно создать недельные правила для всей группы диска или
для одной ноды. В обоих случаях используется тот же fail-closed preflight:
перед стартом должны отвечать все включённые ноды на физическом диске, а другая
full compaction на нём не должна выполняться.

Время задаётся в общем часовом поясе IANA, например `Europe/Moscow`. Если к
назначенному времени диск занят либо одна из его нод недоступна, правило не
считается выполненным и повторяется до конца этого календарного дня. После
принятия запуска его идентификатор сохраняется в SQLite, поэтому
перезапуск orchestrator не создаст дубль того же запуска.

Dashboard рассчитан на большие установки. На обзоре есть единая таблица всех
физических дисков: активные операции поднимаются вверх, а текущая нода,
спутник, режим, прогресс, ETA и состояние очереди видны в одной строке.
Таблицу можно отфильтровать до активных дисков или переключить в подробные
карточки. Ноды, диски и правила можно искать и сортировать; длинные списки
настроек и правил разбиты на страницы.

## Статистика

Dashboard показывает:

- состояние manual job, текущий спутник и число уже обработанных спутников;
- прогресс текущего атомарного раунда и ETA;
- reclaimable, а также rewritten и reclaimed bytes текущей очереди;
- ошибки compaction и показатели salvage;
- полную историю очередей, среднюю продолжительность по диску и
  раскрываемые результаты каждой ноды с ошибками.

SQLite работает в режиме WAL с `synchronous=FULL`. Текущие ответы нод остаются
в памяти и не записываются при каждом опросе: транзакции выполняются только при
изменении настроек, расписания или состояния очереди.

Счётчики, приходящие от ноды, существуют с момента запуска её процесса.
Orchestrator сохраняет разницу «после − до» для каждого своего запуска. Если
процесс ноды перезапустился, отрицательная разница не интерпретируется как
реальный результат и показывается как ноль.

## Проверка API из командной строки

Для изменяющих запросов собственный API orchestrator требует защитный заголовок:

```bash
curl -c /tmp/orchestrator-cookie \
  -H 'Content-Type: application/json' \
  -d '{"password":"orchestra"}' \
  http://127.0.0.1:14008/auth/login

curl -b /tmp/orchestrator-cookie -X POST \
  -H 'X-Orchestrator-Request: 1' \
  http://127.0.0.1:14008/api/groups/<group-id>/start
```
