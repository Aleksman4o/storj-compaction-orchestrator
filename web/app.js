const PAGE_SIZE = 25;
const GROUP_PAGE_SIZE = 12;
const REWRITE_RATE_WINDOW = 10;
const REWRITE_RATE_MAX_GAP_SECONDS = 15 * 60;
const state = {
  dashboard: null,
  history: null,
  settings: null,
  view: 'dashboard',
  groupView: 'table',
  timer: null,
  expandedGroups: new Set(),
  expandedJobs: new Set(),
  selectedSettingsGroup: '',
  editingNodeID: '',
  editingScheduleID: '',
  dirtySchedules: new Set(),
  rewriteRates: new Map(),
  reclaimedRounds: new Map(),
  language: globalThis.OrchestratorI18n?.getLanguage() || 'ru',
  sort: {
    groups: {key: 'activity', direction: 'desc'},
    nodes: {key: 'name', direction: 'asc'},
    history: {key: 'started', direction: 'desc'},
    settingsNodes: {key: 'name', direction: 'asc'},
  },
  filter: {
    groups: '', groupsActiveOnly: false, groupPage: 1,
    nodes: '', nodeGroup: '', nodePage: 1, historyPage: 1,
    settingsGroups: '', settingsNodes: '', settingsNodeGroup: '',
  },
};
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
let collator = new Intl.Collator(state.language, {numeric: true, sensitivity: 'base'});
const SATELLITE_NAMES = Object.freeze({
  '12EayRS2V1kEsWESU9QMRseFhdxYxKicsiFmxrsLZHeLUtdps3S': 'US1',
  '12L9ZFwhzVpuEKMUNUqkaTLGzwY9G24tbiigLiXpmZWKwmcNDDs': 'EU1',
  '121RTSDpyNZVcEU84Ticf2L1ntiuUimbWgfATz21tuvgk3vzoA6': 'AP1',
  '1wFTAgs9DP5RSnCqKV1eLf6N9wtk4EAtmN5DpSxcs8EjT69tGE': 'Saltlake',
});

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

function tr(ru, en) {
  return state.language === 'en' ? en : ru;
}

function applyLanguage() {
  globalThis.OrchestratorI18n?.translateDocument(state.language);
}

function nodeAddress(value, className = 'node-url') {
  const address = String(value || '');
  if (!/^https?:\/\//i.test(address)) return `<span class="${esc(className)}">${esc(address)}</span>`;
  return `<a class="${esc(className)} node-link" href="${esc(address)}" target="_blank" rel="noopener noreferrer">${esc(address)}</a>`;
}

async function request(path, options = {}) {
  const changing = options.method && options.method !== 'GET';
  const response = await fetch(path, {headers: {'Accept':'application/json', ...(options.body ? {'Content-Type':'application/json'} : {}), ...(changing ? {'X-Orchestrator-Request':'1'} : {})}, ...options});
  if (response.status === 401) {
    location.replace('/login.html');
    throw new Error(tr('Требуется повторный вход', 'Please sign in again'));
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function bytes(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n === 0) return '0 B';
  const units = ['B','KB','MB','GB','TB','PB'];
  const i = Math.min(Math.floor(Math.log(Math.abs(n)) / Math.log(1000)), units.length - 1);
  return `${(n / 1000 ** i).toFixed(i < 2 ? 1 : 2)} ${units[i]}`;
}

function rate(value) {
  return Number.isFinite(value) ? `${bytes(value)}/${tr('с', 's')}` : '—';
}

function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)} ${tr('сек', 'sec')}`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} ${tr('мин', 'min')}`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} ${tr('ч', 'h')}`;
  return `${(seconds / 86400).toFixed(1)} ${tr('дн', 'd')}`;
}

function elapsed(start, finish) {
  if (!start) return '—';
  return duration((new Date(finish || Date.now()) - new Date(start)) / 1000);
}

function time(value) {
  return value ? new Date(value).toLocaleString(state.language === 'en' ? 'en-GB' : 'ru-RU', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'}) : '—';
}

function scheduleTime(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString(state.language === 'en' ? 'en-GB' : 'ru-RU', {timeZone: state.settings?.timezone || 'UTC', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'});
  } catch (_) {
    return time(value);
  }
}

function scheduleLocalParts(value) {
  const timeZone = state.settings?.timezone || 'UTC';
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23',
    }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
    const hour = parts.hour === '24' ? '00' : parts.hour;
    return {date: `${parts.year}-${parts.month}-${parts.day}`, time: `${hour}:${parts.minute}`};
  } catch (_) {
    return {date: '', time: ''};
  }
}

function scheduleCalendarDays() {
  const base = scheduleLocalParts(state.dashboard?.generatedAt || new Date());
  if (!base.date) return [];
  const [year, month, day] = base.date.split('-').map(Number);
  const anchor = Date.UTC(year, month - 1, day, 12);
  return Array.from({length:7}, (_, index) => {
    const value = new Date(anchor + index * 86400000);
    const key = value.toISOString().slice(0, 10);
    const parts = Object.fromEntries(new Intl.DateTimeFormat(state.language === 'en' ? 'en-GB' : 'ru-RU', {
      timeZone:'UTC', weekday:'short', day:'2-digit', month:'2-digit',
    }).formatToParts(value).map(part => [part.type, part.value]));
    const caption = index === 0 ? tr('Сегодня', 'Today') : index === 1 ? tr('Завтра', 'Tomorrow') : parts.weekday.replace('.', '');
    return {key, date:`${parts.day}.${parts.month}`, caption};
  });
}

function toast(message, error = false) {
  const element = $('#toast');
  element.textContent = message;
  element.className = error ? 'visible error' : 'visible';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.className = '', 4200);
}

function setView(view, updateHash = true) {
  state.view = view;
  if (updateHash) history.replaceState(null, '', view === 'dashboard' ? location.pathname : `#${view}`);
  $$('.view').forEach(element => element.classList.toggle('active', element.id === `${view}-view`));
  $$('.nav-item').forEach(element => element.classList.toggle('active', element.dataset.view === view));
  if ((view === 'settings' || view === 'schedule') && !state.settings) loadSettings();
  if (view === 'schedule' && state.settings) renderSchedules();
}

function currentActivity(node) {
  const info = node.runtime.info;
  const satellite = (info?.satellites || []).find(item => item.compacting);
  return {
    progress: satellite?.currentRound || null,
    satelliteID: satellite?.satelliteID || info?.manualJob?.currentSatellite || '',
    mode: satellite?.mode || (info?.manualJob?.state === 'running' ? 'full' : 'compaction'),
  };
}

function rewriteSession(node) {
  const info = node.runtime.info;
  const manual = info?.manualJob;
  if (!node.enabled || !node.runtime.online || !info || (!info.compacting && manual?.state !== 'running')) return '';
  if (manual?.state === 'running') return `manual:${manual.id}:${manual.startedAt || ''}`;
  const activity = currentActivity(node);
  return `automatic:${activity.mode}:${activity.satelliteID}`;
}

function resetRewriteRate(nodeID, session, checkedAt, rewrittenBytes) {
  state.rewriteRates.set(nodeID, {
    session, checkedAt, rewrittenBytes, samples: [], bytesPerSecond: null,
  });
}

function updateRewriteRates(nodes) {
  const active = new Set();
  for (const node of nodes) {
    const session = rewriteSession(node);
    if (!session) {
      state.rewriteRates.delete(node.id);
      continue;
    }
    active.add(node.id);
    const checkedAt = Date.parse(node.runtime.lastChecked);
    const rewrittenBytes = Number(node.runtime.info?.runtimeTotals?.dataRewrittenBytes);
    if (!Number.isFinite(checkedAt) || !Number.isFinite(rewrittenBytes)) {
      state.rewriteRates.delete(node.id);
      continue;
    }

    const previous = state.rewriteRates.get(node.id);
    if (!previous || previous.session !== session || checkedAt < previous.checkedAt || rewrittenBytes < previous.rewrittenBytes) {
      resetRewriteRate(node.id, session, checkedAt, rewrittenBytes);
      continue;
    }
    if (checkedAt === previous.checkedAt) continue;

    const seconds = (checkedAt - previous.checkedAt) / 1000;
    const byteDelta = rewrittenBytes - previous.rewrittenBytes;
    if (seconds <= 0 || seconds > REWRITE_RATE_MAX_GAP_SECONDS || byteDelta < 0) {
      resetRewriteRate(node.id, session, checkedAt, rewrittenBytes);
      continue;
    }

    previous.samples.push({bytes: byteDelta, seconds});
    if (previous.samples.length > REWRITE_RATE_WINDOW) previous.samples.shift();
    const totals = previous.samples.reduce((sum, sample) => ({
      bytes: sum.bytes + sample.bytes,
      seconds: sum.seconds + sample.seconds,
    }), {bytes: 0, seconds: 0});
    previous.checkedAt = checkedAt;
    previous.rewrittenBytes = rewrittenBytes;
    previous.bytesPerSecond = totals.seconds > 0 ? totals.bytes / totals.seconds : null;
  }
  for (const nodeID of state.rewriteRates.keys()) {
    if (!active.has(nodeID)) state.rewriteRates.delete(nodeID);
  }
}

function rewriteRate(node) {
  return node ? state.rewriteRates.get(node.id) || null : null;
}

function updateReclaimedRounds(dashboard) {
  const active = new Set();
  for (const group of dashboard.groups || []) {
    const job = group.runningJob;
    if (!job) {
      state.reclaimedRounds.delete(group.id);
      continue;
    }
    const currentNode = (dashboard.nodes || []).find(node => node.id === job.currentNodeId) || null;
    const reclaimedBytes = jobCounterBytes(job, currentNode, 'reclaimedBytes', 'dataReclaimedBytes');
    if (!Number.isFinite(reclaimedBytes)) continue;

    active.add(group.id);
    const satelliteID = currentNode ? currentActivity(currentNode).satelliteID : '';
    const key = `${job.id}:${currentNode?.id || ''}:${satelliteID}`;
    const previous = state.reclaimedRounds.get(group.id);
    if (!previous || previous.key !== key || reclaimedBytes < previous.reclaimedBytes) {
      state.reclaimedRounds.set(group.id, {key, reclaimedBytes, lastBytes: null});
      continue;
    }

    const delta = reclaimedBytes - previous.reclaimedBytes;
    previous.reclaimedBytes = reclaimedBytes;
    if (delta > 0) previous.lastBytes = delta;
  }
  for (const groupID of state.reclaimedRounds.keys()) {
    if (!active.has(groupID)) state.reclaimedRounds.delete(groupID);
  }
}

