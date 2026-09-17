import './core.js';
const C = globalThis.CoursewareCore;
const $ = id => document.getElementById(id);
const isExtension = Boolean(globalThis.chrome?.runtime?.id);
const demo = isExtension ? null : (await import('./preview-demo.js')).createDemo();
const selected = new Set();
let state = { resources: [], jobs: [], settings: {} };
let tabs = [], chapters = [], scanning = false, stopScan = false, refreshing = false;
let resourceVersion = '', queueVersion = '', activeView = 'library';
const labels = { pending: '等待下载', resolving: '获取地址', downloading: '下载中', done: '已完成', failed: '失败', cancelled: '已取消' };

async function request(type, options = {}) {
  const response = demo ? await demo.request({ type, ...options }) : await chrome.runtime.sendMessage({ type, ...options });
  if (!response?.ok) throw new Error(response?.error || '扩展后台未响应，请在扩展管理页重新加载。');
  return response.data;
}

function notify(text, error = false) {
  $('notice').hidden = !text;
  $('notice').textContent = text;
  $('notice').classList.toggle('error', error);
}

function bytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '大小未知';
  const units = ['B', 'KB', 'MB', 'GB'];
  let index = 0;
  while (value >= 1024 && index < 3) { value /= 1024; index++; }
  return value.toFixed(index ? 1 : 0) + ' ' + units[index];
}

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function jobFor(key) { return state.jobs.findLast(j => j.resource.key === key); }
function visibleResources() {
  const search = $('search').value.trim().toLocaleLowerCase();
  return state.resources.filter(r =>
    (!$('typeFilter').value || r.type === $('typeFilter').value) &&
    (!$('courseFilter').value || r.course === $('courseFilter').value) &&
    (!search || [r.name, r.course, r.chapter].join(' ').toLocaleLowerCase().includes(search))
  );
}

function renderStats() {
  const chosen = state.resources.filter(r => selected.has(r.key));
  $('totalCount').textContent = state.resources.length;
  $('navCount').textContent = state.resources.length;
  $('selectedCount').textContent = chosen.length;
  $('selectedSize').textContent = chosen.length ? bytes(chosen.reduce((sum, r) => sum + r.size, 0)) + (chosen.some(r => !r.size) ? ' + 未知大小' : '') : '等待选择文件';
  $('doneCount').textContent = state.jobs.filter(j => j.status === 'done').length;
  $('queueCount').textContent = state.jobs.filter(j => ['pending', 'resolving', 'downloading'].includes(j.status)).length;
  $('downloadCount').textContent = chosen.length;
  $('downloadSelected').disabled = !chosen.length;
  $('copySelected').disabled = !chosen.length;
  const visible = visibleResources();
  const selectedVisible = visible.filter(r => selected.has(r.key)).length;
  $('selectAll').checked = visible.length > 0 && selectedVisible === visible.length;
  $('selectAll').indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
  $('selectAll').disabled = !visible.length;
  $('visibleCount').textContent = visible.length === state.resources.length ? '' : visible.length + ' 个筛选结果';
}

function renderResources() {
  const container = $('resourceRows');
  const fragment = document.createDocumentFragment();
  const visible = visibleResources();
  for (const resource of visible) {
    const row = node('tr', selected.has(resource.key) ? 'selected' : '');
    const checkboxCell = node('td', 'check-col');
    const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(resource.key);
    checkbox.setAttribute('aria-label', '选择 ' + resource.name);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selected.add(resource.key); else selected.delete(resource.key);
      row.classList.toggle('selected', checkbox.checked); renderStats();
    });
    checkboxCell.append(checkbox);
    const nameCell = node('td');
    const file = node('div', 'file-cell');
    file.append(node('div', 'file-icon ' + resource.type, (resource.ext || 'FILE').toUpperCase()));
    const names = node('div');
    const name = node('span', 'file-title', resource.name); name.title = resource.name;
    names.append(name, node('div', 'file-sub', resource.url ? '已识别文件地址' : '下载时解析原文件'));
    file.append(names); nameCell.append(file);
    const chapter = node('td', 'chapter-cell', resource.course || '课程附件');
    chapter.append(node('small', '', resource.chapter || '当前页面'));
    chapter.title = [resource.course, resource.chapter].filter(Boolean).join(' / ');
    const status = node('td'); const job = jobFor(resource.key);
    status.append(node('span', 'status-tag ' + (job?.status || ''), job ? labels[job.status] : (resource.url ? '待下载' : '待解析')));
    const action = node('td');
    const copy = node('button', 'text-button', '复制链接');
    copy.setAttribute('aria-label', '复制 ' + resource.name + ' 的链接');
    copy.addEventListener('click', () => guarded(() => copyLinks([resource.key])));
    const source = node('button', 'row-button', '↗'); source.title = '返回来源课程标签页'; source.setAttribute('aria-label', '返回 ' + resource.name + ' 的来源页面');
    source.addEventListener('click', () => guarded(() => request('OPEN_SOURCE', { key: resource.key })));
    action.append(copy, source);
    row.append(checkboxCell, nameCell, chapter, node('td', 'file-size', bytes(resource.size)), status, action);
    fragment.append(row);
  }
  container.replaceChildren(fragment);
  $('emptyLibrary').hidden = visible.length > 0;
  $('emptyLibrary').querySelector('h3').textContent = state.resources.length ? '没有匹配的课件' : '从第一份课件开始';
  $('emptyLibrary').querySelector('p').textContent = state.resources.length ? '调整搜索词、文件类型或课程筛选后再试。' : '扫描课程页面后，PDF、PPT、文档等文件会出现在这里。选择需要的文件，交给下载队列。';
  renderStats();
}

