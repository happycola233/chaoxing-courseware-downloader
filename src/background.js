import './core.js';
import { DownloadQueue } from './queue.js';
const C = globalThis.CoursewareCore;
const ALARM = 'courseware-queue';
const SITE_PATTERNS = ['*://*.chaoxing.com/*', '*://*.chaoxing.com.cn/*'];

function ruleId(id) {
  let hash = 0;
  for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return 1000 + hash % 1_000_000_000;
}

async function prepare(job, referrerPath = '/') {
  const url = C.allowedUrl(job.resource.url);
  const source = C.allowedUrl(job.resource.sourceUrl);
  if (!url || !source) return;
  // Use only the origin, so signed preview/account parameters never go to the CDN.
  const referer = new URL(source).origin + referrerPath;
  const id = ruleId(job.id);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [{
      id, priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: referer }] },
      condition: {
        regexFilter: '^' + url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$',
        tabIds: [-1], requestMethods: ['get'], resourceTypes: ['other', 'xmlhttprequest']
      }
    }]
  });
}

async function cleanup(id) {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId(id)] });
}

async function requireTab(tabId) {
  if (!Number.isInteger(tabId)) throw new Error('请先选择一个已登录的课程标签页。');
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { throw new Error('来源标签页已关闭，请重新选择课程页面。'); }
  const url = C.allowedUrl(tab.url);
  if (!url || new URL(url).hostname.endsWith('cldisk.com')) throw new Error('请选择超星课程或课件预览页面。');
  return tab;
}

async function inject(tabId, allFrames = false) {
  await requireTab(tabId);
  return chrome.scripting.executeScript({ target: { tabId, allFrames }, files: ['src/core.js', 'src/page.js'] });
}

async function pageCall(tabId, operation, argument, frameId = 0) {
  await inject(tabId, frameId !== 0);
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: async (op, arg) => {
      try { return { ok: true, data: await globalThis.CoursewarePage[op](arg) }; }
      catch (error) { return { ok: false, error: globalThis.CoursewareCore.safeError(error) }; }
    }, args: [operation, argument ?? null]
  });
  const result = results[0]?.result;
  if (!result?.ok) throw new Error(result?.error || '页面未响应，请刷新课程页重试。');
  return result.data;
}

async function resolveResource(resource, settings = {}) {
  if (resource.objectId && Number.isInteger(resource.sourceTabId)) {
    try { return C.transferResource(await pageCall(resource.sourceTabId, 'resolve', resource), settings); }
    catch (error) { if (!resource.url) throw error; }
  }
  if (resource.url) return C.transferResource(resource, settings);
  throw new Error('需要打开来源课件页面以获取下载地址。');
}

