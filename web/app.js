const PAGE_SIZE = 25;
const GROUP_PAGE_SIZE = 12;
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
  sort: {
    groups: {key: 'activity', direction: 'desc'},
    nodes: {key: 'name', direction: 'asc'},
    history: {key: 'started', direction: 'desc'},
  },
  filter: {
    groups: '', groupsActiveOnly: false, groupPage: 1,
    nodes: '', nodeGroup: '', nodePage: 1, historyPage: 1,
    settingsGroups: '', settingsGroupPage: 1, settingsNodes: '', settingsNodeGroup: '', settingsNodePage: 1,
    schedules: '', schedulePage: 1,
  },
};
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const collator = new Intl.Collator('ru', {numeric: true, sensitivity: 'base'});
const SATELLITE_NAMES = Object.freeze({
  '12EayRS2V1kEsWESU9QMRseFhdxYxKicsiFmxrsLZHeLUtdps3S': 'US1',
  '12L9ZFwhzVpuEKMUNUqkaTLGzwY9G24tbiigLiXpmZWKwmcNDDs': 'EU1',
  '121RTSDpyNZVcEU84Ticf2L1ntiuUimbWgfATz21tuvgk3vzoA6': 'AP1',
  '1wFTAgs9DP5RSnCqKV1eLf6N9wtk4EAtmN5DpSxcs8EjT69tGE': 'Saltlake',
});

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