function renderQueue() {
  const fragment = document.createDocumentFragment();
  for (const job of [...state.jobs].reverse()) {
    const item = node('article', 'queue-item');
    item.append(node('div', 'file-icon ' + job.resource.type, (job.resource.ext || 'FILE').toUpperCase()));
    const main = node('div', 'queue-main');
    const title = node('div', 'queue-title');
    title.append(node('span', '', job.resource.name), node('span', 'status-tag ' + job.status, job.browserPaused && job.status === 'downloading' ? '已暂停' : labels[job.status]));
    const info = node('div', 'queue-info');
    info.append(node('span', '', [job.resource.course, job.resource.chapter].filter(Boolean).join(' / ')), node('span', '', job.status === 'done' ? bytes(job.totalBytes || job.resource.size) : (job.bytesReceived ? bytes(job.bytesReceived) : '0 B') + ' / ' + bytes(job.totalBytes)));
    const progress = node('progress'); progress.max = 100;
    if (job.status === 'resolving' || (job.status === 'downloading' && !job.totalBytes)) progress.removeAttribute('value');
    else progress.value = job.status === 'done' ? 100 : job.totalBytes ? Math.min(100, job.bytesReceived / job.totalBytes * 100) : 0;
    progress.setAttribute('aria-label', job.resource.name + ' 下载进度');
    main.append(title, info, progress);
    if (job.error) main.append(node('div', 'queue-error', job.error + (job.status === 'pending' ? '（等待自动重试）' : '')));
    item.append(main);
    if (job.status === 'done') {
      const show = node('button', 'text-button', '显示文件');
      show.addEventListener('click', () => guarded(() => request('SHOW_FILE', { id: job.id }))); item.append(show);
    }
    fragment.append(item);
  }
  $('queueRows').replaceChildren(fragment);
  $('emptyQueue').hidden = state.jobs.length > 0;
  const done = state.jobs.filter(j => j.status === 'done').length;
  const failed = state.jobs.filter(j => j.status === 'failed').length;
  $('queueSummary').textContent = state.jobs.length ? state.jobs.length + ' 个任务 · ' + done + ' 已完成 · ' + failed + ' 失败' : '暂无下载任务';
  $('pauseQueue').textContent = state.paused ? '继续队列' : '暂停队列';
}

function syncCourses() {
  const previous = $('courseFilter').value;
  $('courseFilter').replaceChildren(new Option('全部课程', ''));
  for (const course of [...new Set(state.resources.map(r => r.course).filter(Boolean))]) $('courseFilter').append(new Option(course, course));
  if ([...$('courseFilter').options].some(o => o.value === previous)) $('courseFilter').value = previous;
}

async function refreshState(force = false) {
  if (refreshing) return;
  refreshing = true;
  try {
    state = await request('STATE');
    for (const key of selected) if (!state.resources.some(r => r.key === key)) selected.delete(key);
    const rv = JSON.stringify([state.resources, state.jobs.map(j => [j.resource.key, j.status])]);
    if (force || rv !== resourceVersion) { resourceVersion = rv; syncCourses(); renderResources(); }
    const qv = JSON.stringify([state.jobs, state.paused]);
    if (force || qv !== queueVersion) { queueVersion = qv; renderQueue(); }
    renderStats();
  } finally { refreshing = false; }
}