function lastReclaimedRound(groupID) {
  const value = state.reclaimedRounds.get(groupID)?.lastBytes;
  return Number.isFinite(value) ? value : null;
}

function shortSatellite(value) {
  if (!value) return '';
  return value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

function satelliteLabel(value) {
  return SATELLITE_NAMES[value] || shortSatellite(value);
}

function groupFor(id) { return state.dashboard?.groups.find(group => group.id === id); }
function groupNodes(id) { return (state.dashboard?.nodes || []).filter(node => node.groupId === id); }

function aggregate(nodes, path) {
  return nodes.reduce((sum, node) => {
    if (!node.enabled || !node.runtime.online) return sum;
    let value = node.runtime.info;
    for (const part of path.split('.')) value = value?.[part];
    return sum + Number(value || 0);
  }, 0);
}

function pageSlice(items, requestedPage, pageSize) {
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(Math.max(1, requestedPage), pages);
  return {items: items.slice((page - 1) * pageSize, page * pageSize), page, pages};
}

function pagerHTML(scope, page, pages, count) {
  if (pages <= 1) return count ? `<span>${count} ${tr('записей', 'records')}</span>` : '';
  return `<span>${count} ${tr('записей', 'records')} · ${tr(`страница ${page} из ${pages}`, `page ${page} of ${pages}`)}</span><div><button class="button secondary small" data-page="${scope}" data-page-value="${page - 1}" ${page === 1 ? 'disabled' : ''}>${tr('Назад', 'Previous')}</button><button class="button secondary small" data-page="${scope}" data-page-value="${page + 1}" ${page === pages ? 'disabled' : ''}>${tr('Вперёд', 'Next')}</button></div>`;
}

function sortRows(items, table, valueFor) {
  const config = state.sort[table];
  const direction = config.direction === 'asc' ? 1 : -1;
  return items.map((item, index) => ({item, index})).sort((left, right) => {
    const a = valueFor(left.item, config.key);
    const b = valueFor(right.item, config.key);
    let compared;
    if (typeof a === 'number' && typeof b === 'number') compared = a - b;
    else compared = collator.compare(String(a ?? ''), String(b ?? ''));
    if (compared !== 0) return compared * direction;
    if (table === 'groups') {
      const byName = collator.compare(left.item.name, right.item.name);
      if (byName !== 0) return byName;
    }
    return left.index - right.index;
  }).map(entry => entry.item);
}

function jobCounterBytes(job, currentNode, resultField, runtimeField) {
  if (!job) return null;
  let total = job.nodes.reduce((sum, node) => sum + Number(node[resultField] || 0), 0);
  const run = job.nodes.find(node => node.nodeId === currentNode?.id && ['checking','running'].includes(node.state));
  const before = Number(run?.before?.[runtimeField]);
  const current = Number(currentNode?.runtime.info?.runtimeTotals?.[runtimeField]);
  if (Number.isFinite(before) && Number.isFinite(current) && current >= before) total += current - before;
  return total;
}

function groupContext(group) {
  const allNodes = groupNodes(group.id);
  const nodes = allNodes.filter(node => node.enabled);
  const job = group.runningJob;
  const compactingNode = nodes.find(node => node.runtime.info?.compacting);
  const manualNode = nodes.find(node => node.runtime.info?.manualJob?.state === 'running');
  const currentNode = allNodes.find(node => node.id === job?.currentNodeId) || compactingNode || manualNode || null;
  const activity = currentNode ? currentActivity(currentNode) : null;
  const manual = currentNode?.runtime.info?.manualJob;
  const progress = activity?.progress;
  const percent = progress?.totalRecords ? Math.min(100, progress.processedRecords / progress.totalRecords * 100) : 0;
  const done = job?.nodes.filter(node => !['queued','checking','running'].includes(node.state)).length || 0;
  const unavailable = nodes.filter(node => !node.runtime.online).length;
  const active = Boolean(job || compactingNode || manualNode);
  const ready = nodes.length > 0 && nodes.every(node => node.runtime.online && node.runtime.info?.manualLogCompactionEnabled && !node.runtime.info?.compacting && node.runtime.info?.manualJob?.state !== 'running');
  const history = (state.dashboard?.historyStats || []).find(item => item.groupId === group.id) || null;
  const currentRate = rewriteRate(currentNode);
  const lastRoundReclaimed = lastReclaimedRound(group.id);
  return {
    allNodes, nodes, job, currentNode, activity, manual, progress, percent, done, unavailable, active, ready,
    history,
    reclaimable: aggregate(nodes, 'reclaimableBytes'),
    reclaimed: jobCounterBytes(job, currentNode, 'reclaimedBytes', 'dataReclaimedBytes'),
    rewritten: jobCounterBytes(job, currentNode, 'rewrittenBytes', 'dataRewrittenBytes'),
    rewriteRate: currentRate?.bytesPerSecond ?? null,
    lastRoundReclaimed,
  };
}

function groupSortValue(group, key) {
  const context = groupContext(group);
  switch (key) {
    case 'activity': return context.active ? 3 : context.unavailable ? 1 : context.nodes.length ? 2 : 0;
    case 'node': return context.currentNode?.name || '';
    case 'satellite': return satelliteLabel(context.activity?.satelliteID || '');
    case 'progress': return context.progress ? context.percent : context.active ? 0 : -1;
    case 'queue': return context.job?.nodes.length ? context.done / context.job.nodes.length : context.manual?.totalSatellites ? context.manual.processedSatellites / context.manual.totalSatellites : -1;
    case 'reclaimable': return context.reclaimable;
    case 'reclaimed': return context.reclaimed ?? -1;
    case 'rewritten': return context.rewritten ?? -1;
    default: return group.name;
  }
}

function modeLabel(value) {
  return ({full:'Full', 'table-only':'Table-only', compaction:'Compaction'})[value] || value || 'Compaction';
}

function nodePositionLabel(node, nodes) {
  const position = nodes.findIndex(item => item.id === node?.id);
  return position >= 0 ? `${node.name} (${position + 1} ${tr('из', 'of')} ${nodes.length})` : node?.name || '';
}

function historyStatus(history) {
  if (!history?.runs) return '';
  const average = history.averageDurationSeconds > 0 ? `${tr('Среднее', 'Average')} ${duration(history.averageDurationSeconds)} · ` : '';
  const errors = history.errorCount > 0 ? ` · ${history.errorCount} ${plural(history.errorCount, 'ошибка', 'ошибки', 'ошибок', 'error', 'errors')}` : '';
  return `<small class="status-elapsed">${average}${history.runs} ${plural(history.runs, 'запуск', 'запуска', 'запусков', 'run', 'runs')}${errors}</small>`;
}

function groupOperationRow(group) {
  const context = groupContext(group);
  const {allNodes, nodes, job, currentNode, activity, manual, progress, percent, done, unavailable, active, ready, history, reclaimable, reclaimed, rewritten, rewriteRate, lastRoundReclaimed} = context;
  const statusClass = job ? job.state : active ? 'running' : unavailable ? 'failed' : '';
  const statusText = job ? `Full · ${stateLabel(job.state)}` : active ? modeLabel(activity?.mode) : unavailable ? `${unavailable} ${tr('недоступно', 'offline')}` : nodes.length ? tr('Свободен', 'Idle') : tr('Нет нод', 'No nodes');
  const statusStartedAt = job?.startedAt || (manual?.state === 'running' ? manual.startedAt : null);
  const statusElapsed = active && statusStartedAt
    ? `<small class="status-elapsed">${tr('Выполняется', 'Running for')} ${elapsed(statusStartedAt)}</small>`
    : historyStatus(history);
  const nodeCell = currentNode
    ? `<div class="node-title">${esc(nodePositionLabel(currentNode, nodes))}</div>${nodeAddress(currentNode.url)}`
    : `<span class="muted">${nodes.length} ${plural(nodes.length, 'нода', 'ноды', 'нод', 'node', 'nodes')}</span>`;
  const satelliteCell = activity?.satelliteID
    ? `<span class="satellite operation-satellite" title="${esc(activity.satelliteID)}">${esc(satelliteLabel(activity.satelliteID))}</span>`
    : '<span class="muted">—</span>';
  let progressCell = '<span class="muted">—</span>';
  if (progress) {
    progressCell = `<div class="progress-wrap operation-progress"><div class="progress-head"><strong>${percent.toFixed(1)}%</strong><span>ETA ${duration(progress.remainingSeconds)}</span></div><progress class="progress" value="${percent}" max="100" aria-label="${tr('Выполнено', 'Completed')} ${percent.toFixed(1)}%"></progress></div>`;
  } else if (active) {
    progressCell = `<span class="muted">${tr('Между раундами', 'Between rounds')}</span>`;
  }
  const satelliteQueue = manual?.totalSatellites
    ? `<small>${manual.processedSatellites} ${tr('из', 'of')} ${manual.totalSatellites} ${tr('спутников', 'satellites')}</small>`
    : `<small>${tr('ожидание данных ноды', 'waiting for node data')}</small>`;
  const queueCell = job
    ? `<div class="metric"><strong>${done} ${tr('из', 'of')} ${job.nodes.length} ${tr('нод', 'nodes')}</strong>${satelliteQueue}</div>`
    : manual?.state === 'running'
      ? `<div class="metric"><strong>${manual.processedSatellites} ${tr('из', 'of')} ${manual.totalSatellites}</strong><small>${tr('спутников', 'satellites')}</small></div>`
      : active ? `<span class="muted">${tr('Вне очереди', 'Outside queue')}</span>` : '<span class="muted">—</span>';
  const lastReclaimedLine = `<small title="${tr('Прирост первой строки с предыдущего опроса для текущего спутника', 'Increase in the first line since the previous poll for the current satellite')}">${tr('посл', 'last')}: ${lastRoundReclaimed === null ? '—' : bytes(lastRoundReclaimed)}</small>`;
  const reclaimedCell = job
    ? `<div class="metric"><strong>${bytes(reclaimed)}</strong>${lastReclaimedLine}</div>`
    : active
      ? `<span class="muted" title="${tr('Orchestrator не снимал baseline перед этим запуском', 'Orchestrator did not capture a baseline before this run')}">${tr('Нет baseline', 'No baseline')}</span>`
      : '<span class="muted">—</span>';
  const rateLine = Number.isFinite(rewriteRate)
    ? `<small title="${tr(`Средняя скорость по ${REWRITE_RATE_WINDOW} последним интервалам опроса`, `Average speed over the last ${REWRITE_RATE_WINDOW} polling intervals`)}">${rate(rewriteRate)}</small>`
    : `<small>${tr('текущая очередь', 'current queue')}</small>`;
  const rewrittenCell = job
    ? `<div class="metric"><strong>${bytes(rewritten)}</strong>${rateLine}</div>`
    : active
      ? `<div class="metric"><strong class="muted" title="${tr('Orchestrator не снимал baseline перед этим запуском', 'Orchestrator did not capture a baseline before this run')}">${tr('Нет baseline', 'No baseline')}</strong>${Number.isFinite(rewriteRate) ? rateLine : ''}</div>`
      : '<span class="muted">—</span>';
  const action = job
    ? `<button class="button secondary small" data-stop-group="${esc(group.id)}">${tr('Остановить', 'Stop')}</button>`
    : active
      ? `<button class="button secondary small" disabled>${tr('Занят', 'Busy')}</button>`
      : `<button class="button primary small" data-start-group="${esc(group.id)}" ${ready ? '' : 'disabled'}>${tr('Запустить', 'Start')}</button>`;
  return `<tr class="${active ? 'active-operation' : ''}">
    <td><div class="operation-disk"><span class="drive-icon">HDD</span><div><strong>${esc(group.name)}</strong><small>${allNodes.length} ${plural(allNodes.length, 'нода', 'ноды', 'нод', 'node', 'nodes')}</small></div></div></td>
    <td><div class="status-stack"><span class="status ${esc(statusClass)}">${esc(statusText)}</span>${statusElapsed}</div></td>
    <td>${nodeCell}</td><td>${satelliteCell}</td><td>${progressCell}</td><td>${queueCell}</td>
    <td class="metric"><strong>${bytes(reclaimable)}</strong></td><td>${reclaimedCell}</td><td>${rewrittenCell}</td>
    <td><div class="operation-actions">${action}<button class="button ghost small" data-show-dashboard-group="${esc(group.id)}">${tr('Ноды', 'Nodes')}</button></div></td>
  </tr>`;
}

function nodeSortValue(node, key) {
  const info = node.runtime.info;
  const progress = currentActivity(node).progress;
  const queueRun = groupFor(node.groupId)?.runningJob?.nodes.find(run => run.nodeId === node.id);
  switch (key) {
    case 'group': return groupFor(node.groupId)?.name || '';
    case 'status': return !node.enabled ? '0-disabled' : node.runtime.online ? '2-online' : '1-offline';
    case 'work': {
      if (queueRun) {
        const rank = {running:5, checking:4, queued:3, succeeded:2, failed:1, canceled:1, skipped:0};
        return (rank[queueRun.state] ?? 0) + (queueRun.state === 'running' && progress?.totalRecords ? progress.processedRecords / progress.totalRecords : 0);
      }
      return progress?.totalRecords ? 5 + progress.processedRecords / progress.totalRecords : info?.manualJob?.state === 'running' ? 5 : -1;
    }
    case 'reclaimable': return Number(info?.reclaimableBytes || 0);
    case 'reclaimed': return Number(info?.runtimeTotals?.dataReclaimedBytes || 0);
    case 'rewritten': return Number(info?.runtimeTotals?.dataRewrittenBytes || 0);
    case 'rate': return rewriteRate(node)?.bytesPerSecond ?? -1;
    default: return node.name;
  }
}

function renderSortIndicators() {
  $$('[data-sort-table]').forEach(button => {
    const config = state.sort[button.dataset.sortTable];
    const active = config.key === button.dataset.sortKey;
    button.classList.toggle('active', active);
    $('span', button).textContent = active ? config.direction === 'asc' ? '↑' : '↓' : '↕';
    button.closest('th')?.setAttribute('aria-sort', active ? config.direction === 'asc' ? 'ascending' : 'descending' : 'none');
  });
}

function renderDashboard() {
  const data = state.dashboard;
  if (!data) return;
  const configured = data.groups.length > 0;
  $('#empty-state').classList.toggle('hidden', configured);
  $('#dashboard-content').classList.toggle('hidden', !configured);
  if (!configured) return applyLanguage();

  const enabled = data.nodes.filter(node => node.enabled);
  const online = enabled.filter(node => node.runtime.online).length;
  const running = enabled.filter(node => node.runtime.info?.manualJob?.state === 'running').length;
  const reclaimable = aggregate(data.nodes, 'reclaimableBytes');
  const lost = aggregate(data.nodes, 'salvage.lostPieces');
  $('#summary').innerHTML = [
    [tr('Ноды в сети', 'Nodes online'), `${online} / ${enabled.length}`, tr('Среди включённых в настройках', 'Among enabled nodes'), 'ON'],
    ['Full compaction', String(running), running ? tr('Тяжёлые операции сейчас', 'Heavy operations in progress') : tr('Сейчас диски свободны', 'Disks are idle'), 'RUN'],
    [tr('К очистке', 'To clean'), bytes(reclaimable), tr('По данным всех доступных нод', 'Reported by all reachable nodes'), 'FREE'],
    [tr('Salvage: потеряно', 'Salvage: lost'), String(lost), tr('Pieces с момента запуска нод', 'Pieces since node startup'), 'SLV'],
  ].map(([label,value,hint,icon]) => `<article class="summary-card"><div class="label"><span>${label}</span><span class="summary-icon">${icon}</span></div><div class="value">${value}</div><div class="hint">${hint}</div></article>`).join('');

  const groupQuery = state.filter.groups.toLowerCase();
  const matchingGroups = data.groups.filter(group => {
    if (state.filter.groupsActiveOnly && !groupContext(group).active) return false;
    return `${group.name} ${groupNodes(group.id).map(node => `${node.name} ${node.url}`).join(' ')}`.toLowerCase().includes(groupQuery);
  });
  const sortedGroups = sortRows(matchingGroups, 'groups', groupSortValue);
  const groupPage = pageSlice(sortedGroups, state.filter.groupPage, GROUP_PAGE_SIZE);
  state.filter.groupPage = groupPage.page;
  $('#group-search').value = state.filter.groups;
  $('#active-groups-only').checked = state.filter.groupsActiveOnly;
  $$('[data-group-view]').forEach(button => button.classList.toggle('active', button.dataset.groupView === state.groupView));
  $('#groups-table-card').classList.toggle('hidden', state.groupView !== 'table');
  $('#groups').classList.toggle('hidden', state.groupView !== 'cards');
  $('#groups-pager').classList.toggle('hidden', state.groupView !== 'cards');
  $('#groups-table').innerHTML = sortedGroups.length ? sortedGroups.map(groupOperationRow).join('') : `<tr><td colspan="10" class="empty-row">${tr('Диски не найдены', 'No disks found')}</td></tr>`;
  $('#groups').innerHTML = groupPage.items.length ? groupPage.items.map(groupCard).join('') : `<div class="empty-row panel">${tr('Диски не найдены', 'No disks found')}</div>`;
  $('#groups-pager').innerHTML = pagerHTML('groups', groupPage.page, groupPage.pages, matchingGroups.length);

  const currentFilter = state.filter.nodeGroup;
  $('#node-group-filter').innerHTML = `<option value="">${tr('Все диски', 'All disks')}</option>` + data.groups.map(group => `<option value="${esc(group.id)}">${esc(group.name)}</option>`).join('');
  $('#node-group-filter').value = currentFilter;
  $('#node-search').value = state.filter.nodes;
  const nodeQuery = state.filter.nodes.toLowerCase();
  const matchingNodes = data.nodes.filter(node => (!currentFilter || node.groupId === currentFilter) && `${node.name} ${node.url}`.toLowerCase().includes(nodeQuery));
  const sortedNodes = sortRows(matchingNodes, 'nodes', nodeSortValue);
  const nodePage = pageSlice(sortedNodes, state.filter.nodePage, PAGE_SIZE);
  state.filter.nodePage = nodePage.page;
  $('#nodes-table').innerHTML = nodePage.items.length ? nodePage.items.map(nodeRow).join('') : `<tr><td colspan="9" class="empty-row">${tr('Ноды не найдены', 'No nodes found')}</td></tr>`;
  $('#nodes-pager').innerHTML = pagerHTML('nodes', nodePage.page, nodePage.pages, matchingNodes.length);
  const history = state.history || {jobs: [], total: 0};
  const historyPages = Math.max(1, Math.ceil(history.total / PAGE_SIZE));
  state.filter.historyPage = Math.min(Math.max(1, state.filter.historyPage), historyPages);
  $('#history-table').innerHTML = history.jobs.length ? history.jobs.map(historyRow).join('') : `<tr><td colspan="8" class="empty-row">${tr('Запусков пока не было', 'No runs yet')}</td></tr>`;
  $('#history-pager').innerHTML = pagerHTML('history', state.filter.historyPage, historyPages, history.total);
  renderSortIndicators();
  applyLanguage();
}

function groupCard(group) {
  const context = groupContext(group);
  const {allNodes, nodes, job, done, unavailable, ready, history, progress, percent, reclaimable, reclaimed, rewritten, rewriteRate} = context;
  const externalNode = !job ? context.currentNode : null;
  const current = job?.nodes.findIndex(node => ['checking','running'].includes(node.state)) ?? nodes.findIndex(node => node.id === externalNode?.id);
  const queue = nodes.map((_, index) => `<span class="queue-step ${index < done ? 'done' : index === current ? 'current' : ''}"></span>`).join('');
  const currentNode = nodes.find(node => node.id === job?.currentNodeId) || externalNode;
  const activity = currentNode ? currentActivity(currentNode) : null;
  const manual = currentNode?.runtime.info?.manualJob;
  const satellite = activity?.satelliteID ? `<small class="satellite" title="${esc(activity.satelliteID)}">${esc(satelliteLabel(activity.satelliteID))}</small>` : '';
  const satelliteCount = manual?.totalSatellites ? `<small class="satellite-count">${manual.processedSatellites} ${tr('из', 'of')} ${manual.totalSatellites} ${tr('спутников', 'satellites')}</small>` : '';
  const statusClass = job ? job.state : externalNode ? 'running' : unavailable ? 'failed' : '';
  const statusText = job ? stateLabel(job.state) : externalNode ? modeLabel(currentActivity(externalNode).mode) : unavailable ? `${unavailable} ${tr('недоступно', 'offline')}` : tr('Свободен', 'Idle');
  const statusStartedAt = job?.startedAt || (manual?.state === 'running' ? manual.startedAt : null);
  const statusElapsed = (job || externalNode) && statusStartedAt
    ? `<small class="status-elapsed">${tr('Выполняется', 'Running for')} ${elapsed(statusStartedAt)}</small>`
    : historyStatus(history);
  const expanded = state.expandedGroups.has(group.id);
  const progressText = progress ? `${percent.toFixed(1)}% · ETA ${duration(progress.remainingSeconds)}` : job || externalNode ? tr('Между раундами', 'Between rounds') : '—';
  const progressBar = progress ? `<progress class="progress" value="${percent}" max="100" aria-label="${tr('Выполнено', 'Completed')} ${percent.toFixed(1)}%"></progress>` : '';
  const reclaimedText = job ? bytes(reclaimed) : externalNode ? tr('Нет baseline', 'No baseline') : '—';
  const rewrittenText = job ? bytes(rewritten) : externalNode ? tr('Нет baseline', 'No baseline') : '—';
  const speedText = Number.isFinite(rewriteRate) ? rate(rewriteRate) : '';
  const speedLine = job || externalNode ? `<small class="card-progress-speed">${speedText || '—'}</small>` : '';
  let queuePosition = 0;
  const contents = expanded ? `<div class="group-node-list">${allNodes.map(node => {
    if (node.enabled) queuePosition++;
    return `<div class="group-node-item"><span class="queue-number">${node.enabled ? queuePosition : '—'}</span><div><strong>${esc(node.name)}</strong>${nodeAddress(node.url, 'group-node-url')}</div><span class="status ${node.enabled && node.runtime.online ? 'online' : node.enabled ? 'offline' : ''}">${node.enabled ? node.runtime.online ? tr('В сети', 'Online') : tr('Нет связи', 'Offline') : tr('Отключена', 'Disabled')}</span></div>`;
  }).join('') || `<div class="empty-row">${tr('На диске нет нод', 'No nodes on this disk')}</div>`}</div>` : '';
  return `<article class="group-card ${job || externalNode ? 'running' : ''}">
    <div class="group-head"><div class="group-name"><span class="drive-icon">HDD</span><div><strong>${esc(group.name)}</strong><small>${allNodes.length} ${plural(allNodes.length, 'нода', 'ноды', 'нод', 'node', 'nodes')} · ${nodes.length} ${tr('включено', 'enabled')}</small></div></div><div class="status-stack card-status"><span class="status ${esc(statusClass)}">${statusText}</span>${statusElapsed}</div></div>
    <div class="card-current"><div class="card-current-node"><span>${tr('Текущая нода', 'Current node')}</span><strong>${currentNode ? esc(nodePositionLabel(currentNode, nodes)) : tr('Нет работы', 'No work')}</strong>${satellite}${satelliteCount}</div><div class="card-progress"><span>${tr('Прогресс', 'Progress')}</span><strong>${progressText}</strong>${progressBar}${speedLine}</div></div>
    <div class="group-card-metrics"><div class="mini-stat"><span>${tr('К очистке', 'To clean')}</span><strong>${bytes(reclaimable)}</strong></div><div class="mini-stat"><span>${tr('Очищено', 'Cleaned')}</span><strong>${reclaimedText}</strong></div><div class="mini-stat"><span>${tr('Переписано', 'Rewritten')}</span><strong>${rewrittenText}</strong></div></div>
    <div class="queue">${queue || `<span class="muted">${tr('Нет включённых нод', 'No enabled nodes')}</span>`}<span class="queue-label">${job ? `${done}/${job.nodes.length}` : ''}</span></div>
    <div class="group-tools"><button class="button ghost small" data-expand-group="${esc(group.id)}">${expanded ? tr('Скрыть состав', 'Hide nodes') : `${tr('Состав', 'Nodes')} (${allNodes.length})`}</button><button class="button ghost small" data-show-dashboard-group="${esc(group.id)}">${tr('В таблицу', 'Show in table')}</button></div>
    ${contents}
    <div class="group-actions">${job ? `<button class="button secondary" data-stop-group="${esc(group.id)}">${tr('Остановить после текущей', 'Stop after current')}</button>` : externalNode ? `<button class="button secondary" disabled>${tr('Full compaction уже выполняется', 'Full compaction is already running')}</button>` : `<button class="button primary" data-start-group="${esc(group.id)}" ${ready ? '' : 'disabled'}>${tr('Запустить очередь', 'Start queue')}</button>`}</div>
  </article>`;
}

function nodeRow(node) {
  const info = node.runtime.info;
  const group = groupFor(node.groupId);
  const queueRun = group?.runningJob?.nodes.find(run => run.nodeId === node.id);
  const activity = currentActivity(node);
  const progress = activity.progress;
  const percent = progress?.totalRecords ? Math.min(100, progress.processedRecords / progress.totalRecords * 100) : 0;
  const manual = info?.manualJob;
  let work = `<span class="muted">${tr('Ожидание', 'Waiting')}</span>`;
  if (queueRun && ['checking','running'].includes(queueRun.state) && progress) {
    const satellite = activity.satelliteID ? `<span class="satellite" title="${esc(activity.satelliteID)}">${esc(satelliteLabel(activity.satelliteID))}</span>` : '';
    const satelliteCount = manual?.totalSatellites ? `<small class="satellite-count">${manual.processedSatellites} ${tr('из', 'of')} ${manual.totalSatellites} ${tr('спутников', 'satellites')}</small>` : '';
    work = `<div class="progress-wrap"><div class="progress-head"><span>${esc(activity.mode)}</span><span>${percent.toFixed(1)}% · ETA ${duration(progress.remainingSeconds)}</span></div>${satellite}${satelliteCount}<progress class="progress" value="${percent}" max="100" aria-label="${tr('Выполнено', 'Completed')} ${percent.toFixed(1)}%"></progress></div>`;
  } else if (queueRun) {
    const satellite = ['checking','running'].includes(queueRun.state) && activity.satelliteID ? `<small class="satellite" title="${esc(activity.satelliteID)}">${esc(satelliteLabel(activity.satelliteID))}</small>` : '';
    const satelliteCount = queueRun.state === 'running' && manual?.totalSatellites ? `<small class="satellite-count">${manual.processedSatellites} ${tr('из', 'of')} ${manual.totalSatellites} ${tr('спутников', 'satellites')}</small>` : '';
    work = `<span class="state-pill ${esc(queueRun.state)}">${stateLabel(queueRun.state)}</span>${satellite}${satelliteCount}`;
  } else if (progress) {
    const satellite = activity.satelliteID ? `<span class="satellite" title="${esc(activity.satelliteID)}">${esc(satelliteLabel(activity.satelliteID))}</span>` : '';
    const satelliteCount = manual?.totalSatellites ? `<small class="satellite-count">${manual.processedSatellites} ${tr('из', 'of')} ${manual.totalSatellites} ${tr('спутников', 'satellites')}</small>` : '';
    work = `<div class="progress-wrap"><div class="progress-head"><span>${esc(activity.mode)}</span><span>${percent.toFixed(1)}% · ETA ${duration(progress.remainingSeconds)}</span></div>${satellite}${satelliteCount}<progress class="progress" value="${percent}" max="100" aria-label="${tr('Выполнено', 'Completed')} ${percent.toFixed(1)}%"></progress></div>`;
  } else if (manual?.state === 'running') {
    const satellite = activity.satelliteID ? `<small class="satellite" title="${esc(activity.satelliteID)}">${esc(satelliteLabel(activity.satelliteID))}</small>` : '';
    const satelliteCount = manual.totalSatellites ? `<small class="satellite-count">${manual.processedSatellites} ${tr('из', 'of')} ${manual.totalSatellites} ${tr('спутников', 'satellites')}</small>` : '';
    work = `<span class="state-pill running">${stateLabel(manual.state)}</span>${satellite}${satelliteCount}`;
  }
  const status = !node.enabled ? `<span class="status">${tr('Отключена', 'Disabled')}</span>` : node.runtime.online ? `<span class="status online">${tr('В сети', 'Online')}</span>` : `<span class="status offline" title="${esc(node.runtime.error)}">${tr('Нет связи', 'Offline')}</span>`;
  const peers = groupNodes(node.groupId).filter(item => item.enabled);
  const groupSafe = peers.every(item => item.runtime.online && item.runtime.info?.manualJob?.state !== 'running');
  const disabled = !node.enabled || group?.runningJob || !groupSafe || manual?.state === 'running' || !node.runtime.online || !info?.manualLogCompactionEnabled;
  const currentRate = rewriteRate(node);
  const rateCell = Number.isFinite(currentRate?.bytesPerSecond)
    ? `<td class="metric"><strong>${rate(currentRate.bytesPerSecond)}</strong><small>${currentRate.samples.length} ${tr('из', 'of')} ${REWRITE_RATE_WINDOW} ${tr('замеров', 'samples')}</small></td>`
    : '<td class="metric"><strong>—</strong></td>';
  const failures = info?.runtimeTotals?.failedAttempts || 0;
  const logs = info?.runtimeTotals?.logsRewritten || 0;
  return `<tr><td><div class="node-title">${esc(node.name)}</div>${nodeAddress(node.url)}</td><td>${esc(group?.name || '—')}</td><td>${status}</td><td>${work}</td><td class="metric"><strong>${bytes(info?.reclaimableBytes)}</strong><small>${info ? info.manualLogCompactionEnabled ? 'manual mode' : tr('manual mode выключен', 'manual mode disabled') : tr('нет данных', 'no data')}</small></td><td class="metric"><strong>${bytes(info?.runtimeTotals?.dataReclaimedBytes)}</strong><small>${failures} ${plural(failures, 'ошибка', 'ошибки', 'ошибок', 'error', 'errors')}</small></td><td class="metric"><strong>${bytes(info?.runtimeTotals?.dataRewrittenBytes)}</strong><small>${logs} ${plural(logs, 'лог', 'лога', 'логов', 'log', 'logs')}</small></td>${rateCell}<td><button class="button secondary small" data-start-node="${esc(node.id)}" ${disabled ? 'disabled' : ''}>${tr('Запустить', 'Start')}</button></td></tr>`;
}

function historyRow(job) {
  const reclaimed = job.nodes.reduce((sum, node) => sum + Number(node.reclaimedBytes || 0), 0);
  const rewritten = job.nodes.reduce((sum, node) => sum + Number(node.rewrittenBytes || 0), 0);
  const done = job.nodes.filter(node => ['succeeded','failed','canceled'].includes(node.state)).length;
  const trigger = job.trigger?.startsWith('schedule') ? tr('Расписание', 'Schedule') : tr('Вручную', 'Manual');
  const errors = job.nodes.filter(node => node.state === 'failed' && node.error);
  const expanded = state.expandedJobs.has(job.id);
  const errorSummary = errors.length ? `<small class="history-error" title="${esc(errors.map(node => `${node.nodeName}: ${node.error}`).join('\n'))}">${errors.length} ${plural(errors.length, 'ошибка', 'ошибки', 'ошибок', 'error', 'errors')}</small>` : '';
  const details = expanded ? `<tr class="history-detail-row"><td colspan="8"><div class="history-node-list">${job.nodes.map((node, index) => `<div class="history-node"><span class="queue-number">${index + 1}</span><div><strong>${esc(node.nodeName)}</strong><small>${elapsed(node.startedAt, node.finishedAt)} · reclaimed ${bytes(node.reclaimedBytes)} · rewritten ${bytes(node.rewrittenBytes)}</small>${node.error ? `<em>${esc(node.error)}</em>` : ''}</div><span class="state-pill ${esc(node.state)}">${stateLabel(node.state)}</span></div>`).join('')}</div></td></tr>` : '';
  return `<tr><td class="metric"><strong>${time(job.startedAt)}</strong><small>${esc(job.id.slice(0, 8))}</small></td><td>${trigger}</td><td>${esc(job.groupName)}</td><td><span class="state-pill ${esc(job.state)}">${stateLabel(job.state)}</span>${errorSummary}</td><td>${done} / ${job.nodes.length}</td><td>${bytes(reclaimed)}</td><td>${bytes(rewritten)}</td><td class="metric"><strong>${elapsed(job.startedAt, job.finishedAt)}</strong><button class="button ghost history-details-button" data-expand-job="${esc(job.id)}">${expanded ? tr('Скрыть', 'Hide') : tr('Детали', 'Details')}</button></td></tr>${details}`;
}

function plural(n, one, few, many, enOne = one, enMany = many) {
  if (state.language === 'en') return Number(n) === 1 ? enOne : enMany;
  const m = n % 100;
  const d = n % 10;
  return m >= 11 && m <= 19 ? many : d === 1 ? one : d >= 2 && d <= 4 ? few : many;
}
function stateLabel(value) {
  const ru = {idle:'Ожидание',running:'Выполняется',checking:'Проверка',stopping:'Завершается',stopped:'Остановлено',succeeded:'Успешно',failed:'Ошибка',canceled:'Отменено',interrupted:'Прервано',queued:'В очереди',skipped:'Пропущено'};
  const en = {idle:'Waiting',running:'Running',checking:'Checking',stopping:'Stopping',stopped:'Stopped',succeeded:'Succeeded',failed:'Failed',canceled:'Canceled',interrupted:'Interrupted',queued:'Queued',skipped:'Skipped'};
  return (state.language === 'en' ? en : ru)[value] || value || '—';
}

async function loadDashboard(silent = false) {
  try {
    const historySort = state.sort.history;
    const historyQuery = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String((state.filter.historyPage - 1) * PAGE_SIZE),
      sort: historySort.key,
      direction: historySort.direction,
    });
    const [dashboard, history] = await Promise.all([
      request('/api/dashboard'),
      request(`/api/history?${historyQuery}`),
    ]);
    updateRewriteRates(dashboard.nodes);
    updateReclaimedRounds(dashboard);
    state.dashboard = dashboard;
    state.history = history;
    renderDashboard();
    if (state.view === 'schedule' && state.settings) {
      renderScheduleTimeline();
      refreshScheduleStatuses();
    }
    $('.pulse').classList.remove('error');
    $('#poll-status').textContent = `${tr('Обновлено', 'Updated')} ${new Date().toLocaleTimeString(state.language === 'en' ? 'en-GB' : 'ru-RU', {hour:'2-digit',minute:'2-digit',second:'2-digit'})}`;
  } catch (error) {
    $('.pulse').classList.add('error');
    $('#poll-status').textContent = tr('Нет связи с orchestrator', 'Orchestrator is unreachable');
    if (!silent) toast(error.message, true);
  }
}