const queue = new DownloadQueue({
  load: async () => {
    const [session, local] = await Promise.all([chrome.storage.session.get('state'), chrome.storage.local.get('settings')]);
    return { state: session.state, settings: local.settings };
  },
  save: async (state, settings) => {
    await chrome.storage.session.set({ state });
    await chrome.storage.local.set({ settings });
    const active = state.jobs.filter(j => ['pending', 'resolving', 'downloading'].includes(j.status)).length;
    await chrome.action.setBadgeText({ text: active ? String(active) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#177669' });
  },
  download: options => chrome.downloads.download(options),
  search: async id => (await chrome.downloads.search({ id }))[0],
  recover: async job => {
    const matches = await chrome.downloads.search({ url: job.resource.url, startedAfter: new Date(job.startedAt - 1000).toISOString(), limit: 5 });
    return matches.find(item => item.byExtensionId === chrome.runtime.id);
  },
  pause: id => chrome.downloads.pause(id),
  resume: id => chrome.downloads.resume(id),
  cancel: id => chrome.downloads.cancel(id),
  prepare, cleanup, resolve: resolveResource
});

async function pump() {
  try { await queue.pump(); }
  catch (error) { console.warn('下载队列：' + C.safeError(error)); }
}

async function ensureAlarm() {
  if (!await chrome.alarms.get(ALARM)) await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(() => { void ensureAlarm(); });
chrome.runtime.onStartup.addListener(() => { void ensureAlarm(); void pump(); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void pump(); });
chrome.downloads.onChanged.addListener(delta => {
  if (delta.state || delta.error || delta.paused) void pump();
});

async function scanTab(tabId) {
  const results = await inject(tabId, true);
  const frames = results.map(r => r.result).filter(Boolean);
  const course = frames.find(f => f.course)?.course || '';
  const chapter = frames.find(f => f.chapter)?.chapter || '';
  const resources = C.mergeResources(frames.flatMap(f => (f.resources || []).map(r => ({
    ...r, sourceTabId: tabId, course: r.course || course, chapter: r.chapter || chapter
  }))));
  await queue.addResources(resources);
  return { count: resources.length, frames: frames.length, course, chapter };
}

async function handle(message) {
  switch (message.type) {
    case 'TABS': {
      const tabs = await chrome.tabs.query({ url: SITE_PATTERNS });
      return tabs.map(t => ({ id: t.id, title: t.title || '超星页面', host: new URL(t.url).hostname, active: t.active === true }));
    }
    case 'STATE': return queue.snapshot();
    case 'SCAN_TAB': return scanTab(message.tabId);
    case 'CATALOG': {
      const frames = await inject(message.tabId, true);
      for (const frame of frames) {
        try {
          const ctx = await pageCall(message.tabId, 'context', null, frame.frameId);
          if (ctx.chapters.length) return { chapters: ctx.chapters.map(c => ({ ...c, frameId: frame.frameId })), homepage: !ctx.cardsUrl };
        } catch { /* Continue through accessible frames. */ }
      }
      return { chapters: [] };
    }
    case 'SCAN_CHAPTER': {
      const data = await pageCall(message.tabId, 'scanChapter', message.chapter, message.chapter?.frameId || 0);
      await queue.addResources(data.resources.map(r => ({ ...r, sourceTabId: message.tabId })));
      return { count: data.resources.length, cards: data.cardCount };
    }
    case 'DOWNLOAD': {
      if (!Array.isArray(message.keys) || message.keys.length > 2000) throw new Error('选择的文件数量异常。');
      const count = await queue.enqueue(message.keys);
      void pump();
      return { count };
    }
    case 'COPY_LINKS': {
      if (!Array.isArray(message.keys) || message.keys.length > 2000) throw new Error('选择的文件数量异常。');
      const state = await queue.snapshot();
      const links = [], failures = [], fresh = [];
      for (const key of new Set(message.keys)) {
        const resource = state.resources.find(r => r.key === key);
        if (!resource) continue;
        try {
          const resolved = await resolveResource(resource, state.settings);
          if (!C.allowedUrl(resolved.url)) throw new Error('没有可复制的文件地址。');
          links.push({ name: resolved.name, url: resolved.url });
          // Keep raw library metadata intact when copying a converted PDF.
          fresh.push({ ...resource, pdfUrl: resolved.pdfUrl || resource.pdfUrl, originalUrl: resolved.originalUrl || resource.originalUrl });
        } catch (error) { failures.push(resource.name + '：' + C.safeError(error)); }
      }
      if (fresh.length) await queue.addResources(fresh);
      return { links, failures };
    }
    case 'COMMAND': {
      if (!['settings', 'pause', 'resume', 'retry', 'cancel', 'clearLibrary', 'clearFinished'].includes(message.action)) throw new Error('未知操作。');
      await queue.command(message.action, message.payload);
      void pump();
      return {};
    }
    case 'SHOW_FILE': {
      const state = await queue.snapshot();
      const job = state.jobs.find(j => j.id === message.id);
      if (!job || !Number.isInteger(job.downloadId)) throw new Error('此文件还没有下载记录。');
      await chrome.downloads.show(job.downloadId);
      return {};
    }
    case 'OPEN_SOURCE': {
      const state = await queue.snapshot();
      const resource = state.resources.find(r => r.key === message.key);
      if (!resource) throw new Error('资源已清空，请重新扫描。');
      await requireTab(resource.sourceTabId);
      await chrome.tabs.update(resource.sourceTabId, { active: true });
      return {};
    }
    default: throw new Error('未知请求。');
  }
}

async function readCoursePage(message, sender) {
  await requireTab(sender.tab.id);
  if (!C.readablePage(message.url)) throw new Error('不支持的资源接口。');
  const source = new URL(sender.url), target = new URL(message.url);
  const suffix = source.hostname.endsWith('.chaoxing.com.cn') ? 'chaoxing.com.cn' : 'chaoxing.com';
  const permitted = new Set([source.origin, 'https://mooc1.' + suffix]);
  if (!permitted.has(target.origin)) throw new Error('资源接口来源不匹配。');
  // Fetch cannot freely set a cross-origin Referer from the extension origin.
  // Apply the same narrow session rule used for downloads, and always remove it.
  const id = 'read-' + crypto.randomUUID();
  try {
    await prepare({ id, resource: { url: target.href, sourceUrl: target.origin } }, target.pathname.startsWith('/ananas/status/') ? '/ananas/modules/pdf/index.html' : '/');
    const response = await fetch(target.href, { credentials: 'include', cache: 'no-store',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }, signal: AbortSignal.timeout(18000) });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    if (!C.readablePage(response.url) || !permitted.has(new URL(response.url).origin)) throw new Error('章节需要登录或身份验证，请先在课程页处理。');
    if (Number(response.headers.get('content-length')) > 4_000_000) throw new Error('页面数据过大。');
    const content = await response.text();
    if (content.length > 4_000_000) throw new Error('页面数据过大。');
    return content;
  } finally { await cleanup(id); }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return false;
  const manager = sender.url?.split('?')[0] === chrome.runtime.getURL('manager.html');
  const content = Number.isInteger(sender.tab?.id) && C.allowedUrl(sender.url) && !new URL(sender.url).hostname.endsWith('cldisk.com');
  let task;
  // Isolated content scripts only obtain their own tab ID or request narrowly scoped read-only pages.
  // There is no window.postMessage bridge from website scripts.
  if (content && message.type === 'READ_PAGE') task = readCoursePage(message, sender);
  else if (content && sender.frameId === 0 && C.coursePage(sender.url) && message.type === 'INLINE_TAB') task = requireTab(sender.tab.id).then(() => sender.tab.id);
  else if (manager) {
    const embedded = new URL(sender.url).searchParams.get('embedded') === '1';
    if (embedded && (!Number.isInteger(sender.tab?.id) || !C.coursePage(sender.tab.url))) return false;
    if (embedded && ['SCAN_TAB', 'CATALOG', 'SCAN_CHAPTER'].includes(message.type)) message = { ...message, tabId: sender.tab.id };
    task = handle(message);
  } else return false;
  task.then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: C.safeError(error) }));
  return true;
});
void ensureAlarm();