async function refreshTabs() {
  const previous = $('sourceTab').value || new URL(location.href).searchParams.get('tab');
  tabs = await request('TABS');
  $('sourceTab').replaceChildren();
  if (!tabs.length) $('sourceTab').append(new Option('未找到超星页面，请先在 Chrome 打开课程', ''));
  for (const [index, tab] of tabs.entries()) $('sourceTab').append(new Option((index + 1) + '. ' + tab.title + ' · ' + tab.host, tab.id));
  if (tabs.some(t => String(t.id) === previous)) $('sourceTab').value = previous;
  updateScanButtons();
}

function updateScanButtons() {
  for (const id of ['scanCurrent', 'scanCatalog', 'scanTabs', 'refreshTabs']) $(id).disabled = scanning || (!tabs.length && id !== 'refreshTabs');
  $('sourceTab').disabled = scanning;
}

function tabId() {
  const value = Number($('sourceTab').value);
  if (!value) throw new Error('请先在 Chrome 打开课程页面，然后刷新页面列表。');
  return value;
}

async function scanningTask(task) {
  if (scanning) return;
  scanning = true; stopScan = false; updateScanButtons();
  $('scanProgress').hidden = false; $('scanStatus').textContent = '正在读取课件…'; notify('');
  try { await task(); }
  finally { scanning = false; updateScanButtons(); $('scanProgress').hidden = true; await refreshState(true); }
}

async function openCatalog() {
  const context = await request('CATALOG', { tabId: tabId() });
  chapters = context.chapters;
  if (!chapters.length) throw new Error('当前页面未提供可扫描的章节目录。请回到学生学习页面，展开目录后重试。');
  $('chapterList').replaceChildren();
  for (const chapter of chapters) {
    const label = node('label'); const input = node('input'); input.type = 'checkbox'; input.value = chapter.id; input.disabled = chapter.locked; input.checked = !chapter.locked;
    label.append(input, node('span', '', chapter.name + (chapter.locked ? '（未开放）' : ''))); $('chapterList').append(label);
  }
  $('selectAllChapters').checked = true;
  $('chapterDialog').showModal();
}

async function scanChapters() {
  const keys = new Set([...$('chapterList').querySelectorAll('input:checked')].map(e => e.value));
  const chosen = chapters.filter(c => keys.has(c.id) && !c.locked);
  if (!chosen.length) { notify('请选择至少一个章节。', true); return; }
  const source = tabId();
  $('chapterDialog').close();
  await scanningTask(async () => {
    let count = 0, completed = 0; const failures = [];
    for (const chapter of chosen) {
      if (stopScan) break;
      $('scanStatus').textContent = '正在读取 ' + (completed + 1) + ' / ' + chosen.length + ' · ' + chapter.name;
      try { const result = await request('SCAN_CHAPTER', { tabId: source, chapter }); count += result.count; }
      catch (error) { failures.push(chapter.name + '：' + C.safeError(error)); }
      completed++;
      await refreshState(true);
      if (!stopScan && completed < chosen.length) await new Promise(resolve => setTimeout(resolve, 900));
    }
    notify((stopScan ? '已停止。' : '目录扫描结束。') + '处理 ' + completed + ' 个章节，识别 ' + count + ' 个文件（入库时自动去重）。' + (failures.length ? '\n' + failures.join('\n') : ''), failures.length > 0);
  });
}

function setView(view) {
  activeView = view;
  for (const name of ['library', 'queue', 'help']) $(name + 'View').hidden = view !== name;
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  const text = { library: ['你的课件，收纳在一起。', '从课程页面发现原始文件，按需要选择，一次下载。'], queue: ['下载有进度，资料有归处。', '查看进度、暂停队列，或重新尝试未完成的下载。'], help: ['用得顺手，也用得安心。', '了解扫描方式、文件保存位置和本地隐私设置。'] }[view];
  $('viewTitle').textContent = text[0]; $('viewDescription').textContent = text[1];
}

function fillSettings() {
  for (const key of ['folder', 'concurrency', 'retries', 'format']) $(key).value = state.settings[key];
  for (const key of ['organize', 'saveAs']) $(key).checked = state.settings[key];
  $('settingsSummary').textContent = (state.settings.organize ? '按课程与章节归档' : '保存在同一文件夹') + ' · ' + state.settings.concurrency + ' 个并行任务';
}

async function guarded(action) {
  try { return await action(); } catch (error) { notify(C.safeError(error), true); }
}