async function loadSettings() {
  try {
    state.settings = await request('/api/settings');
    state.dirtySchedules.clear();
    renderSettings();
    renderSchedules();
  } catch (error) { toast(error.message, true); }
}

function groupOptions(selectedID) {
  return [...state.settings.groups].sort((a, b) => collator.compare(a.name, b.name)).map(group => `<option value="${esc(group.id)}" ${group.id === selectedID ? 'selected' : ''}>${esc(group.name)}</option>`).join('');
}

function settingsNodeSortValue(node, key) {
  switch (key) {
    case 'url': return node.url;
    case 'group': return state.settings?.groups.find(group => group.id === node.groupId)?.name || '';
    case 'enabled': return node.enabled ? 1 : 0;
    default: return node.name;
  }
}

function nodeEditor(node, inline = false) {
  return `<div class="node-edit ${inline ? 'inline-node-edit' : ''}" data-node-row="${esc(node.id)}">
    <label><span>${tr('Название', 'Name')}</span><input data-field="name" value="${esc(node.name)}" placeholder="node-01"></label>
    <label class="wide"><span>${tr('Адрес dashboard', 'Dashboard address')}</span><input data-field="url" value="${esc(node.url)}" placeholder="http://192.168.1.20:14005"></label>
    <label><span>${tr('Физический диск', 'Physical disk')}</span><select data-field="groupId">${groupOptions(node.groupId)}</select></label>
    <label class="wide"><span>Multinode API key</span><input data-field="apiKey" value="${esc(node.apiKey || '')}" type="password" autocomplete="new-password" placeholder="${node.apiKeyConfigured ? tr('Ключ сохранён · оставьте пустым', 'Key saved · leave blank') : tr('Вставьте ключ', 'Paste key')}"></label>
    <label class="check-field"><span>${tr('Включена', 'Enabled')}</span><input data-field="enabled" type="checkbox" ${node.enabled ? 'checked' : ''}></label>
    <div class="edit-actions"><button class="button secondary small" data-test-node="${esc(node.id)}">${tr('Проверить адрес', 'Test address')}</button>${inline ? `<button class="button ghost" data-close-node-editor="${esc(node.id)}">${tr('Свернуть', 'Collapse')}</button>` : ''}<button class="button ghost" data-delete-node="${esc(node.id)}">${tr('Удалить', 'Delete')}</button></div>
  </div>`;
}