async function request(path, options = {}) {
  const changing = options.method && options.method !== 'GET';
  const response = await fetch(path, {headers: {'Accept':'application/json', ...(options.body ? {'Content-Type':'application/json'} : {}), ...(changing ? {'X-Orchestrator-Request':'1'} : {})}, ...options});
  if (response.status === 401) {
    location.replace('/login.html');
    throw new Error('Требуется повторный вход');
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

function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)} сек`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} мин`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} ч`;
  return `${(seconds / 86400).toFixed(1)} дн`;
}

function elapsed(start, finish) {
  if (!start) return '—';
  return duration((new Date(finish || Date.now()) - new Date(start)) / 1000);
}

function time(value) {
  return value ? new Date(value).toLocaleString('ru-RU', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'}) : '—';
}

function scheduleTime(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('ru-RU', {timeZone: state.settings?.timezone || 'UTC', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'});
  } catch (_) {
    return time(value);
  }
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
  if (pages <= 1) return count ? `<span>${count} записей</span>` : '';
  return `<span>${count} записей · страница ${page} из ${pages}</span><div><button class="button secondary small" data-page="${scope}" data-page-value="${page - 1}" ${page === 1 ? 'disabled' : ''}>Назад</button><button class="button secondary small" data-page="${scope}" data-page-value="${page + 1}" ${page === pages ? 'disabled' : ''}>Вперёд</button></div>`;
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
  return {
    allNodes, nodes, job, currentNode, activity, manual, progress, percent, done, unavailable, active, ready,
    history,
    reclaimable: aggregate(nodes, 'reclaimableBytes'),
    reclaimed: jobCounterBytes(job, currentNode, 'reclaimedBytes', 'dataReclaimedBytes'),
    rewritten: jobCounterBytes(job, currentNode, 'rewrittenBytes', 'dataRewrittenBytes'),
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
  return position >= 0 ? `${node.name} (${position + 1} из ${nodes.length})` : node?.name || '';
}

function historyStatus(history) {
  if (!history?.runs) return '';
  const average = history.averageDurationSeconds > 0 ? `Среднее ${duration(history.averageDurationSeconds)} · ` : '';
  const errors = history.errorCount > 0 ? ` · ${history.errorCount} ${plural(history.errorCount, 'ошибка', 'ошибки', 'ошибок')}` : '';
  return `<small class="status-elapsed">${average}${history.runs} ${plural(history.runs, 'запуск', 'запуска', 'запусков')}${errors}</small>`;
}

function groupOperationRow(group) {
  const context = groupContext(group);
  const {allNodes, nodes, job, currentNode, activity, manual, progress, percent, done, unavailable, active, ready, history, reclaimable, reclaimed, rewritten} = context;
  const statusClass = job ? job.state : active ? 'running' : unavailable ? 'failed' : '';
  const statusText = job ? `Full · ${stateLabel(job.state)}` : active ? modeLabel(activity?.mode) : unavailable ? `${unavailable} недоступно` : nodes.length ? 'Свободен' : 'Нет нод';
  const statusStartedAt = job?.startedAt || (manual?.state === 'running' ? manual.startedAt : null);
  const statusElapsed = active && statusStartedAt
    ? `<small class="status-elapsed">Выполняется ${elapsed(statusStartedAt)}</small>`
    : historyStatus(history);
  const nodeCell = currentNode
    ? `<div class="node-title">${esc(nodePositionLabel(currentNode, nodes))}</div><div class="node-url">${esc(currentNode.url)}</div>`
    : `<span class="muted">${nodes.length} ${plural(nodes.length, 'нода', 'ноды', 'нод')}</span>`;
  const satelliteCell = activity?.satelliteID
    ? `<span class="satellite operation-satellite" title="${esc(activity.satelliteID)}">${esc(satelliteLabel(activity.satelliteID))}</span>`
    : '<span class="muted">—</span>';
  let progressCell = '<span class="muted">—</span>';
  if (progress) {
    progressCell = `<div class="progress-wrap operation-progress"><div class="progress-head"><strong>${percent.toFixed(1)}%</strong><span>ETA ${duration(progress.remainingSeconds)}</span></div><progress class="progress" value="${percent}" max="100" aria-label="Выполнено ${percent.toFixed(1)}%"></progress></div>`;
  } else if (active) {
    progressCell = '<span class="muted">Между раундами</span>';
  }
  const satelliteQueue = manual?.totalSatellites
    ? `<small>${manual.processedSatellites} из ${manual.totalSatellites} спутников</small>`
    : '<small>ожидание данных ноды</small>';
  const queueCell = job
    ? `<div class="metric"><strong>${done} из ${job.nodes.length} нод</strong>${satelliteQueue}</div>`
    : manual?.state === 'running'
      ? `<div class="metric"><strong>${manual.processedSatellites} из ${manual.totalSatellites}</strong><small>спутников</small></div>`
      : active ? '<span class="muted">Вне очереди</span>' : '<span class="muted">—</span>';
  const reclaimedCell = job
    ? `<div class="metric"><strong>${bytes(reclaimed)}</strong><small>текущая очередь</small></div>`
    : active
      ? '<span class="muted" title="Orchestrator не снимал baseline перед этим запуском">Нет baseline</span>'
      : '<span class="muted">—</span>';
  const rewrittenCell = job
    ? `<div class="metric"><strong>${bytes(rewritten)}</strong><small>текущая очередь</small></div>`
    : active
      ? '<span class="muted" title="Orchestrator не снимал baseline перед этим запуском">Нет baseline</span>'
      : '<span class="muted">—</span>';
  const action = job
    ? `<button class="button secondary small" data-stop-group="${esc(group.id)}">Остановить</button>`
    : active
      ? '<button class="button secondary small" disabled>Занят</button>'
      : `<button class="button primary small" data-start-group="${esc(group.id)}" ${ready ? '' : 'disabled'}>Запустить</button>`;
  return `<tr class="${active ? 'active-operation' : ''}">
    <td><div class="operation-disk"><span class="drive-icon">HDD</span><div><strong>${esc(group.name)}</strong><small>${allNodes.length} ${plural(allNodes.length, 'нода', 'ноды', 'нод')}</small></div></div></td>
    <td><div class="status-stack"><span class="status ${esc(statusClass)}">${esc(statusText)}</span>${statusElapsed}</div></td>
    <td>${nodeCell}</td><td>${satelliteCell}</td><td>${progressCell}</td><td>${queueCell}</td>
    <td class="metric"><strong>${bytes(reclaimable)}</strong></td><td>${reclaimedCell}</td><td>${rewrittenCell}</td>
    <td><div class="operation-actions">${action}<button class="button ghost small" data-show-dashboard-group="${esc(group.id)}">Ноды</button></div></td>
  </tr>`;
}

function nodeSortValue(node, key) {
  const info = node.runtime.info;
  const progress = currentActivity(node).progress;
  switch (key) {
    case 'group': return groupFor(node.groupId)?.name || '';
    case 'status': return !node.enabled ? '0-disabled' : node.runtime.online ? '2-online' : '1-offline';
    case 'work': return progress?.totalRecords ? progress.processedRecords / progress.totalRecords : info?.manualJob?.state === 'running' ? 0 : -1;
    case 'reclaimable': return Number(info?.reclaimableBytes || 0);
    case 'reclaimed': return Number(info?.runtimeTotals?.dataReclaimedBytes || 0);
    case 'rewritten': return Number(info?.runtimeTotals?.dataRewrittenBytes || 0);
    default: return node.name;
  }
}

function renderSortIndicators() {
  $$('[data-sort-table]').forEach(button => {
    const config = state.sort[button.dataset.sortTable];
    const active = config.key === button.dataset.sortKey;
    button.classList.toggle('active', active);
    $('span', button).textContent = active ? config.direction === 'asc' ? '↑' : '↓' : '↕';
    button.closest('th').setAttribute('aria-sort', active ? config.direction === 'asc' ? 'ascending' : 'descending' : 'none');
  });
}

function renderDashboard() {
  const data = state.dashboard;
  if (!data) return;
  const configured = data.groups.length > 0;
  $('#empty-state').classList.toggle('hidden', configured);
  $('#dashboard-content').classList.toggle('hidden', !configured);
  if (!configured) return;

  const enabled = data.nodes.filter(node => node.enabled);
  const online = enabled.filter(node => node.runtime.online).length;
  const running = enabled.filter(node => node.runtime.info?.manualJob?.state === 'running').length;
  const reclaimable = aggregate(data.nodes, 'reclaimableBytes');
  const lost = aggregate(data.nodes, 'salvage.lostPieces');
  $('#summary').innerHTML = [
    ['Ноды в сети', `${online} / ${enabled.length}`, 'Среди включённых в настройках', 'ON'],
    ['Full compaction', String(running), running ? 'Тяжёлые операции сейчас' : 'Сейчас диски свободны', 'RUN'],
    ['Можно освободить', bytes(reclaimable), 'По данным всех доступных нод', 'FREE'],
    ['Salvage: потеряно', String(lost), 'Pieces с момента запуска нод', 'SLV'],
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
  $('#groups-table').innerHTML = sortedGroups.length ? sortedGroups.map(groupOperationRow).join('') : '<tr><td colspan="10" class="empty-row">Диски не найдены</td></tr>';
  $('#groups').innerHTML = groupPage.items.length ? groupPage.items.map(groupCard).join('') : '<div class="empty-row panel">Диски не найдены</div>';
  $('#groups-pager').innerHTML = pagerHTML('groups', groupPage.page, groupPage.pages, matchingGroups.length);

  const currentFilter = state.filter.nodeGroup;
  $('#node-group-filter').innerHTML = '<option value="">Все диски</option>' + data.groups.map(group => `<option value="${esc(group.id)}">${esc(group.name)}</option>`).join('');
  $('#node-group-filter').value = currentFilter;
  $('#node-search').value = state.filter.nodes;
  const nodeQuery = state.filter.nodes.toLowerCase();
  const matchingNodes = data.nodes.filter(node => (!currentFilter || node.groupId === currentFilter) && `${node.name} ${node.url}`.toLowerCase().includes(nodeQuery));
  const sortedNodes = sortRows(matchingNodes, 'nodes', nodeSortValue);
  const nodePage = pageSlice(sortedNodes, state.filter.nodePage, PAGE_SIZE);
  state.filter.nodePage = nodePage.page;
  $('#nodes-table').innerHTML = nodePage.items.length ? nodePage.items.map(nodeRow).join('') : '<tr><td colspan="8" class="empty-row">Ноды не найдены</td></tr>';
  $('#nodes-pager').innerHTML = pagerHTML('nodes', nodePage.page, nodePage.pages, matchingNodes.length);
  const history = state.history || {jobs: [], total: 0};
  const historyPages = Math.max(1, Math.ceil(history.total / PAGE_SIZE));
  state.filter.historyPage = Math.min(Math.max(1, state.filter.historyPage), historyPages);
  $('#history-table').innerHTML = history.jobs.length ? history.jobs.map(historyRow).join('') : '<tr><td colspan="8" class="empty-row">Запусков пока не было</td></tr>';
  $('#history-pager').innerHTML = pagerHTML('history', state.filter.historyPage, historyPages, history.total);
  renderSortIndicators();
}

function groupCard(group) {
  const context = groupContext(group);
  const {allNodes, nodes, job, done, unavailable, ready, history} = context;
  const externalNode = !job ? context.currentNode : null;
  const current = job?.nodes.findIndex(node => ['checking','running'].includes(node.state)) ?? nodes.findIndex(node => node.id === externalNode?.id);
  const queue = nodes.map((_, index) => `<span class="queue-step ${index < done ? 'done' : index === current ? 'current' : ''}"></span>`).join('');
  const currentNode = nodes.find(node => node.id === job?.currentNodeId) || externalNode;
  const activity = currentNode ? currentActivity(currentNode) : null;
  const manual = currentNode?.runtime.info?.manualJob;
  const satellite = activity?.satelliteID ? `<small class="satellite" title="${esc(activity.satelliteID)}">${esc(satelliteLabel(activity.satelliteID))}</small>` : '';
  const satelliteCount = manual?.totalSatellites ? `<small class="satellite-count">${manual.processedSatellites} из ${manual.totalSatellites} спутников</small>` : '';
  const statusClass = job ? job.state : externalNode ? 'running' : unavailable ? 'failed' : '';
  const statusText = job ? stateLabel(job.state) : externalNode ? modeLabel(currentActivity(externalNode).mode) : unavailable ? `${unavailable} недоступно` : 'Свободен';
  const statusStartedAt = job?.startedAt || (manual?.state === 'running' ? manual.startedAt : null);
  const statusElapsed = (job || externalNode) && statusStartedAt
    ? `<small class="status-elapsed">Выполняется ${elapsed(statusStartedAt)}</small>`
    : historyStatus(history);
  const expanded = state.expandedGroups.has(group.id);
  let queuePosition = 0;
  const contents = expanded ? `<div class="group-node-list">${allNodes.map(node => {
    if (node.enabled) queuePosition++;
    return `<div class="group-node-item"><span class="queue-number">${node.enabled ? queuePosition : '—'}</span><div><strong>${esc(node.name)}</strong><small>${esc(node.url)}</small></div><span class="status ${node.enabled && node.runtime.online ? 'online' : node.enabled ? 'offline' : ''}">${node.enabled ? node.runtime.online ? 'В сети' : 'Нет связи' : 'Отключена'}</span></div>`;
  }).join('') || '<div class="empty-row">На диске нет нод</div>'}</div>` : '';
  return `<article class="group-card ${job || externalNode ? 'running' : ''}">
    <div class="group-head"><div class="group-name"><span class="drive-icon">HDD</span><div><strong>${esc(group.name)}</strong><small>${allNodes.length} ${plural(allNodes.length, 'нода', 'ноды', 'нод')} · ${nodes.length} включено</small></div></div><div class="status-stack card-status"><span class="status ${esc(statusClass)}">${statusText}</span>${statusElapsed}</div></div>
    <div class="group-stats"><div class="mini-stat"><span>Можно освободить</span><strong>${bytes(aggregate(nodes, 'reclaimableBytes'))}</strong></div><div class="mini-stat"><span>Сейчас</span><strong>${currentNode ? esc(nodePositionLabel(currentNode, nodes)) : 'Нет работы'}</strong>${satellite}${satelliteCount}</div></div>
    <div class="queue">${queue || '<span class="muted">Нет включённых нод</span>'}<span class="queue-label">${job ? `${done}/${job.nodes.length}` : ''}</span></div>
    <div class="group-tools"><button class="button ghost small" data-expand-group="${esc(group.id)}">${expanded ? 'Скрыть состав' : `Состав (${allNodes.length})`}</button><button class="button ghost small" data-show-dashboard-group="${esc(group.id)}">В таблицу</button></div>
    ${contents}
    <div class="group-actions">${job ? `<button class="button secondary" data-stop-group="${esc(group.id)}">Остановить после текущей</button>` : externalNode ? '<button class="button secondary" disabled>Full compaction уже выполняется</button>' : `<button class="button primary" data-start-group="${esc(group.id)}" ${ready ? '' : 'disabled'}>Запустить очередь</button>`}</div>
  </article>`;
}

function nodeRow(node) {
  const info = node.runtime.info;
  const group = groupFor(node.groupId);
  const activity = currentActivity(node);
  const progress = activity.progress;
  const percent = progress?.totalRecords ? Math.min(100, progress.processedRecords / progress.totalRecords * 100) : 0;
  const manual = info?.manualJob;
  let work = '<span class="muted">Ожидание</span>';
  if (progress) {
    const satellite = activity.satelliteID ? `<span class="satellite" title="${esc(activity.satelliteID)}">${esc(satelliteLabel(activity.satelliteID))}</span>` : '';
    const satelliteCount = manual?.totalSatellites ? `<small class="satellite-count">${manual.processedSatellites} из ${manual.totalSatellites} спутников</small>` : '';
    work = `<div class="progress-wrap"><div class="progress-head"><span>${esc(activity.mode)}</span><span>${percent.toFixed(1)}% · ETA ${duration(progress.remainingSeconds)}</span></div>${satellite}${satelliteCount}<progress class="progress" value="${percent}" max="100" aria-label="Выполнено ${percent.toFixed(1)}%"></progress></div>`;
  } else if (manual?.state === 'running') {
    const satellite = activity.satelliteID ? `<small class="satellite" title="${esc(activity.satelliteID)}">${esc(satelliteLabel(activity.satelliteID))}</small>` : '';
    const satelliteCount = manual.totalSatellites ? `<small class="satellite-count">${manual.processedSatellites} из ${manual.totalSatellites} спутников</small>` : '';
    work = `<span class="state-pill running">${stateLabel(manual.state)}</span>${satellite}${satelliteCount}`;
  } else if (manual?.state && manual.state !== 'idle') {
    work = `<span class="state-pill ${esc(manual.state)}">${stateLabel(manual.state)}</span>`;
  }
  const status = !node.enabled ? '<span class="status">Отключена</span>' : node.runtime.online ? '<span class="status online">В сети</span>' : `<span class="status offline" title="${esc(node.runtime.error)}">Нет связи</span>`;
  const peers = groupNodes(node.groupId).filter(item => item.enabled);
  const groupSafe = peers.every(item => item.runtime.online && item.runtime.info?.manualJob?.state !== 'running');
  const disabled = !node.enabled || group?.runningJob || !groupSafe || manual?.state === 'running' || !node.runtime.online || !info?.manualLogCompactionEnabled;
  return `<tr><td><div class="node-title">${esc(node.name)}</div><div class="node-url">${esc(node.url)}</div></td><td>${esc(group?.name || '—')}</td><td>${status}</td><td>${work}</td><td class="metric"><strong>${bytes(info?.reclaimableBytes)}</strong><small>${info ? info.manualLogCompactionEnabled ? 'manual mode' : 'manual mode выключен' : 'нет данных'}</small></td><td class="metric"><strong>${bytes(info?.runtimeTotals?.dataReclaimedBytes)}</strong><small>${info?.runtimeTotals?.failedAttempts || 0} ошибок</small></td><td class="metric"><strong>${bytes(info?.runtimeTotals?.dataRewrittenBytes)}</strong><small>${info?.runtimeTotals?.logsRewritten || 0} логов</small></td><td><button class="button secondary small" data-start-node="${esc(node.id)}" ${disabled ? 'disabled' : ''}>Запустить</button></td></tr>`;
}

function historyRow(job) {
  const reclaimed = job.nodes.reduce((sum, node) => sum + Number(node.reclaimedBytes || 0), 0);
  const rewritten = job.nodes.reduce((sum, node) => sum + Number(node.rewrittenBytes || 0), 0);
  const done = job.nodes.filter(node => ['succeeded','failed','canceled'].includes(node.state)).length;
  const trigger = job.trigger === 'schedule' ? 'Расписание' : 'Вручную';
  const errors = job.nodes.filter(node => node.state === 'failed' && node.error);
  const expanded = state.expandedJobs.has(job.id);
  const errorSummary = errors.length ? `<small class="history-error" title="${esc(errors.map(node => `${node.nodeName}: ${node.error}`).join('\n'))}">${errors.length} ${plural(errors.length, 'ошибка', 'ошибки', 'ошибок')}</small>` : '';
  const details = expanded ? `<tr class="history-detail-row"><td colspan="8"><div class="history-node-list">${job.nodes.map((node, index) => `<div class="history-node"><span class="queue-number">${index + 1}</span><div><strong>${esc(node.nodeName)}</strong><small>${elapsed(node.startedAt, node.finishedAt)} · reclaimed ${bytes(node.reclaimedBytes)} · rewritten ${bytes(node.rewrittenBytes)}</small>${node.error ? `<em>${esc(node.error)}</em>` : ''}</div><span class="state-pill ${esc(node.state)}">${stateLabel(node.state)}</span></div>`).join('')}</div></td></tr>` : '';
  return `<tr><td class="metric"><strong>${time(job.startedAt)}</strong><small>${esc(job.id.slice(0, 8))}</small></td><td>${trigger}</td><td>${esc(job.groupName)}</td><td><span class="state-pill ${esc(job.state)}">${stateLabel(job.state)}</span>${errorSummary}</td><td>${done} / ${job.nodes.length}</td><td>${bytes(reclaimed)}</td><td>${bytes(rewritten)}</td><td class="metric"><strong>${elapsed(job.startedAt, job.finishedAt)}</strong><button class="button ghost history-details-button" data-expand-job="${esc(job.id)}">${expanded ? 'Скрыть' : 'Детали'}</button></td></tr>${details}`;
}

function plural(n, one, few, many) { const m = n % 100; const d = n % 10; return m >= 11 && m <= 19 ? many : d === 1 ? one : d >= 2 && d <= 4 ? few : many; }
function stateLabel(value) { return ({idle:'Ожидание',running:'Выполняется',checking:'Проверка',stopping:'Завершается',stopped:'Остановлено',succeeded:'Успешно',failed:'Ошибка',canceled:'Отменено',interrupted:'Прервано',queued:'В очереди',skipped:'Пропущено'})[value] || value || '—'; }

async function loadDashboard(silent = false) {
  try {
    const historySort = state.sort.history;
    const historyQuery = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String((state.filter.historyPage - 1) * PAGE_SIZE),
      sort: historySort.key,
      direction: historySort.direction,
    });
    [state.dashboard, state.history] = await Promise.all([
      request('/api/dashboard'),
      request(`/api/history?${historyQuery}`),
    ]);
    renderDashboard();
    if (state.view === 'schedule' && state.settings) renderSchedules();
    $('.pulse').classList.remove('error');
    $('#poll-status').textContent = `Обновлено ${new Date().toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit',second:'2-digit'})}`;
  } catch (error) {
    $('.pulse').classList.add('error');
    $('#poll-status').textContent = 'Нет связи с orchestrator';
    if (!silent) toast(error.message, true);
  }
}

