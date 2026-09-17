import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const sourceUrl = 'https://mooc1.chaoxing.com/mycourse/studentstudy?enc=EXAMPLE';
const pdfUrl = 'https://s3.cldisk.com/demo/courseware.pdf';
const scripts = Object.fromEntries(await Promise.all(['src/core.js', 'src/page.js'].map(async file => [file, await readFile(new URL('../' + file, import.meta.url), 'utf8')])));
const sourceHTML = '<html><body><iframe id="iframe" src="/mooc-ans/knowledge/cards?courseid=101&clazzid=202&knowledgeid=303"></iframe></body></html>';
const cardHTML = '<html><body><script>mArg = {"coursename":"示例课程","knowledgename":"示例章节","attachments":[{"type":"document","property":{"objectid":"example-file-001","name":"示例.pdf","size":100}}]};</script></body></html>';
const frames = [sourceHTML, cardHTML].map((html, index) => vm.createContext({
  document: parseHTML(html).document, location: new URL(index ? 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards' : sourceUrl),
  URL, URLSearchParams, AbortSignal, setTimeout,
  DOMParser: class { parseFromString(html) { return parseHTML(html).document; } },
  fetch: async url => ({ ok: true, url, text: async () => JSON.stringify({ status: 'success', objectid: 'example-file-001', filename: '示例.pdf', download: 'https://d0.cldisk.com/download/example-file-001?ak_=EXAMPLE', pdf: pdfUrl, length: 100 }) })
}));
const events = {};
const event = name => ({ addListener: fn => { (events[name] ||= []).push(fn); } });
const area = () => { let data = {}; return { get: async key => ({ [key]: data[key] }), set: async update => { data = structuredClone({ ...data, ...update }); } }; };
const downloads = new Map(), started = [], rules = new Map();
globalThis.chrome = {
  runtime: { id: extensionId, getURL: path => 'chrome-extension://' + extensionId + '/' + path, onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message') },
  action: { onClicked: event('action'), setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  storage: { session: area(), local: area() },
  alarms: { get: async () => ({ name: 'courseware-queue' }), create: async () => {}, onAlarm: event('alarm') },
  tabs: { get: async id => ({ id, url: sourceUrl }), query: async () => [{ id: 7, url: sourceUrl, title: '示例学习页' }], update: async () => {}, create: async () => {} },
  scripting: { executeScript: async options => {
    const indices = options.target.allFrames ? [0, 1] : options.target.frameIds || [0];
    const result = [];
    for (const index of indices) {
      const context = frames[index]; let value;
      if (options.files) for (const file of options.files) value = vm.runInContext(scripts[file], context);
      else { context.args = options.args || []; value = await vm.runInContext('(' + options.func.toString() + ')(...args)', context); }
      result.push({ frameId: index, result: JSON.parse(JSON.stringify(value)) });
    }
    return result;
  } },
  declarativeNetRequest: { updateSessionRules: async update => { for (const id of update.removeRuleIds || []) rules.delete(id); for (const rule of update.addRules || []) rules.set(rule.id, rule); } },
  downloads: {
    download: async options => { const id = started.length + 1; started.push(options); downloads.set(id, { id, state: 'in_progress', bytesReceived: 0, totalBytes: 100, mime: 'application/pdf' }); return id; },
    search: async ({ id }) => downloads.has(id) ? [downloads.get(id)] : [],
    pause: async () => {}, resume: async () => {}, cancel: async () => {}, show: async () => {}, onChanged: event('downloadChanged')
  }
};
await import('../src/background.js');
function message(type, rest = {}) {
  return new Promise((resolve, reject) => {
    events.message[0]({ type, ...rest }, { id: extensionId, url: chrome.runtime.getURL('manager.html') + '?tab=7' }, response => response.ok ? resolve(response.data) : reject(new Error(response.error)));
  });
}

test('real injected scanner and service-worker messages populate the library', async () => {
  const result = await message('SCAN_TAB', { tabId: 7 });
  assert.equal(result.count, 1); assert.equal(result.frames, 2);
  const state = await message('STATE');
  assert.equal(state.resources[0].sourceTabId, 7); assert.equal(state.resources[0].course, '示例课程');
});
test('copy request resolves the status API and selects the PDF URL', async () => {
  const result = await message('COPY_LINKS', { keys: ['object:example-file-001'] });
  assert.equal(result.links[0].url, pdfUrl); assert.equal(result.failures.length, 0);
});
test('download integration uses original name and narrowly scoped, sanitized referrer', async () => {
  await message('DOWNLOAD', { keys: ['object:example-file-001'] });
  const state = await message('STATE');
  assert.equal(started.length, 1); assert.equal(started[0].url, pdfUrl);
  assert.equal(started[0].filename, '超星课件/示例课程/示例章节/示例.pdf');
  assert.equal(state.jobs[0].status, 'downloading');
  const rule = [...rules.values()][0];
  assert.equal(rule.action.requestHeaders[0].value, 'https://mooc1.chaoxing.com/');
  assert.deepEqual(rule.condition.tabIds, [-1]); assert(!JSON.stringify(rule).includes('EXAMPLE'));
  downloads.get(1).state = 'complete'; events.downloadChanged[0]({ id: 1, state: { current: 'complete' } });
  assert.equal((await message('STATE')).jobs[0].status, 'done'); assert.equal(rules.size, 0);
});
test('website and content-script messages cannot invoke privileged operations', () => {
  let replied = false;
  const result = events.message[0]({ type: 'DOWNLOAD', keys: ['object:example-file-001'] }, { id: extensionId, url: sourceUrl }, () => { replied = true; });
  assert.equal(result, false); assert.equal(replied, false);
});

test('in-page bootstrap is tied to the real sender tab; content cannot download', async () => {
  const sender = { id: extensionId, url: sourceUrl, frameId: 0, tab: { id: 7, url: sourceUrl } };
  const response = await new Promise(resolve => events.message[0]({ type: 'INLINE_TAB', tabId: 999 }, sender, resolve));
  assert.equal(response.data, 7);
  assert.equal(events.message[0]({ type: 'DOWNLOAD', keys: [] }, sender, () => {}), false);
  assert.equal(events.message[0]({ type: 'INLINE_TAB' }, { ...sender, frameId: 3 }, () => {}), false);
});

test('cross-origin read relay only accepts course endpoints on source host or learning host', async () => {
  const home = 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=101';
  const sender = { id: extensionId, url: home, frameId: 0, tab: { id: 7, url: home } };
  const read = url => new Promise(resolve => events.message[0]({ type: 'READ_PAGE', url }, sender, resolve));
  const originalFetch = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options }); return { ok: true, url, headers: new Headers(), text: async () => '<html>synthetic course</html>' };
  };
  try {
    const response = await read('https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=101');
    assert.equal(response.ok, true); assert.equal(calls[0].options.credentials, 'include');
    for (const url of [
      'https://outside.invalid/mycourse/studentstudy',
      'https://mooc1.chaoxing.com/mycourse/delete',
      'https://mooc1.chaoxing.com/ananas/status/example/../../delete',
      'https://other.chaoxing.com/mycourse/studentstudy',
      'https://mooc1.chaoxing.com/mycourse/transfer?moocId=101&clazzid=202&refer=https%3A%2F%2Foutside.invalid%2Fmycourse%2Fstudentstudy',
      'https://d0.cldisk.com/mycourse/studentstudy'
    ]) assert.equal((await read(url)).ok, false);
    assert.equal(calls.length, 1);
    const transfer = new URL('https://mooc1.chaoxing.com/mycourse/transfer');
    transfer.search = new URLSearchParams({ moocId: '101', clazzid: '202', refer: 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=101&clazzid=202' });
    assert.equal((await read(transfer.href)).ok, true);
    assert.equal(rules.size, 0);
    globalThis.fetch = async () => ({ ok: true, url: 'https://passport2.chaoxing.com/login', headers: new Headers(), text: async () => 'login' });
    assert.equal((await read('https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=101')).ok, false);
  } finally { globalThis.fetch = originalFetch; }
});

test('embedded manager scans its actual containing tab rather than a requested unrelated tab', async () => {
  const sender = { id: extensionId, url: chrome.runtime.getURL('manager.html') + '?embedded=1&tab=999', tab: { id: 7, url: sourceUrl } };
  const reply = await new Promise(resolve => events.message[0]({ type: 'SCAN_TAB', tabId: 999 }, sender, resolve));
  assert.equal(reply.ok, true);
  assert.equal((await message('STATE')).resources[0].sourceTabId, 7);
  assert.equal(events.message[0]({ type: 'SCAN_TAB', tabId: 7 }, { ...sender, tab: { id: 7, url: 'https://outside.invalid/' } }, () => {}), false);
});