function renderDiskDetail(group) {
  if (!group) return `<div class="disk-detail-empty"><strong>${tr('Выберите диск', 'Select a disk')}</strong><span>${tr('Справа появится его состав и управление привязками.', 'Its nodes and assignment controls will appear on the right.')}</span></div>`;
  const nodes = state.settings.nodes.filter(node => node.groupId === group.id).sort((a, b) => collator.compare(a.name, b.name));
  const rows = nodes.map((node, index) => `<div class="disk-node-block">
    <div class="disk-node-row">
      <span class="queue-number" title="${tr('Позиция в очереди', 'Queue position')}">${index + 1}</span>
      <div class="disk-node-identity"><strong>${esc(node.name || tr('Новая нода', 'New node'))}</strong>${node.url ? nodeAddress(node.url, 'disk-node-url') : `<span class="disk-node-url">${tr('Адрес ещё не указан', 'Address is not set yet')}</span>`}</div>
      <span class="state-pill ${node.enabled ? 'succeeded' : ''}">${node.enabled ? tr('Включена', 'Enabled') : tr('Отключена', 'Disabled')}</span>
      <label class="move-field"><span>${tr('Переместить на диск', 'Move to disk')}</span><select data-move-node="${esc(node.id)}">${groupOptions(node.groupId)}</select></label>
      <button class="button secondary small" data-edit-node="${esc(node.id)}">${state.editingNodeID === node.id ? tr('Редактируется', 'Editing') : tr('Редактировать', 'Edit')}</button>
    </div>
    ${state.editingNodeID === node.id ? nodeEditor(node, true) : ''}
  </div>`).join('');
  return `<div class="disk-detail-head" data-group-row="${esc(group.id)}"><div><label><span>${tr('Название диска', 'Disk name')}</span><input data-field="name" value="${esc(group.name)}"></label><p>${nodes.length} ${plural(nodes.length, 'нода', 'ноды', 'нод', 'node', 'nodes')} · ${tr('сортировка по имени задаёт порядок очереди после сохранения', 'name order becomes queue order after saving')}</p></div><button class="button primary small" data-add-node-to-group="${esc(group.id)}">${tr('+ Добавить ноду', '+ Add node')}</button></div>
    <div class="disk-node-list">${rows || `<div class="disk-detail-empty"><strong>${tr('На диске пока нет нод', 'There are no nodes on this disk yet')}</strong><span>${tr('Добавьте новую или перенесите существующую.', 'Add a new node or move an existing one.')}</span></div>`}</div>
    <p class="disk-detail-hint">${tr('Ноды всегда показаны по имени. Изменения применятся после сохранения настроек.', 'Nodes are always shown by name. Changes take effect after saving settings.')}</p>`;
}