async function loadSettings() {
  try {
    state.settings = await request('/api/settings');
    renderSettings();
    renderSchedules();
  } catch (error) { toast(error.message, true); }
}

function groupOptions(selectedID) {
  return state.settings.groups.map(group => `<option value="${esc(group.id)}" ${group.id === selectedID ? 'selected' : ''}>${esc(group.name)}</option>`).join('');
}

function nodeEditor(node, inline = false) {
  return `<div class="node-edit ${inline ? 'inline-node-edit' : ''}" data-node-row="${esc(node.id)}">
    <label><span>Название</span><input data-field="name" value="${esc(node.name)}" placeholder="node-01"></label>
    <label class="wide"><span>Адрес dashboard</span><input data-field="url" value="${esc(node.url)}" placeholder="http://192.168.1.20:14005"></label>
    <label><span>Физический диск</span><select data-field="groupId">${groupOptions(node.groupId)}</select></label>
    <label class="wide"><span>Multinode API key</span><input data-field="apiKey" value="${esc(node.apiKey || '')}" type="password" autocomplete="new-password" placeholder="${node.apiKeyConfigured ? 'Ключ сохранён · оставьте пустым' : 'Вставьте ключ'}"></label>
    <label class="check-field"><span>Включена</span><input data-field="enabled" type="checkbox" ${node.enabled ? 'checked' : ''}></label>
    <div class="edit-actions"><button class="button secondary small" data-test-node="${esc(node.id)}">Проверить адрес</button>${inline ? `<button class="button ghost" data-close-node-editor="${esc(node.id)}">Свернуть</button>` : ''}<button class="button ghost" data-delete-node="${esc(node.id)}">Удалить</button></div>
  </div>`;
}

