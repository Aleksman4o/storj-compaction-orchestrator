(function () {
  const storageKey = 'storj-compaction-language';
  const translations = Object.freeze({
    'Основная навигация': 'Main navigation',
    'Обзор': 'Overview', 'Расписание': 'Schedule', 'Настройки': 'Settings', 'Подключение…': 'Connecting…',
    'Управление нагрузкой': 'Load control', 'Компакции': 'Compactions', 'По одной ноде на физический диск. Без одновременного переписывания логов.': 'One node per physical disk. No concurrent log rewriting.', 'Обновить': 'Refresh',
    'Добавьте первую группу диска': 'Add the first disk group', 'Укажите адреса нод и multinode API keys. После этого здесь появятся текущее состояние, очереди и статистика.': 'Enter node addresses and multinode API keys. Current state, queues, and statistics will appear here.', 'Открыть настройки': 'Open settings',
    'Диски и очереди': 'Disks and queues', 'Единое состояние всех физических дисков. Активные операции автоматически поднимаются вверх.': 'Unified state of all physical disks. Active operations are automatically moved to the top.', 'Только активные': 'Active only', 'Таблица': 'Table', 'Карточки': 'Cards',
    'Диск': 'Disk', 'Состояние': 'State', 'Текущая нода': 'Current node', 'Спутник': 'Satellite', 'Прогресс / осталось': 'Progress / remaining', 'Готово': 'Done', 'К очистке': 'To clean', 'Очищено': 'Cleaned', 'Переписано': 'Rewritten',
    'Ноды': 'Nodes', 'Актуальные показатели из': 'Current metrics from', 'Сортировка таблицы не меняет порядок очереди.': 'Table sorting does not change queue order.', '. Сортировка таблицы не меняет порядок очереди.': '. Table sorting does not change queue order.', 'Нода': 'Node', 'Текущая работа': 'Current work', 'Очищено с запуска': 'Cleaned since start', 'Переписано с запуска': 'Rewritten since start', 'Скорость': 'Speed', 'Все диски': 'All disks',
    'История запусков': 'Run history', 'Результаты очередей orchestrator сохраняются между перезапусками.': 'Orchestrator queue results persist across restarts.', 'Запуск': 'Run', 'Источник': 'Source', 'Результат': 'Result', 'Длительность': 'Duration',
    'Автоматизация': 'Automation', 'Запускайте очередь всего диска или отдельную ноду по дням недели либо через заданный интервал.': 'Run a whole-disk queue or an individual node on selected weekdays or at a fixed interval.', 'Сохранить расписание': 'Save schedule', 'Часовой пояс': 'Time zone', 'Время всех правил интерпретируется в одном часовом поясе IANA.': 'All rule times are interpreted in one IANA time zone.', 'Ближайшие 7 дней': 'Next 7 days', 'Сверху — даты, слева — время. В ячейках указаны названия расписаний, рассчитанных на весь период.': 'Dates are shown at the top and time on the left. Cells contain schedule names calculated for the entire period.', '+ Новое правило': '+ New rule', 'Редактор правила': 'Rule editor', 'Открыт только выбранный элемент, поэтому обзор остаётся компактным.': 'Only the selected item is open, keeping the overview compact.',
    'Конфигурация': 'Configuration', 'Объедините ноды, использующие один физический диск.': 'Group nodes that use the same physical disk.', 'Сохранить изменения': 'Save changes', 'Физические диски': 'Physical disks', 'В каждой группе одновременно работает не более одной full compaction.': 'No more than one full compaction runs in each group at a time.', '+ Добавить диск': '+ Add disk', 'Все ноды': 'All nodes', 'Подробное редактирование адресов и ключей. Привязку удобнее менять в карточке диска выше.': 'Edit addresses and keys in detail. Disk assignment is easier to change in the disk card above.', '+ Добавить ноду': '+ Add node', 'Название': 'Name', 'Адрес dashboard': 'Dashboard address', 'Физический диск': 'Physical disk', 'Включена': 'Enabled',
    'Обновление данных': 'Data refresh', 'Интервал опроса нод. Во время активного запуска прогресс дополнительно проверяется каждые 2 секунды.': 'Node polling interval. During an active run, progress is additionally checked every 2 seconds.', 'Интервал, секунд': 'Interval, seconds', 'Язык интерфейса': 'Interface language', 'Русский': 'Russian',
    'Как получить multinode key': 'How to obtain a multinode key', 'Ключ создаётся самой нодой и записывается в её базу. Для Docker:': 'The key is created by the node and stored in its database. For Docker:', 'Копировать': 'Copy', 'Для установленного бинарника:': 'For an installed binary:', 'Важно': 'Important', 'О ключах': 'About keys',
    'Пароль': 'Password', 'Войти': 'Sign in', 'Доступ к оркестратору': 'Orchestrator access', 'Введите пароль': 'Enter password', 'Вход · Storj Compaction': 'Sign in · Storj Compaction',
    'Найти диск или ноду': 'Find disk or node', 'Найти ноду': 'Find node', 'Найти диск': 'Find disk',
    'Запустить': 'Start', 'Остановить': 'Stop', 'Занят': 'Busy', 'Ноды': 'Nodes', 'В таблицу': 'Show in table', 'Ожидание': 'Waiting', 'В сети': 'Online', 'Нет связи': 'Offline', 'Отключена': 'Disabled', 'Свободен': 'Idle', 'Нет нод': 'No nodes', 'Нет работы': 'No work', 'Между раундами': 'Between rounds',
    'Проверка': 'Checking', 'Выполняется': 'Running', 'Успешно': 'Succeeded', 'Ошибка': 'Failed', 'В очереди': 'Queued', 'Пропущено': 'Skipped', 'Отменено': 'Canceled', 'Прервано': 'Interrupted',
    'Прогресс': 'Progress', 'Скрыть состав': 'Hide nodes', 'Остановить после текущей': 'Stop after current', 'Full compaction уже выполняется': 'Full compaction is already running', 'Запустить очередь': 'Start queue',
    'Диски не найдены': 'No disks found', 'Ноды не найдены': 'No nodes found', 'Запусков пока не было': 'No runs yet', 'На диске нет нод': 'No nodes on this disk', 'Нет включённых нод': 'No enabled nodes',
    'manual mode выключен': 'manual mode disabled', 'нет данных': 'no data', 'Вручную': 'Manual', 'Скрыть': 'Hide', 'Детали': 'Details',
    'Название диска': 'Disk name', 'Переместить на диск': 'Move to disk', 'Редактируется': 'Editing', 'Редактировать': 'Edit', 'Проверить адрес': 'Test address', 'Свернуть': 'Collapse', 'Удалить': 'Delete', 'Выберите диск': 'Select a disk', 'Справа появится его состав и управление привязками.': 'Its nodes and assignment controls will appear on the right.', 'Новая нода': 'New node', 'Адрес ещё не указан': 'Address is not set yet', 'На диске пока нет нод': 'There are no nodes on this disk yet', 'Добавьте новую или перенесите существующую.': 'Add a new node or move an existing one.',
    'Правило не выбрано': 'No rule selected', 'Нажмите название расписания в обзоре или создайте новое правило.': 'Click a schedule name in the overview or create a new rule.', 'Время': 'Time', 'Без названия': 'Untitled', 'На ближайшие 7 дней запусков нет.': 'No runs in the next 7 days.', 'Не показаны в календаре:': 'Not shown in the calendar:', 'Новое правило': 'New rule',
    'Первый запуск': 'First run', 'Каждые, часов': 'Every, hours', 'Объект': 'Target', 'Диск или нода': 'Disk or node', 'Повтор': 'Repeat', 'Дни недели': 'Weekdays', 'Интервал': 'Interval', 'Включено': 'Enabled', 'Дублировать': 'Duplicate', 'Закрыть': 'Close', '+ Добавить ещё': '+ Add another',
    'Пн': 'Mon', 'Вт': 'Tue', 'Ср': 'Wed', 'Чт': 'Thu', 'Пт': 'Fri', 'Сб': 'Sat', 'Вс': 'Sun', 'Сегодня': 'Today', 'Завтра': 'Tomorrow',
    'Ключ сохранён · оставьте пустым': 'Key saved · leave blank', 'Вставьте ключ': 'Paste key', 'Удалить диск': 'Delete disk', 'Позиция в очереди': 'Queue position',
    'На ноде должен быть включён': 'The node must have', '. Dashboard-порт должен быть доступен серверу orchestrator.': '. The dashboard port must be reachable from the orchestrator server.',
    'Ключи хранятся только на backend в': 'Keys are stored only by the backend in', 'с правами 0600 и никогда не возвращаются браузеру.': 'with 0600 permissions and are never returned to the browser.',
  });
  const reverseTranslations = Object.freeze(Object.fromEntries(Object.entries(translations).map(([ru, en]) => [en, ru])));
  const staticTextNodes = new WeakSet();
  const staticAttributes = new WeakMap();
  let initialized = false;

  function getLanguage() {
    try { return localStorage.getItem(storageKey) === 'en' ? 'en' : 'ru'; } catch (_) { return 'ru'; }
  }

  function setLanguage(language) {
    try { localStorage.setItem(storageKey, language === 'en' ? 'en' : 'ru'); } catch (_) {}
  }

  function pick(ru, en, language = getLanguage()) {
    return language === 'en' ? en : ru;
  }

  function translatedText(value, language) {
    const leading = value.match(/^\s*/)?.[0] || '';
    const trailing = value.match(/\s*$/)?.[0] || '';
    const text = value.trim();
    const translated = language === 'en' ? translations[text] : reverseTranslations[text];
    return translated ? `${leading}${translated}${trailing}` : value;
  }

  function translateDocument(language = getLanguage(), root = document) {
    document.documentElement.lang = language;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!initialized) staticTextNodes.add(node);
      if (!staticTextNodes.has(node)) continue;
      node.nodeValue = translatedText(node.nodeValue, language);
    }
    const attributes = ['placeholder', 'title', 'aria-label'];
    root.querySelectorAll?.('*').forEach(element => {
      let tracked = staticAttributes.get(element);
      if (!tracked && !initialized) {
        tracked = new Set();
        staticAttributes.set(element, tracked);
      }
      for (const attribute of attributes) {
        if (!element.hasAttribute(attribute)) continue;
        if (!initialized) tracked.add(attribute);
        if (!tracked?.has(attribute)) continue;
        element.setAttribute(attribute, translatedText(element.getAttribute(attribute), language));
      }
    });
    initialized = true;
  }

  globalThis.OrchestratorI18n = {getLanguage, setLanguage, pick, translateDocument};
})();