function renderSettings() {
  const settings = state.settings;
  if (!settings) return;
  $('#poll-interval').value = settings.pollIntervalSeconds;
  $('#ui-language').value = state.language;
  const groupsByName = [...settings.groups].sort((a, b) => collator.compare(a.name, b.name));
  if (!settings.groups.some(group => group.id === state.selectedSettingsGroup)) state.selectedSettingsGroup = groupsByName[0]?.id || '';

  $('#settings-group-search').value = state.filter.settingsGroups;
  const groupQuery = state.filter.settingsGroups.toLowerCase();
  const matchingGroups = settings.groups.filter(group => group.name.toLowerCase().includes(groupQuery)).sort((a, b) => collator.compare(a.name, b.name));
  $('#settings-groups').innerHTML = matchingGroups.length ? matchingGroups.map(group => {
    const count = settings.nodes.filter(node => node.groupId === group.id).length;
    return `<div class="disk-selector ${group.id === state.selectedSettingsGroup ? 'selected' : ''}"><button data-select-settings-group="${esc(group.id)}"><span class="drive-icon">HDD</span><span><strong>${esc(group.name)}</strong><small>${count} ${plural(count, 'нода', 'ноды', 'нод', 'node', 'nodes')}</small></span></button><button class="button ghost" data-delete-group="${esc(group.id)}" title="${tr('Удалить диск', 'Delete disk')}">×</button></div>`;
  }).join('') : `<div class="empty-row">${tr('Диски не найдены', 'No disks found')}</div>`;
  $('#settings-disk-detail').innerHTML = renderDiskDetail(settings.groups.find(group => group.id === state.selectedSettingsGroup));

  const sortedGroups = groupsByName;
  $('#settings-node-group-filter').innerHTML = `<option value="">${tr('Все диски', 'All disks')}</option>` + sortedGroups.map(group => `<option value="${esc(group.id)}">${esc(group.name)}</option>`).join('');
  $('#settings-node-group-filter').value = state.filter.settingsNodeGroup;
  $('#settings-node-search').value = state.filter.settingsNodes;
  const nodeQuery = state.filter.settingsNodes.toLowerCase();
  const matchingNodes = settings.nodes.filter(node => (!state.filter.settingsNodeGroup || node.groupId === state.filter.settingsNodeGroup) && `${node.name} ${node.url}`.toLowerCase().includes(nodeQuery));
  const sortedNodes = sortRows(matchingNodes, 'settingsNodes', settingsNodeSortValue);
  $('#settings-nodes').innerHTML = sortedNodes.length ? sortedNodes.map(node => nodeEditor(node)).join('') : `<div class="empty-row">${tr('Ноды не найдены', 'No nodes found')}</div>`;
  renderSortIndicators();
  applyLanguage();
}