function renderDiskDetail(group) {
  if (!group) return '<div class="disk-detail-empty"><strong>Выберите диск</strong><span>Справа появится его состав и управление привязками.</span></div>';
  const nodes = state.settings.nodes.filter(node => node.groupId === group.id);
  const rows = nodes.map((node, index) => `<div class="disk-node-block">
    <div class="disk-node-row">
      <span class="queue-number" title="Позиция в очереди">${index + 1}</span>
      <div class="disk-node-identity"><strong>${esc(node.name || 'Новая нода')}</strong><small>${esc(node.url || 'Адрес ещё не указан')}</small></div>
      <span class="state-pill ${node.enabled ? 'succeeded' : ''}">${node.enabled ? 'Включена' : 'Отключена'}</span>
      <label class="move-field"><span>Переместить на диск</span><select data-move-node="${esc(node.id)}">${groupOptions(node.groupId)}</select></label>
      <button class="button secondary small" data-edit-node="${esc(node.id)}">${state.editingNodeID === node.id ? 'Редактируется' : 'Редактировать'}</button>
    </div>
    ${state.editingNodeID === node.id ? nodeEditor(node, true) : ''}
  </div>`).join('');
  return `<div class="disk-detail-head" data-group-row="${esc(group.id)}"><div><label><span>Название диска</span><input data-field="name" value="${esc(group.name)}"></label><p>${nodes.length} ${plural(nodes.length, 'нода', 'ноды', 'нод')} · порядок ниже является порядком очереди</p></div><button class="button primary small" data-add-node-to-group="${esc(group.id)}">+ Добавить ноду</button></div>
    <div class="disk-node-list">${rows || '<div class="disk-detail-empty"><strong>На диске пока нет нод</strong><span>Добавьте новую или перенесите существующую.</span></div>'}</div>
    <p class="disk-detail-hint">При переносе нода становится последней в очереди нового диска. Изменения применятся после сохранения настроек.</p>`;
}

