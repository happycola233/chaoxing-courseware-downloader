import './core.js';
const C = globalThis.CoursewareCore;
const $ = id => document.getElementById(id);
const extension = Boolean(globalThis.chrome?.runtime?.id);
const demo = extension ? null : (await import('./preview-demo.js')).createDemo();
const embedded = new URLSearchParams(location.search).get('embedded') === '1';
const selected = new Set();
let state = { resources: [], jobs: [], settings: {} }, tabs = [], chapters = [];
let scanning = false, stopScan = false, refreshing = false, copying = false, initialized = false;
let version = '', queueVersion = '', currentTab = Number(new URLSearchParams(location.search).get('tab')) || null;
const labels = { pending: '等待', resolving: '获取地址', downloading: '下载中', done: '已完成', failed: '失败', cancelled: '已取消' };

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function icon(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', {
    download: 'M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4',
    copy: 'M9 9h11v11H9zM15 5V3H3v12h2',
    close: 'm6 6 12 12M6 18 18 6'
  }[kind]);
  svg.append(path); return svg;
}
function iconButton(kind, title, action) {
  const el = node('button', 'icon-button'); el.title = title; el.setAttribute('aria-label', title); el.append(icon(kind));
  el.addEventListener('click', () => guarded(action)); return el;
}
async function request(type, options = {}) {
  const message = { type, ...options };
  const reply = demo ? await demo.request(message) : await chrome.runtime.sendMessage(message);
  if (!reply?.ok) throw new Error(reply?.error || '扩展未响应，请重新加载扩展并刷新课程页。');
  return reply.data;
}
function notify(text, error = false) { $('notice').textContent = text; $('notice').hidden = !text; $('notice').classList.toggle('error', error); }
async function guarded(fn) { try { await fn(); } catch (error) { notify(C.safeError(error), true); } }
function on(id, fn, event = 'click') { $(id).addEventListener(event, () => guarded(fn)); }
function tabId() { if (!Number.isInteger(currentTab)) throw new Error('请先打开已登录的超星课程页。'); return currentTab; }
function bytes(value) { if (!value) return ''; const mb = value / 1024 / 1024; return mb < 1 ? Math.round(value / 1024) + ' KB' : mb.toFixed(1) + ' MB'; }
function resources() { return state.resources.filter(r => r.sourceTabId === currentTab); }
function visibleResources() {
  const query = $('search').value.trim().toLocaleLowerCase();
  return resources().filter(r => (!$('typeFilter').value || r.type === $('typeFilter').value) && (!query || [r.name, r.chapter, r.course].join(' ').toLocaleLowerCase().includes(query)));
}
function counts() {
  const list = visibleResources(), count = resources().filter(r => selected.has(r.key)).length;
  $('selectedCount').textContent = count ? '已选 ' + count + ' 个' : '未选择文件';
  $('copySelected').disabled = !count || copying;
  $('downloadSelected').disabled = !count;
  $('fileCount').textContent = list.length + ' 个文件';
  const checked = list.filter(r => selected.has(r.key)).length;
  $('selectAll').checked = list.length > 0 && checked === list.length;
  $('selectAll').indeterminate = checked > 0 && checked < list.length;
  $('selectAll').disabled = !list.length;
}
function renderResources() {
  const fragment = document.createDocumentFragment();
  const list = visibleResources();
  for (const r of list) {
    const row = node('div', 'file-row'), check = node('input'); check.type = 'checkbox'; check.checked = selected.has(r.key); check.setAttribute('aria-label', '选择 ' + r.name);
    check.addEventListener('change', () => { if (check.checked) selected.add(r.key); else selected.delete(r.key); counts(); });
    const info = node('div', 'file-info'), title = node('span', 'file-name', r.name); title.title = r.name;
    const job = state.jobs.findLast(j => j.resource.key === r.key);
    info.append(title, node('span', 'file-meta', [r.chapter || '当前页面', bytes(r.size), job ? labels[job.status] : ''].filter(Boolean).join(' · ')));
    const actions = node('div', 'file-actions');
    actions.append(iconButton('copy', '复制 ' + r.name + ' 的链接', () => copyLinks([r.key])), iconButton('download', '下载 ' + r.name, () => download([r.key])));
    row.append(check, info, actions); fragment.append(row);
  }
  $('resourceRows').replaceChildren(fragment); $('emptyLibrary').hidden = list.length > 0;
  if (resources().length && !list.length) $('emptyLibrary').textContent = '没有匹配的文件';
  else $('emptyLibrary').replaceChildren(document.createTextNode('没有识别到课件'), node('small', '', '课程首页可使用“按章节扫描”'));
  counts();
}
function renderQueue() {
  const fragment = document.createDocumentFragment();
  for (const job of state.jobs.slice().reverse()) {
    const row = node('div', 'job'), line = node('div', 'job-line');
    const title = node('span', '', job.resource.name); title.title = job.resource.name;
    line.append(title, node('small', '', labels[job.status])); row.append(line);
    if (job.status === 'downloading') { const bar = node('progress'); bar.max = job.totalBytes || 1; bar.value = job.bytesReceived || 0; row.append(bar); }
    if (job.error) row.append(node('small', 'failure', job.error));
    if (job.status === 'done' && Number.isInteger(job.downloadId)) {
      const show = node('button', 'quiet', '显示文件'); show.addEventListener('click', () => guarded(() => request('SHOW_FILE', { id: job.id }))); row.append(show);
    }
    fragment.append(row);
  }
  if (!state.jobs.length) fragment.append(node('small', 'hint', '还没有下载记录'));
  $('queueRows').replaceChildren(fragment);
  const active = state.jobs.filter(j => ['pending', 'resolving', 'downloading'].includes(j.status)).length;
  const failed = state.jobs.filter(j => j.status === 'failed').length;
  $('queueCount').textContent = active ? active + ' 项进行中' : failed ? failed + ' 项失败' : state.jobs.length ? state.jobs.length + ' 项' : '';
  $('pauseQueue').textContent = state.paused ? '继续全部' : '暂停全部';
}
async function refreshState(force = false) {
  if (refreshing) return; refreshing = true;
  try {
    state = await request('STATE');
    const next = JSON.stringify([state.resources, state.jobs.map(j => [j.id, j.status]), currentTab]);
    if (force || next !== version) { version = next; const keys = new Set(resources().map(r => r.key)); for (const key of selected) if (!keys.has(key)) selected.delete(key); renderResources(); }
    const nextQueue = JSON.stringify([state.jobs, state.paused]);
    if (force || nextQueue !== queueVersion) { queueVersion = nextQueue; renderQueue(); }
    $('subtitle').textContent = resources().find(r => r.course)?.course || tabs.find(t => t.id === currentTab)?.title || '请先打开课程页';
  } finally { refreshing = false; }
}
async function refreshTabs() {
  tabs = await request('TABS');
  if (!tabs.some(t => t.id === currentTab)) currentTab = tabs.find(t => t.active)?.id || tabs[0]?.id || null;
  $('sourceTab').replaceChildren(...tabs.map(t => { const el = node('option', '', t.title); el.value = t.id; return el; }));
  if (currentTab !== null) $('sourceTab').value = String(currentTab);
  else $('sourceTab').append(node('option', '', '未找到超星课程页面'));
}
function fillSettings() {
  for (const key of ['folder', 'format', 'concurrency', 'retries']) $(key).value = state.settings[key];
  for (const key of ['organize', 'saveAs']) $(key).checked = state.settings[key];
}
async function scanTask(fn) {
  if (scanning) return;
  scanning = true; stopScan = false;
  for (const id of ['scanCurrent', 'scanCatalog', 'scanTabs', 'startChapterScan', 'sourceTab']) $(id).disabled = true;
  $('stopScan').hidden = false;
  try { await fn(); } finally {
    scanning = false; $('stopScan').hidden = true;
    for (const id of ['scanCurrent', 'scanCatalog', 'scanTabs', 'startChapterScan', 'sourceTab']) $(id).disabled = false;
    await refreshState(true);
  }
}
function showCatalog(value) { $('catalog').hidden = !value; $('library').hidden = value; }
async function openCatalog() {
  const data = await request('CATALOG', { tabId: tabId() }); chapters = data.chapters || [];
  if (!chapters.length) throw new Error('未找到可扫描目录，请打开课程的“章节”页，或进入任意课时再试。');
  $('chapterList').replaceChildren(...chapters.map(chapter => {
    const row = node('label', 'chapter-row'), check = node('input'); check.type = 'checkbox'; check.value = chapter.id; check.disabled = chapter.locked; check.checked = !chapter.locked;
    row.append(check, node('span', '', chapter.name + (chapter.locked ? '（未开放）' : ''))); return row;
  }));
  $('allChapters').checked = true; showCatalog(true);
}
async function scanCurrent() {
  let found = 0;
  await scanTask(async () => {
    notify('正在识别课件…'); const data = await request('SCAN_TAB', { tabId: tabId() }); found = data.count;
    notify(found ? '识别到 ' + found + ' 个文件' : '当前是目录或暂无预览，正在读取章节列表…');
  });
  if (!found) await openCatalog(); else showCatalog(false);
}
async function scanChapters() {
  const checked = new Set([...$('chapterList').querySelectorAll('input:checked')].map(el => el.value));
  const chosen = chapters.filter(c => checked.has(c.id) && !c.locked);
  if (!chosen.length) throw new Error('请至少选择一个章节。');
  showCatalog(false);
  await scanTask(async () => {
    let found = 0; const failures = [];
    for (const [index, chapter] of chosen.entries()) {
      if (stopScan) break;
      notify('扫描 ' + (index + 1) + '/' + chosen.length + ' · ' + chapter.name);
      try { found += (await request('SCAN_CHAPTER', { tabId: tabId(), chapter })).count; }
      catch (error) { failures.push(chapter.name + '：' + C.safeError(error)); }
      await refreshState(true);
      if (index + 1 < chosen.length && !stopScan) await new Promise(resolve => setTimeout(resolve, 650));
    }
    notify((stopScan ? '扫描已停止，' : '扫描完成，') + '识别 ' + found + ' 个文件' + (failures.length ? '\n' + failures.join('\n') : ''), failures.length > 0);
  });
}
async function download(keys) {
  const data = await request('DOWNLOAD', { keys });
  notify(data.count ? data.count + ' 个文件已加入下载队列' : '文件已在队列中或已完成；可清理记录后再次下载。');
  await refreshState(true); $('queueDetails').open = true;
}
async function copyLinks(keys) {
  if (copying) return; copying = true; counts();
  try {
    const links = [], failures = [];
    for (let index = 0; index < keys.length; index += 3) {
      notify('正在获取链接 ' + Math.min(index + 3, keys.length) + '/' + keys.length + '…');
      const data = await request('COPY_LINKS', { keys: keys.slice(index, index + 3) }); links.push(...data.links); failures.push(...data.failures);
    }
    if (!links.length) throw new Error(failures.join('\n') || '没有可复制的链接。');
    const text = links.map(item => item.url).join('\n');
    try { await navigator.clipboard.writeText(text); $('copyFallbackBox').hidden = true; }
    catch { $('copyFallback').value = text; $('copyFallbackBox').hidden = false; $('copyFallback').focus(); $('copyFallback').select(); }
    notify('已准备 ' + links.length + ' 个链接' + ($('copyFallbackBox').hidden ? '并复制到剪贴板' : '，请在下方手动复制') + (failures.length ? '\n' + failures.join('\n') : ''), failures.length > 0);
  } finally { copying = false; counts(); }
}
function closePanel() {
  if (embedded) {
    try { window.parent.postMessage('courseware-close', new URL(document.referrer).origin); } catch { /* No embedding document. */ }
  } else if (extension) window.close();
}
on('closePanel', closePanel); $('closePanel').append(icon('close')); $('closePanel').hidden = !extension && !embedded;
document.addEventListener('keydown', event => { if (event.key === 'Escape') closePanel(); });
on('refreshTabs', async () => { await refreshTabs(); await refreshState(true); });
on('sourceTab', async () => { currentTab = Number($('sourceTab').value); selected.clear(); showCatalog(false); await refreshState(true); }, 'change');
on('scanCurrent', scanCurrent); on('scanCatalog', openCatalog); on('startChapterScan', scanChapters);
on('closeCatalog', () => showCatalog(false));
on('allChapters', () => $('chapterList').querySelectorAll('input:not(:disabled)').forEach(el => { el.checked = $('allChapters').checked; }), 'change');
on('stopScan', () => { stopScan = true; notify('将在当前章节读取结束后停止…'); });
on('selectAll', () => { for (const r of visibleResources()) { if ($('selectAll').checked) selected.add(r.key); else selected.delete(r.key); } renderResources(); }, 'change');
on('search', renderResources, 'input'); on('typeFilter', renderResources, 'change');
on('downloadSelected', () => download([...selected])); on('copySelected', () => copyLinks([...selected]));
on('closeFallback', () => { $('copyFallbackBox').hidden = true; });
on('saveSettings', async () => {
  await request('COMMAND', { action: 'settings', payload: { folder: $('folder').value, format: $('format').value, concurrency: Number($('concurrency').value), retries: Number($('retries').value), organize: $('organize').checked, saveAs: $('saveAs').checked } });
  await refreshState(); fillSettings(); notify('设置已保存');
});
for (const [id, action] of [['retryQueue', 'retry'], ['cancelQueue', 'cancel'], ['clearFinished', 'clearFinished'], ['clearLibrary', 'clearLibrary']]) on(id, async () => { await request('COMMAND', { action }); await refreshState(true); });
on('pauseQueue', async () => { await request('COMMAND', { action: state.paused ? 'resume' : 'pause' }); await refreshState(true); });
on('scanTabs', () => scanTask(async () => {
  let count = 0; const failures = [];
  for (const [index, tab] of tabs.entries()) {
    if (stopScan) break; notify('扫描页面 ' + (index + 1) + '/' + tabs.length);
    try { count += (await request('SCAN_TAB', { tabId: tab.id })).count; } catch (error) { failures.push(C.safeError(error)); }
  }
  notify('已识别 ' + count + ' 个文件。通过来源页面选择框查看。' + (failures.length ? '\n' + failures.join('\n') : ''), failures.length > 0);
}));
on('exportManifest', () => {
  const items = selected.size ? resources().filter(r => selected.has(r.key)) : visibleResources();
  if (!items.length) throw new Error('请先扫描课件。');
  const url = URL.createObjectURL(new Blob([JSON.stringify(C.publicManifest(items), null, 2)], { type: 'application/json;charset=utf-8' }));
  const a = node('a'); a.href = url; a.download = 'courseware-manifest.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
});
$('sourceRow').hidden = embedded;
if (embedded) $('scanTabs').hidden = true;
document.body.classList.toggle('embedded', embedded);
if (demo) { if (!embedded) document.body.classList.add('preview'); $('demoBanner').hidden = false; }
await guarded(async () => {
  await refreshTabs(); await refreshState(true); fillSettings(); initialized = true;
  if (extension && currentTab && !resources().length) await scanCurrent();
});
setInterval(() => { if (initialized && document.visibilityState === 'visible') void guarded(refreshState); }, 2500);
window.addEventListener('beforeunload', event => { if (scanning) { event.preventDefault(); event.returnValue = ''; } });