const weekDays = [
  {day:1, ru:'Пн', en:'Mon'}, {day:2, ru:'Вт', en:'Tue'}, {day:3, ru:'Ср', en:'Wed'},
  {day:4, ru:'Чт', en:'Thu'}, {day:5, ru:'Пт', en:'Fri'}, {day:6, ru:'Сб', en:'Sat'}, {day:0, ru:'Вс', en:'Sun'},
];

function renderSchedules() {
  const settings = state.settings;
  if (!settings) return;
  $('#schedule-timezone').value = settings.timezone || 'UTC';
  renderScheduleTimeline();
  const rule = settings.schedules?.find(item => item.id === state.editingScheduleID);
  $('#schedule-list').innerHTML = rule ? scheduleEditorCard(rule) : `<div class="empty-state schedule-empty"><h2>${tr('Правило не выбрано', 'No rule selected')}</h2><p>${tr('Нажмите название расписания в обзоре или создайте новое правило.', 'Click a schedule name in the overview or create a new rule.')}</p></div>`;
  if (!rule) return applyLanguage();
  const type = $(`[data-schedule-row="${CSS.escape(rule.id)}"] [data-field="targetType"]`);
  const target = $(`[data-schedule-row="${CSS.escape(rule.id)}"] [data-field="targetId"]`);
  if (type) type.value = rule.targetType;
  if (target) target.value = rule.targetId;
  applyLanguage();
}

function renderScheduleTimeline() {
  const container = $('#schedule-timeline');
  if (!container || !state.settings) return;
  const previousScroll = $('.schedule-timeline-scroll', container);
  const scrollLeft = previousScroll?.scrollLeft || 0;
  const scrollTop = previousScroll?.scrollTop || 0;
  const days = scheduleCalendarDays();
  const dayKeys = new Set(days.map(day => day.key));
  const rows = new Map();
  const parked = [];
  for (const rule of state.settings.schedules || []) {
    const status = scheduleStatus(rule);
    const occurrences = Array.isArray(status.nextRuns) ? status.nextRuns : status.nextRun ? [status.nextRun] : [];
    if (!rule.enabled || state.dirtySchedules.has(rule.id) || !occurrences.length) {
      parked.push(rule);
      continue;
    }
    let displayed = false;
    for (const occurrence of occurrences) {
      const when = scheduleLocalParts(occurrence);
      if (!dayKeys.has(when.date) || !when.time) continue;
      if (!rows.has(when.time)) rows.set(when.time, new Map());
      const cells = rows.get(when.time);
      const rules = cells.get(when.date) || [];
      rules.push({rule, occurrence});
      cells.set(when.date, rules);
      displayed = true;
    }
    if (!displayed) parked.push(rule);
  }
  const timelineRows = [...rows.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const header = `<div class="schedule-timeline-row schedule-timeline-head"><span class="schedule-timeline-corner">${tr('Время', 'Time')}</span>${days.map(day => `<time class="schedule-date-label" datetime="${day.key}"><strong>${esc(day.date)}</strong><span>${esc(day.caption)}</span></time>`).join('')}</div>`;
  const body = timelineRows.map(([clock, cells]) => `<div class="schedule-timeline-row"><time class="schedule-timeline-time">${esc(clock)}</time>${days.map(day => {
    const entries = cells.get(day.key) || [];
    if (!entries.length) return '<span class="schedule-timeline-slot"></span>';
    return `<span class="schedule-timeline-slot occupied">${entries.map(({rule, occurrence}) => {
      const status = scheduleStatus(rule);
      const isNext = status.nextRun && new Date(status.nextRun).getTime() === new Date(occurrence).getTime();
      const kind = isNext && status.lastError ? 'error' : isNext && status.pending ? 'pending' : 'planned';
      const name = rule.name || tr('Без названия', 'Untitled');
      const title = `${name} · ${scheduleTargetName(rule)} · ${schedulePatternSummary(rule)}`;
      return `<button class="schedule-timeline-rule ${kind} ${rule.id === state.editingScheduleID ? 'selected' : ''}" data-edit-schedule="${esc(rule.id)}" title="${esc(title)}" aria-label="${esc(title)}">${esc(name)}</button>`;
    }).join('')}</span>`;
  }).join('')}</div>`).join('');
  const empty = timelineRows.length ? '' : `<div class="schedule-timeline-empty">${tr('На ближайшие 7 дней запусков нет.', 'No runs in the next 7 days.')}</div>`;
  const parkedRules = parked.length ? `<div class="schedule-parked"><span>${tr('Не показаны в календаре:', 'Not shown in the calendar:')}</span>${parked.map(rule => `<button data-edit-schedule="${esc(rule.id)}" class="schedule-parked-rule ${state.dirtySchedules.has(rule.id) ? 'dirty' : ''}">${esc(rule.name || tr('Новое правило', 'New rule'))} · ${rule.enabled ? state.dirtySchedules.has(rule.id) ? tr('изменено', 'modified') : tr('нет запусков за 7 дней', 'no runs in 7 days') : tr('отключено', 'disabled')}</button>`).join('')}</div>` : '';
  container.innerHTML = `<div class="schedule-timeline-card"><div class="schedule-timeline-scroll">${header}${body || empty}</div>${parkedRules}</div>`;
  const currentScroll = $('.schedule-timeline-scroll', container);
  currentScroll.scrollLeft = scrollLeft;
  currentScroll.scrollTop = scrollTop;
  applyLanguage();
}

function scheduleTargetName(rule) {
  if (rule.targetType === 'group') return state.settings?.groups.find(group => group.id === rule.targetId)?.name || tr('Удалённый диск', 'Deleted disk');
  return state.settings?.nodes.find(node => node.id === rule.targetId)?.name || tr('Удалённая нода', 'Deleted node');
}

function scheduleTargetOptions(type) {
  const items = type === 'node' ? state.settings.nodes : state.settings.groups;
  return items.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
}

function scheduleStartDefault() {
  const nextHour = new Date();
  nextHour.setMinutes(0, 0, 0);
  nextHour.setHours(nextHour.getHours() + 1);
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: state.settings?.timezone || 'UTC', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23',
    });
    const parts = Object.fromEntries(formatter.formatToParts(nextHour).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  } catch (_) {
    return new Date(nextHour.getTime() - nextHour.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
}

function scheduleStatus(rule) {
  return state.dashboard?.schedules?.find(item => item.ruleId === rule.id) || {};
}

function scheduleStatusText(rule) {
  const status = scheduleStatus(rule);
  if (!rule.enabled) return tr('Отключено', 'Disabled');
  if (state.dirtySchedules.has(rule.id)) return tr('Изменено', 'Modified');
  if (status.lastError) return `${tr('Последняя попытка:', 'Last attempt:')} ${status.lastError}`;
  if (status.pending) return tr('Ожидает освобождения', 'Waiting until available');
  if (status.nextRun) return tr('Запланировано', 'Scheduled');
  return tr('Не сохранено', 'Not saved');
}

function scheduleNextText(rule) {
  if (!rule.enabled) return '—';
  if (state.dirtySchedules.has(rule.id)) return tr('После сохранения', 'After saving');
  const status = scheduleStatus(rule);
  return status.nextRun ? scheduleTime(status.nextRun) : '—';
}

function refreshScheduleStatuses() {
  $$('[data-schedule-status]').forEach(element => {
    const rule = state.settings?.schedules?.find(item => item.id === element.dataset.scheduleStatus);
    if (!rule) return;
    const status = scheduleStatus(rule);
    element.textContent = scheduleStatusText(rule);
    element.classList.toggle('error-text', Boolean(rule.enabled && status.lastError));
  });
  $$('[data-schedule-next]').forEach(element => {
    const rule = state.settings?.schedules?.find(item => item.id === element.dataset.scheduleNext);
    if (rule) element.textContent = scheduleNextText(rule);
  });
}

function schedulePatternSummary(rule) {
  if (rule.mode === 'interval') {
    const start = rule.startAt ? rule.startAt.replace('T', ' ') : tr('время не задано', 'time not set');
    return tr(`Каждые ${Number(rule.intervalHours || 48)} ч · с ${start}`, `Every ${Number(rule.intervalHours || 48)} h · from ${start}`);
  }
  const selected = weekDays.filter(item => (rule.days || []).includes(item.day)).map(item => state.language === 'en' ? item.en : item.ru);
  const days = selected.length === 7 ? tr('Каждый день', 'Every day') : selected.join(', ') || tr('Дни не выбраны', 'No days selected');
  return `${days} · ${rule.at || '—'}`;
}

function scheduleEditor(rule) {
  const days = weekDays.map(item => `<label class="day-chip"><input data-day="${item.day}" type="checkbox" ${(rule.days || []).includes(item.day) ? 'checked' : ''}><span>${state.language === 'en' ? item.en : item.ru}</span></label>`).join('');
  const pattern = rule.mode === 'interval'
    ? `<label class="schedule-start"><span>${tr('Первый запуск', 'First run')}</span><input data-field="startAt" type="datetime-local" value="${esc(rule.startAt || '')}"></label><label><span>${tr('Каждые, часов', 'Every, hours')}</span><input data-field="intervalHours" type="number" min="1" max="8760" step="1" value="${esc(rule.intervalHours || 48)}"></label>`
    : `<div class="weekdays">${days}</div><label><span>${tr('Время', 'Time')}</span><input data-field="at" type="time" value="${esc(rule.at || '02:00')}"></label>`;
  return `<div class="schedule-editor">
    <div class="schedule-main">
      <label class="schedule-name"><span>${tr('Название', 'Name')}</span><input data-field="name" value="${esc(rule.name)}" placeholder="${tr('Ночная очередь HDD 1', 'Night queue HDD 1')}"></label>
      <label><span>${tr('Объект', 'Target')}</span><select data-field="targetType"><option value="group">${tr('Диск', 'Disk')}</option><option value="node">${tr('Нода', 'Node')}</option></select></label>
      <label class="schedule-target"><span>${tr('Диск или нода', 'Disk or node')}</span><select data-field="targetId">${scheduleTargetOptions(rule.targetType)}</select></label>
      <label><span>${tr('Повтор', 'Repeat')}</span><select data-field="mode"><option value="weekly" ${rule.mode === 'weekly' ? 'selected' : ''}>${tr('Дни недели', 'Weekdays')}</option><option value="interval" ${rule.mode === 'interval' ? 'selected' : ''}>${tr('Интервал', 'Interval')}</option></select></label>
    </div>
    <div class="schedule-foot"><div class="schedule-pattern">${pattern}</div><div class="schedule-editor-actions"><button class="button secondary small" data-close-schedule="${esc(rule.id)}">${tr('Готово', 'Done')}</button><button class="button primary small" data-add-another-schedule>${tr('+ Добавить ещё', '+ Add another')}</button></div></div>
  </div>`;
}

function scheduleEditorCard(rule) {
  const status = scheduleStatus(rule);
  return `<article class="schedule-editor-card" data-schedule-row="${esc(rule.id)}">
    <header class="schedule-editor-card-head"><div><h3>${esc(rule.name || tr('Новое правило', 'New rule'))}</h3><p>${esc(scheduleTargetName(rule))} · ${esc(schedulePatternSummary(rule))}</p></div><div class="schedule-editor-card-actions"><label class="schedule-rule-enabled"><input data-field="enabled" type="checkbox" ${rule.enabled ? 'checked' : ''}><span>${tr('Включено', 'Enabled')}</span></label><button class="button secondary small" data-duplicate-schedule="${esc(rule.id)}">${tr('Дублировать', 'Duplicate')}</button><button class="button ghost small" data-delete-schedule="${esc(rule.id)}">${tr('Удалить', 'Delete')}</button><button class="button ghost small" data-close-schedule="${esc(rule.id)}">${tr('Закрыть', 'Close')}</button></div></header>
    <div class="schedule-editor-state"><strong data-schedule-next="${esc(rule.id)}">${esc(scheduleNextText(rule))}</strong><span class="schedule-status ${rule.enabled && status.lastError ? 'error-text' : ''}" data-schedule-status="${esc(rule.id)}">${esc(scheduleStatusText(rule))}</span></div>
    ${scheduleEditor(rule)}
  </article>`;
}

function settingsPayload() {
  if (!state.settings) return null;
  state.settings.pollIntervalSeconds = Number($('#poll-interval').value || state.settings.pollIntervalSeconds);
  state.settings.timezone = ($('#schedule-timezone')?.value || state.settings.timezone || 'UTC').trim();
  const groupsByID = new Map(state.settings.groups.map(group => [group.id, group.name]));
  const nodes = [...state.settings.nodes].sort((a, b) => {
    const byGroup = collator.compare(groupsByID.get(a.groupId) || '', groupsByID.get(b.groupId) || '');
    return byGroup || collator.compare(a.name, b.name);
  });
  return {
    pollIntervalSeconds: state.settings.pollIntervalSeconds,
    timezone: state.settings.timezone,
    groups: state.settings.groups,
    nodes,
    schedules: state.settings.schedules || [],
  };
}

function id() {
  const values = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(values);
  } else {
    const seed = `${Date.now()}-${globalThis.performance?.now?.() || 0}-${Math.random()}`;
    for (let index = 0; index < values.length; index++) values[index] = seed.charCodeAt(index % seed.length) ^ Math.floor(Math.random() * 256);
  }
  return [...values].map(value => value.toString(16).padStart(2, '0')).join('');
}