function renderSettings() {
  const settings = state.settings;
  if (!settings) return;
  $('#poll-interval').value = settings.pollIntervalSeconds;
  if (!settings.groups.some(group => group.id === state.selectedSettingsGroup)) state.selectedSettingsGroup = settings.groups[0]?.id || '';

  $('#settings-group-search').value = state.filter.settingsGroups;
  const groupQuery = state.filter.settingsGroups.toLowerCase();
  const matchingGroups = settings.groups.filter(group => group.name.toLowerCase().includes(groupQuery));
  const groupPage = pageSlice(matchingGroups, state.filter.settingsGroupPage, 10);
  state.filter.settingsGroupPage = groupPage.page;
  $('#settings-groups').innerHTML = groupPage.items.length ? groupPage.items.map(group => {
    const count = settings.nodes.filter(node => node.groupId === group.id).length;
    return `<div class="disk-selector ${group.id === state.selectedSettingsGroup ? 'selected' : ''}"><button data-select-settings-group="${esc(group.id)}"><span class="drive-icon">HDD</span><span><strong>${esc(group.name)}</strong><small>${count} ${plural(count, 'нода', 'ноды', 'нод')}</small></span></button><button class="button ghost" data-delete-group="${esc(group.id)}" title="Удалить диск">×</button></div>`;
  }).join('') : '<div class="empty-row">Диски не найдены</div>';
  $('#settings-groups-pager').innerHTML = pagerHTML('settingsGroups', groupPage.page, groupPage.pages, matchingGroups.length);
  $('#settings-disk-detail').innerHTML = renderDiskDetail(settings.groups.find(group => group.id === state.selectedSettingsGroup));

  $('#settings-node-group-filter').innerHTML = '<option value="">Все диски</option>' + settings.groups.map(group => `<option value="${esc(group.id)}">${esc(group.name)}</option>`).join('');
  $('#settings-node-group-filter').value = state.filter.settingsNodeGroup;
  $('#settings-node-search').value = state.filter.settingsNodes;
  const nodeQuery = state.filter.settingsNodes.toLowerCase();
  const matchingNodes = settings.nodes.filter(node => (!state.filter.settingsNodeGroup || node.groupId === state.filter.settingsNodeGroup) && `${node.name} ${node.url}`.toLowerCase().includes(nodeQuery));
  const nodePage = pageSlice(matchingNodes, state.filter.settingsNodePage, PAGE_SIZE);
  state.filter.settingsNodePage = nodePage.page;
  $('#settings-nodes').innerHTML = nodePage.items.length ? nodePage.items.map(node => nodeEditor(node)).join('') : '<div class="empty-row">Ноды не найдены</div>';
  $('#settings-nodes-pager').innerHTML = pagerHTML('settingsNodes', nodePage.page, nodePage.pages, matchingNodes.length);
}