async function copyLinks(keys) {
  if (!keys.length) throw new Error('请先勾选需要复制的文件。');
  notify('正在准备 ' + keys.length + ' 个文件链接…');
  const links = [], failures = [];
  // Small batches keep a large copy operation below the service-worker event limit.
  for (let i = 0; i < keys.length; i += 3) {
    const result = await request('COPY_LINKS', { keys: keys.slice(i, i + 3) });
    links.push(...result.links); failures.push(...result.failures);
  }
  if (!links.length) throw new Error(failures.join('\n') || '未获取到可复制的链接，请打开课件后重新扫描。');
  const text = links.map(link => link.url).join('\n');
  let copied = false;
  try { await navigator.clipboard.writeText(text); copied = true; }
  catch {
    $('copyFallback').value = text; $('copyDialog').showModal(); $('copyFallback').focus(); $('copyFallback').select();
  }
  notify((copied ? '已复制 ' : '已准备 ') + links.length + ' 个链接，每行一个。部分地址带临时签名，请勿公开分享。' + (failures.length ? '\n未获取：' + failures.join('\n') : ''), failures.length > 0);
}
function on(id, action, event = 'click') { $(id).addEventListener(event, () => guarded(action)); }

on('refreshTabs', refreshTabs);
on('scanCurrent', () => scanningTask(async () => {
  const data = await request('SCAN_TAB', { tabId: tabId() });
  notify(data.count ? '已从 ' + data.frames + ' 个页面框架识别 ' + data.count + ' 个文件，已加入课件库。' : '暂未识别到课件。请等预览加载完成后重扫，或尝试具体章节。', !data.count);
}));
on('scanCatalog', openCatalog);
on('startChapterScan', scanChapters);
on('scanTabs', () => scanningTask(async () => {
  let count = 0; const errors = [];
  for (const [index, tab] of tabs.entries()) {
    if (stopScan) break;
    $('scanStatus').textContent = '正在扫描页面 ' + (index + 1) + ' / ' + tabs.length;
    try { count += (await request('SCAN_TAB', { tabId: tab.id })).count; }
    catch (error) { errors.push('页面 ' + (index + 1) + '：' + C.safeError(error)); }
  }
  notify('扫描' + (stopScan ? '已停止' : '完成') + '，识别 ' + count + ' 个文件（入库时自动去重）。' + (errors.length ? '\n' + errors.join('\n') : ''), errors.length > 0);
}));
on('stopScan', () => { stopScan = true; $('scanStatus').textContent = '将在当前章节读取结束后停止…'; });
on('selectAllChapters', () => $('chapterList').querySelectorAll('input:not(:disabled)').forEach(input => { input.checked = $('selectAllChapters').checked; }), 'change');
on('selectAll', () => { for (const r of visibleResources()) { if ($('selectAll').checked) selected.add(r.key); else selected.delete(r.key); } renderResources(); }, 'change');
for (const id of ['search', 'typeFilter', 'courseFilter']) on(id, renderResources, id === 'search' ? 'input' : 'change');
on('downloadSelected', async () => {
  const result = await request('DOWNLOAD', { keys: [...selected] });
  notify(result.count ? result.count + ' 个文件已加入下载队列。' : '所选文件已在队列中，或已经下载完成。');
  await refreshState(true); setView('queue');
});
on('copySelected', () => copyLinks([...selected]));
on('saveSettings', async () => {
  await request('COMMAND', { action: 'settings', payload: { folder: $('folder').value, concurrency: Number($('concurrency').value), retries: Number($('retries').value), organize: $('organize').checked, saveAs: $('saveAs').checked, format: $('format').value } });
  await refreshState(); fillSettings(); notify('下载偏好已保存，对后续启动的任务生效。');
});
for (const [id, action] of [['retryQueue', 'retry'], ['cancelQueue', 'cancel'], ['clearFinished', 'clearFinished'], ['clearLibrary', 'clearLibrary']]) {
  on(id, async () => { await request('COMMAND', { action }); await refreshState(true); });
}
on('pauseQueue', async () => { await request('COMMAND', { action: state.paused ? 'resume' : 'pause' }); await refreshState(true); });
on('exportManifest', () => {
  const resources = selected.size ? state.resources.filter(r => selected.has(r.key)) : visibleResources();
  if (!resources.length) throw new Error('请先扫描课件，再导出清单。');
  const blob = new Blob([JSON.stringify(C.publicManifest(resources), null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob); const a = node('a'); a.href = url; a.download = 'courseware-manifest-' + new Date().toISOString().slice(0, 10) + '.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  notify('已导出文件清单，不包含链接或账号标识。文件、课程和章节名称会保留，公开前请自行检查。');
});
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
if (demo) $('demoBanner').hidden = false;
await guarded(async () => { await Promise.all([refreshTabs(), refreshState(true)]); fillSettings(); });
setInterval(() => { if (document.visibilityState === 'visible') void guarded(() => refreshState()); }, 2500);
window.addEventListener('beforeunload', event => { if (scanning) { event.preventDefault(); event.returnValue = ''; } });