function addSchedule(sourceRule = null) {
  if (!state.settings?.groups.length) return toast(tr('Сначала добавьте физический диск', 'Add a physical disk first'), true);
  const rule = sourceRule ? {
    ...sourceRule,
    id: id(),
    name: sourceRule.name ? `${sourceRule.name} — ${tr('копия', 'copy')}` : '',
    days: [...(sourceRule.days || [])],
  } : {
    id:id(), name:'', enabled:true, targetType:'group', targetId:state.settings.groups[0].id,
    mode:'weekly', days:[1,2,3,4,5,6,0], at:'02:00', startAt:'', intervalHours:0,
  };
  state.settings.schedules ||= [];
  state.settings.schedules.unshift(rule);
  state.dirtySchedules.add(rule.id);
  state.editingScheduleID = rule.id;
  renderSchedules();
  queueMicrotask(() => {
    const row = $(`[data-schedule-row="${CSS.escape(rule.id)}"]`);
    row?.scrollIntoView({behavior:'smooth', block:'start'});
    const input = $('[data-field="name"]', row);
    input?.focus();
    input?.select();
  });
}

function addNodeToGroup(groupID) {
  if (!groupID) return toast(tr('Сначала выберите физический диск', 'Select a physical disk first'), true);
  const node = {id:id(), name:'', url:'', apiKey:'', apiKeyConfigured:false, groupId:groupID, enabled:true};
  state.settings.nodes.push(node);
  state.selectedSettingsGroup = groupID;
  state.editingNodeID = node.id;
  renderSettings();
  queueMicrotask(() => $(`#settings-disk-detail [data-node-row="${CSS.escape(node.id)}"] [data-field="name"]`)?.focus());
}

function moveNodeToGroup(nodeID, groupID) {
  const index = state.settings.nodes.findIndex(node => node.id === nodeID);
  if (index < 0 || state.settings.nodes[index].groupId === groupID) return;
  const [node] = state.settings.nodes.splice(index, 1);
  node.groupId = groupID;
  state.settings.nodes.push(node);
  state.editingNodeID = '';
  renderSettings();
  toast(tr('Привязка изменена · сохраните настройки', 'Assignment changed · save settings'));
}

async function saveSettings(showNotice = true) {
  try {
    state.settings = await request('/api/settings', {method:'PUT', body: JSON.stringify(settingsPayload())});
    state.dirtySchedules.clear();
    renderSettings();
    renderSchedules();
    await loadDashboard(true);
    if (showNotice) toast(tr('Настройки сохранены', 'Settings saved'));
    return true;
  } catch (error) { toast(error.message, true); return false; }
}

async function action(path, confirmText) {
  if (confirmText && !confirm(confirmText)) return;
  try {
    await request(path, {method:'POST'});
    await loadDashboard(true);
    toast(tr('Команда принята', 'Command accepted'));
  } catch (error) { toast(error.message, true); }
}

function updateEditingState(target) {
  const groupRow = target.closest('[data-group-row]');
  if (groupRow && target.dataset.field === 'name') {
    const group = state.settings.groups.find(item => item.id === groupRow.dataset.groupRow);
    if (group) group.name = target.value;
    return;
  }
  const nodeRowElement = target.closest('[data-node-row]');
  if (nodeRowElement && target.dataset.field) {
    const node = state.settings.nodes.find(item => item.id === nodeRowElement.dataset.nodeRow);
    if (node) node[target.dataset.field] = target.type === 'checkbox' ? target.checked : target.value;
    return;
  }
  const scheduleElement = target.closest('[data-schedule-row]');
  if (!scheduleElement) return;
  const rule = state.settings.schedules.find(item => item.id === scheduleElement.dataset.scheduleRow);
  if (!rule) return;
  if (target.dataset.day !== undefined) {
    const day = Number(target.dataset.day);
    rule.days = target.checked ? [...new Set([...rule.days, day])].sort() : rule.days.filter(item => item !== day);
    state.dirtySchedules.add(rule.id);
    renderScheduleTimeline();
    refreshScheduleStatuses();
  } else if (target.dataset.field) {
    rule[target.dataset.field] = target.type === 'checkbox' ? target.checked : target.type === 'number' ? Number(target.value) : target.value;
    state.dirtySchedules.add(rule.id);
    if (target.dataset.field === 'targetType') {
      const candidates = target.value === 'node' ? state.settings.nodes : state.settings.groups;
      rule.targetId = candidates[0]?.id || '';
      renderSchedules();
    } else if (target.dataset.field === 'mode') {
      if (target.value === 'interval') {
        rule.startAt ||= scheduleStartDefault();
        rule.intervalHours ||= 48;
      } else {
        rule.days = rule.days?.length ? rule.days : [1,2,3,4,5,6,0];
        rule.at ||= '02:00';
      }
      renderSchedules();
    } else {
      renderScheduleTimeline();
      refreshScheduleStatuses();
    }
  }
}

document.addEventListener('input', event => {
  const target = event.target;
  if (target.id === 'group-search') { state.filter.groups = target.value; state.filter.groupPage = 1; return renderDashboard(); }
  if (target.id === 'node-search') { state.filter.nodes = target.value; state.filter.nodePage = 1; return renderDashboard(); }
  if (target.id === 'settings-group-search') { state.filter.settingsGroups = target.value; return renderSettings(); }
  if (target.id === 'settings-node-search') { state.filter.settingsNodes = target.value; return renderSettings(); }
  if (target.id === 'poll-interval' && state.settings) state.settings.pollIntervalSeconds = Number(target.value);
  if (target.id === 'schedule-timezone' && state.settings) {
    state.settings.timezone = target.value;
    state.settings.schedules.forEach(rule => state.dirtySchedules.add(rule.id));
    renderScheduleTimeline();
    return refreshScheduleStatuses();
  }
  if (target.dataset.field === 'groupId' && target.closest('[data-node-row]')) return;
  updateEditingState(target);
});