const weekDays = [{day:1,name:'Пн'},{day:2,name:'Вт'},{day:3,name:'Ср'},{day:4,name:'Чт'},{day:5,name:'Пт'},{day:6,name:'Сб'},{day:0,name:'Вс'}];

function renderSchedules() {
  const settings = state.settings;
  if (!settings) return;
  $('#schedule-timezone').value = settings.timezone || 'UTC';
  $('#schedule-search').value = state.filter.schedules;
  const query = state.filter.schedules.toLowerCase();
  const matching = (settings.schedules || []).filter(rule => `${rule.name} ${scheduleTargetName(rule)}`.toLowerCase().includes(query));
  const page = pageSlice(matching, state.filter.schedulePage, 20);
  state.filter.schedulePage = page.page;
  $('#schedule-list').innerHTML = page.items.length ? page.items.map(scheduleRow).join('') : '<div class="empty-state schedule-empty"><h2>Правил пока нет</h2><p>Создайте расписание для диска или отдельной ноды.</p></div>';
  $('#schedule-pager').innerHTML = pagerHTML('schedules', page.page, page.pages, matching.length);
  page.items.forEach(rule => {
    const type = $(`[data-schedule-row="${CSS.escape(rule.id)}"] [data-field="targetType"]`);
    const target = $(`[data-schedule-row="${CSS.escape(rule.id)}"] [data-field="targetId"]`);
    if (type) type.value = rule.targetType;
    if (target) target.value = rule.targetId;
  });
}

function scheduleTargetName(rule) {
  if (rule.targetType === 'group') return state.settings?.groups.find(group => group.id === rule.targetId)?.name || 'Удалённый диск';
  return state.settings?.nodes.find(node => node.id === rule.targetId)?.name || 'Удалённая нода';
}

function scheduleTargetOptions(type) {
  const items = type === 'node' ? state.settings.nodes : state.settings.groups;
  return items.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
}

function scheduleRow(rule) {
  const status = state.dashboard?.schedules?.find(item => item.ruleId === rule.id) || {};
  const days = weekDays.map(({day, name}) => `<label class="day-chip"><input data-day="${day}" type="checkbox" ${rule.days.includes(day) ? 'checked' : ''}><span>${name}</span></label>`).join('');
  let statusText = !rule.enabled ? 'Отключено' : status.pending ? 'Ожидает свободного диска' : status.nextRun ? `Следующий: ${scheduleTime(status.nextRun)}` : 'Расписание сохранится после проверки';
  if (rule.enabled && status.lastError) statusText = `Последняя попытка: ${status.lastError}`;
  return `<article class="schedule-row" data-schedule-row="${esc(rule.id)}">
    <div class="schedule-main">
      <label class="schedule-name"><span>Название</span><input data-field="name" value="${esc(rule.name)}" placeholder="Ночная очередь HDD 1"></label>
      <label><span>Объект</span><select data-field="targetType"><option value="group">Диск</option><option value="node">Нода</option></select></label>
      <label class="schedule-target"><span>Диск или нода</span><select data-field="targetId">${scheduleTargetOptions(rule.targetType)}</select></label>
      <label class="schedule-at"><span>Время</span><input data-field="at" type="time" value="${esc(rule.at)}"></label>
      <label class="check-field"><span>Включено</span><input data-field="enabled" type="checkbox" ${rule.enabled ? 'checked' : ''}></label>
      <button class="button ghost" data-delete-schedule="${esc(rule.id)}">Удалить</button>
    </div>
    <div class="schedule-foot"><div class="weekdays">${days}</div><div class="schedule-status ${rule.enabled && status.lastError ? 'error-text' : ''}">${esc(statusText)}</div></div>
  </article>`;
}

function settingsPayload() {
  if (!state.settings) return null;
  state.settings.pollIntervalSeconds = Number($('#poll-interval').value || state.settings.pollIntervalSeconds);
  state.settings.timezone = ($('#schedule-timezone')?.value || state.settings.timezone || 'UTC').trim();
  return {
    pollIntervalSeconds: state.settings.pollIntervalSeconds,
    timezone: state.settings.timezone,
    groups: state.settings.groups,
    nodes: state.settings.nodes,
    schedules: state.settings.schedules || [],
  };
}

function id() { return crypto.randomUUID().replaceAll('-', ''); }

function addNodeToGroup(groupID) {
  if (!groupID) return toast('Сначала выберите физический диск', true);
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
  toast('Привязка изменена · сохраните настройки');
}

async function saveSettings(showNotice = true) {
  try {
    state.settings = await request('/api/settings', {method:'PUT', body: JSON.stringify(settingsPayload())});
    renderSettings();
    renderSchedules();
    await loadDashboard(true);
    if (showNotice) toast('Настройки сохранены');
    return true;
  } catch (error) { toast(error.message, true); return false; }
}

async function action(path, confirmText) {
  if (confirmText && !confirm(confirmText)) return;
  try {
    await request(path, {method:'POST'});
    await loadDashboard(true);
    toast('Команда принята');
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
  } else if (target.dataset.field) {
    rule[target.dataset.field] = target.type === 'checkbox' ? target.checked : target.value;
    if (target.dataset.field === 'targetType') {
      const candidates = target.value === 'node' ? state.settings.nodes : state.settings.groups;
      rule.targetId = candidates[0]?.id || '';
      renderSchedules();
    }
  }
}

document.addEventListener('input', event => {
  const target = event.target;
  if (target.id === 'group-search') { state.filter.groups = target.value; state.filter.groupPage = 1; return renderDashboard(); }
  if (target.id === 'node-search') { state.filter.nodes = target.value; state.filter.nodePage = 1; return renderDashboard(); }
  if (target.id === 'settings-group-search') { state.filter.settingsGroups = target.value; state.filter.settingsGroupPage = 1; return renderSettings(); }
  if (target.id === 'settings-node-search') { state.filter.settingsNodes = target.value; state.filter.settingsNodePage = 1; return renderSettings(); }
  if (target.id === 'schedule-search') { state.filter.schedules = target.value; state.filter.schedulePage = 1; return renderSchedules(); }
  if (target.id === 'poll-interval' && state.settings) state.settings.pollIntervalSeconds = Number(target.value);
  if (target.id === 'schedule-timezone' && state.settings) state.settings.timezone = target.value;
  if (target.dataset.field === 'groupId' && target.closest('[data-node-row]')) return;
  updateEditingState(target);
});