document.addEventListener('change', event => {
  const target = event.target;
  if (target.id === 'active-groups-only') { state.filter.groupsActiveOnly = target.checked; state.filter.groupPage = 1; return renderDashboard(); }
  if (target.id === 'node-group-filter') { state.filter.nodeGroup = target.value; state.filter.nodePage = 1; return renderDashboard(); }
  if (target.id === 'settings-node-group-filter') { state.filter.settingsNodeGroup = target.value; return renderSettings(); }
  if (target.id === 'ui-language') {
    state.language = target.value === 'en' ? 'en' : 'ru';
    globalThis.OrchestratorI18n?.setLanguage(state.language);
    collator = new Intl.Collator(state.language, {numeric:true, sensitivity:'base'});
    renderDashboard();
    renderSettings();
    renderSchedules();
    return applyLanguage();
  }
  if (target.dataset.moveNode) return moveNodeToGroup(target.dataset.moveNode, target.value);
  if (target.dataset.field === 'groupId' && target.closest('[data-node-row]')) return moveNodeToGroup(target.closest('[data-node-row]').dataset.nodeRow, target.value);
  updateEditingState(target);
});

document.addEventListener('click', event => {
  const nav = event.target.closest('[data-view]'); if (nav) return setView(nav.dataset.view);
  if (event.target.closest('[data-go-settings]')) return setView('settings');
  const groupView = event.target.closest('[data-group-view]');
  if (groupView) { state.groupView = groupView.dataset.groupView; return renderDashboard(); }
  const sort = event.target.closest('[data-sort-table]');
  if (sort) {
    const config = state.sort[sort.dataset.sortTable];
    if (config.key === sort.dataset.sortKey) config.direction = config.direction === 'asc' ? 'desc' : 'asc';
    else { config.key = sort.dataset.sortKey; config.direction = 'asc'; }
    const pageKey = ({groups:'groupPage', nodes:'nodePage', history:'historyPage'})[sort.dataset.sortTable];
    if (pageKey) state.filter[pageKey] = 1;
    if (sort.dataset.sortTable === 'history') return loadDashboard(true);
    if (sort.dataset.sortTable === 'settingsNodes') return renderSettings();
    return renderDashboard();
  }
  const expandGroup = event.target.closest('[data-expand-group]');
  if (expandGroup) {
    const groupID = expandGroup.dataset.expandGroup;
    if (state.expandedGroups.has(groupID)) state.expandedGroups.delete(groupID); else state.expandedGroups.add(groupID);
    return renderDashboard();
  }
  const expandJob = event.target.closest('[data-expand-job]');
  if (expandJob) {
    const jobID = expandJob.dataset.expandJob;
    if (state.expandedJobs.has(jobID)) state.expandedJobs.delete(jobID); else state.expandedJobs.add(jobID);
    return renderDashboard();
  }
  const showGroup = event.target.closest('[data-show-dashboard-group]');
  if (showGroup) {
    state.filter.nodeGroup = showGroup.dataset.showDashboardGroup;
    state.filter.nodePage = 1;
    renderDashboard();
    return requestAnimationFrame(() => $('#nodes-table')?.closest('.table-card')?.scrollIntoView({behavior:'smooth', block:'start'}));
  }
  const selectSettingsGroup = event.target.closest('[data-select-settings-group]');
  if (selectSettingsGroup) { state.selectedSettingsGroup = selectSettingsGroup.dataset.selectSettingsGroup; state.editingNodeID = ''; return renderSettings(); }
  const addToGroup = event.target.closest('[data-add-node-to-group]');
  if (addToGroup) return addNodeToGroup(addToGroup.dataset.addNodeToGroup);
  const editNode = event.target.closest('[data-edit-node]');
  if (editNode) { state.editingNodeID = editNode.dataset.editNode; renderSettings(); return queueMicrotask(() => $(`#settings-disk-detail [data-node-row="${CSS.escape(state.editingNodeID)}"] [data-field="name"]`)?.focus()); }
  const closeNodeEditor = event.target.closest('[data-close-node-editor]');
  if (closeNodeEditor) { state.editingNodeID = ''; return renderSettings(); }
  const page = event.target.closest('[data-page]');
  if (page) {
    const mapping = {groups:'groupPage', nodes:'nodePage', history:'historyPage'};
    state.filter[mapping[page.dataset.page]] = Number(page.dataset.pageValue);
    if (page.dataset.page === 'history') return loadDashboard(true);
    return renderDashboard();
  }
  const group = event.target.closest('[data-start-group]'); if (group) return action(`/api/groups/${encodeURIComponent(group.dataset.startGroup)}/start`, tr('Запустить full compaction последовательно на всех включённых нодах этого диска?', 'Run full compaction sequentially on every enabled node of this disk?'));
  const stop = event.target.closest('[data-stop-group]'); if (stop) return action(`/api/groups/${encodeURIComponent(stop.dataset.stopGroup)}/stop`, tr('Текущая нода продолжит работу, остальные будут пропущены. Остановить очередь?', 'The current node will finish and the remaining nodes will be skipped. Stop the queue?'));
  const node = event.target.closest('[data-start-node]'); if (node) return action(`/api/nodes/${encodeURIComponent(node.dataset.startNode)}/start`, tr('Запустить full compaction этой ноды?', 'Run full compaction on this node?'));
  const testNode = event.target.closest('[data-test-node]');
  if (testNode) return void (async () => {
    if (!await saveSettings(false)) return;
    try {
      const result = await request(`/api/nodes/${encodeURIComponent(testNode.dataset.testNode)}/test`, {method:'POST'});
      toast(result.online ? tr(`API ноды доступен · ${result.latencyMs} мс. Ключ проверится при запуске.`, `Node API is reachable · ${result.latencyMs} ms. The key will be checked at startup.`) : tr(`Нода недоступна: ${result.error}`, `Node is unreachable: ${result.error}`), !result.online);
    } catch (error) { toast(error.message, true); }
  })();
  const copy = event.target.closest('[data-copy]'); if (copy) navigator.clipboard.writeText(copy.dataset.copy).then(() => toast(tr('Команда скопирована', 'Command copied')));
  const editSchedule = event.target.closest('[data-edit-schedule]');
  if (editSchedule) {
    const scheduleID = editSchedule.dataset.editSchedule;
    state.editingScheduleID = state.editingScheduleID === scheduleID ? '' : scheduleID;
    renderSchedules();
    if (state.editingScheduleID) queueMicrotask(() => $(`[data-schedule-row="${CSS.escape(scheduleID)}"] [data-field="name"]`)?.focus());
    return;
  }
  const closeSchedule = event.target.closest('[data-close-schedule]');
  if (closeSchedule) { state.editingScheduleID = ''; return renderSchedules(); }
  const duplicateSchedule = event.target.closest('[data-duplicate-schedule]');
  if (duplicateSchedule) return addSchedule(state.settings.schedules.find(rule => rule.id === duplicateSchedule.dataset.duplicateSchedule));
  const addAnotherSchedule = event.target.closest('[data-add-another-schedule]');
  if (addAnotherSchedule) return addSchedule(state.settings.schedules.find(rule => rule.id === state.editingScheduleID));
  const deleteGroup = event.target.closest('[data-delete-group]');
  if (deleteGroup) {
    const target = deleteGroup.dataset.deleteGroup;
    if (state.settings.nodes.some(nodeItem => nodeItem.groupId === target)) return toast(tr('Сначала перенесите или удалите ноды этой группы', 'Move or delete the nodes in this group first'), true);
    if (state.settings.schedules.some(rule => rule.targetType === 'group' && rule.targetId === target)) return toast(tr('Сначала удалите расписания этой группы', 'Delete schedules for this group first'), true);
    state.settings.groups = state.settings.groups.filter(item => item.id !== target);
    if (state.selectedSettingsGroup === target) state.selectedSettingsGroup = state.settings.groups[0]?.id || '';
    return renderSettings();
  }
  const deleteNode = event.target.closest('[data-delete-node]');
  if (deleteNode) {
    const target = deleteNode.dataset.deleteNode;
    if (state.settings.schedules.some(rule => rule.targetType === 'node' && rule.targetId === target)) return toast(tr('Сначала удалите расписания этой ноды', 'Delete schedules for this node first'), true);
    state.settings.nodes = state.settings.nodes.filter(item => item.id !== target);
    if (state.editingNodeID === target) state.editingNodeID = '';
    return renderSettings();
  }
  const deleteSchedule = event.target.closest('[data-delete-schedule]');
  if (deleteSchedule) {
    const scheduleID = deleteSchedule.dataset.deleteSchedule;
    state.settings.schedules = state.settings.schedules.filter(rule => rule.id !== scheduleID);
    state.dirtySchedules.delete(scheduleID);
    if (state.editingScheduleID === scheduleID) state.editingScheduleID = '';
    return renderSchedules();
  }
});

$('#refresh').addEventListener('click', () => loadDashboard());
$('#save-settings').addEventListener('click', () => saveSettings());
$('#save-schedules').addEventListener('click', () => saveSettings());
$('#add-group').addEventListener('click', () => { const group = {id:id(), name:tr('Новый диск', 'New disk')}; state.settings.groups.push(group); state.selectedSettingsGroup = group.id; state.filter.settingsGroups = ''; renderSettings(); $('#settings-disk-detail [data-field="name"]')?.select(); });
$('#add-node').addEventListener('click', () => {
  if (!state.settings.groups.length) return toast(tr('Сначала добавьте физический диск', 'Add a physical disk first'), true);
  addNodeToGroup(state.selectedSettingsGroup || state.settings.groups[0].id);
});
$('#add-schedule').addEventListener('click', () => addSchedule());

const initialView = location.hash === '#settings' ? 'settings' : location.hash === '#schedule' ? 'schedule' : 'dashboard';
applyLanguage();
if (initialView !== 'dashboard') setView(initialView, false);
loadDashboard();
state.timer = setInterval(() => loadDashboard(true), 3000);