document.addEventListener('change', event => {
  const target = event.target;
  if (target.id === 'active-groups-only') { state.filter.groupsActiveOnly = target.checked; state.filter.groupPage = 1; return renderDashboard(); }
  if (target.id === 'node-group-filter') { state.filter.nodeGroup = target.value; state.filter.nodePage = 1; return renderDashboard(); }
  if (target.id === 'settings-node-group-filter') { state.filter.settingsNodeGroup = target.value; state.filter.settingsNodePage = 1; return renderSettings(); }
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
    const mapping = {groups:'groupPage', nodes:'nodePage', history:'historyPage', settingsGroups:'settingsGroupPage', settingsNodes:'settingsNodePage', schedules:'schedulePage'};
    state.filter[mapping[page.dataset.page]] = Number(page.dataset.pageValue);
    if (page.dataset.page === 'history') return loadDashboard(true);
    return ['groups','nodes'].includes(page.dataset.page) ? renderDashboard() : page.dataset.page === 'settingsGroups' || page.dataset.page === 'settingsNodes' ? renderSettings() : renderSchedules();
  }
  const group = event.target.closest('[data-start-group]'); if (group) return action(`/api/groups/${encodeURIComponent(group.dataset.startGroup)}/start`, 'Запустить full compaction последовательно на всех включённых нодах этого диска?');
  const stop = event.target.closest('[data-stop-group]'); if (stop) return action(`/api/groups/${encodeURIComponent(stop.dataset.stopGroup)}/stop`, 'Текущая нода продолжит работу, остальные будут пропущены. Остановить очередь?');
  const node = event.target.closest('[data-start-node]'); if (node) return action(`/api/nodes/${encodeURIComponent(node.dataset.startNode)}/start`, 'Запустить full compaction этой ноды?');
  const testNode = event.target.closest('[data-test-node]');
  if (testNode) return void (async () => {
    if (!await saveSettings(false)) return;
    try {
      const result = await request(`/api/nodes/${encodeURIComponent(testNode.dataset.testNode)}/test`, {method:'POST'});
      toast(result.online ? `API ноды доступен · ${result.latencyMs} мс. Ключ проверится при запуске.` : `Нода недоступна: ${result.error}`, !result.online);
    } catch (error) { toast(error.message, true); }
  })();
  const copy = event.target.closest('[data-copy]'); if (copy) navigator.clipboard.writeText(copy.dataset.copy).then(() => toast('Команда скопирована'));
  const deleteGroup = event.target.closest('[data-delete-group]');
  if (deleteGroup) {
    const target = deleteGroup.dataset.deleteGroup;
    if (state.settings.nodes.some(nodeItem => nodeItem.groupId === target)) return toast('Сначала перенесите или удалите ноды этой группы', true);
    if (state.settings.schedules.some(rule => rule.targetType === 'group' && rule.targetId === target)) return toast('Сначала удалите расписания этой группы', true);
    state.settings.groups = state.settings.groups.filter(item => item.id !== target);
    if (state.selectedSettingsGroup === target) state.selectedSettingsGroup = state.settings.groups[0]?.id || '';
    return renderSettings();
  }
  const deleteNode = event.target.closest('[data-delete-node]');
  if (deleteNode) {
    const target = deleteNode.dataset.deleteNode;
    if (state.settings.schedules.some(rule => rule.targetType === 'node' && rule.targetId === target)) return toast('Сначала удалите расписания этой ноды', true);
    state.settings.nodes = state.settings.nodes.filter(item => item.id !== target);
    if (state.editingNodeID === target) state.editingNodeID = '';
    return renderSettings();
  }
  const deleteSchedule = event.target.closest('[data-delete-schedule]');
  if (deleteSchedule) { state.settings.schedules = state.settings.schedules.filter(rule => rule.id !== deleteSchedule.dataset.deleteSchedule); return renderSchedules(); }
});

$('#refresh').addEventListener('click', () => loadDashboard());
$('#save-settings').addEventListener('click', () => saveSettings());
$('#save-schedules').addEventListener('click', () => saveSettings());
$('#add-group').addEventListener('click', () => { const group = {id:id(), name:'Новый диск'}; state.settings.groups.push(group); state.selectedSettingsGroup = group.id; state.filter.settingsGroups = ''; state.filter.settingsGroupPage = Math.ceil(state.settings.groups.length / 10); renderSettings(); $('#settings-disk-detail [data-field="name"]')?.select(); });
$('#add-node').addEventListener('click', () => {
  if (!state.settings.groups.length) return toast('Сначала добавьте физический диск', true);
  addNodeToGroup(state.selectedSettingsGroup || state.settings.groups[0].id);
});
$('#add-schedule').addEventListener('click', () => {
  if (!state.settings?.groups.length) return toast('Сначала добавьте физический диск', true);
  state.settings.schedules ||= [];
  state.settings.schedules.push({id:id(), name:'', enabled:true, targetType:'group', targetId:state.settings.groups[0].id, days:[1,2,3,4,5,6,0], at:'02:00'});
  state.filter.schedules = ''; state.filter.schedulePage = Math.ceil(state.settings.schedules.length / 20); renderSchedules();
  $$('#schedule-list [data-field="name"]').at(-1)?.focus();
});

const initialView = location.hash === '#settings' ? 'settings' : location.hash === '#schedule' ? 'schedule' : 'dashboard';
if (initialView !== 'dashboard') setView(initialView, false);
loadDashboard();
state.timer = setInterval(() => loadDashboard(true), 3000);
