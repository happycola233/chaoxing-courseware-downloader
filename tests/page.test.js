import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
const core = await readFile(new URL('../src/core.js', import.meta.url), 'utf8');
const page = await readFile(new URL('../src/page.js', import.meta.url), 'utf8');
const source = `<!doctype html><html><body><iframe id="iframe" src="/mooc-ans/knowledge/cards?courseid=101&clazzid=202&knowledgeid=303&cpi=404"></iframe><span class="posCatalog_name" title="示例章节" onclick="getTeacherAjax('101','202','303')">示例章节</span></body></html>`;

function environment(reply) {
  const { document } = parseHTML(source); const calls = [];
  const scope = {
    document, location: new URL('https://mooc1.chaoxing.com/mycourse/studentstudy'), URL, URLSearchParams, AbortSignal,
    DOMParser: class { parseFromString(html) { return parseHTML(html).document; } },
    setTimeout: callback => { callback(); return 0; },
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, url, text: async () => reply(url) }; }
  };
  vm.runInNewContext(core + '\n' + page, scope);
  return { api: scope.CoursewarePage, calls };
}

test('resource API requests use native credentials, PDF referer and XHR header; parse both URLs', async () => {
  const env = environment(() => JSON.stringify({ status: 'success', filename: '示例.pptx', objectid: 'example-slides', download: 'http://d0.cldisk.com/demo.pptx', pdf: 'https://s3.cldisk.com/demo.pdf', length: 1024 }));
  const result = await env.api.resolve({ objectId: 'example-slides', sourceTabId: 1 });
  assert.equal(result.originalUrl, 'https://d0.cldisk.com/demo.pptx');
  assert.equal(result.pdfUrl, 'https://s3.cldisk.com/demo.pdf');
  assert.equal(env.calls[0].options.credentials, 'include');
  assert.equal(env.calls[0].options.referrer, 'https://mooc1.chaoxing.com/ananas/modules/pdf/index.html');
  assert.equal(env.calls[0].options.headers['X-Requested-With'], 'XMLHttpRequest');
  assert.match(env.calls[0].url, /\/ananas\/status\/example-slides\?flag=normal&_dc=\d+/);
});

test('course scanning visits only listed chapters, respects gate and collects every card', async () => {
  const env = environment(url => {
    if (url.includes('studentstudyAjax')) return '<html><body><input id="cardcount" value="2"><iframe id="iframe" src="/mooc-ans/knowledge/cards?knowledgeid=303&courseid=101&clazzid=202&num=0"></iframe></body></html>';
    const card = new URL(url).searchParams.get('num');
    return `<html><body><script>mArg = ${JSON.stringify({ coursename: '示例课程', attachments: [{ type: 'document', property: { objectid: 'example-object-' + card, name: '示例' + card + '.pdf' } }] })};</script></body></html>`;
  });
  const result = await env.api.scanChapter({ id: '303', name: '1.1 示例章节' });
  assert.equal(result.resources.length, 2); assert.equal(result.cardCount, 2);
  assert.equal(env.calls.length, 3); assert.equal(result.resources[0].chapter, '示例章节'); // Use the directory's label, not an arbitrary message label.
  await assert.rejects(env.api.scanChapter({ id: '999', name: '不存在' }), /当前已开放/);
  assert.equal(env.calls.length, 3);
});

test('verification pages halt chapter scan rather than skipping the access gate', async () => {
  const env = environment(() => '<html><body><div id="chapterFaceState">身份验证</div></body></html>');
  await assert.rejects(env.api.scanChapter({ id: '303', name: '示例' }), /身份验证/);
  assert.equal(env.calls.length, 1);
});

test('directory HTML and card scripts are parsed inertly, never evaluated', async () => {
  const env = environment(() => '<html><body><script>throw new Error("must not run")</script><p>尚未开放</p></body></html>');
  await assert.rejects(env.api.scanChapter({ id: '303', name: '示例' }), /未开放/);
});

function homepageEnvironment({ credential = true, locked = false } = {}) {
  const { document } = parseHTML('<html><body><iframe id="frame_content-zj" src="/mooc2-ans/mycourse/studentcourse?courseid=101&clazzid=202&cpi=404"></iframe></body></html>');
  const child = parseHTML('<html><body><div class="chapter_item' + (locked ? ' locked' : '') + '" onclick="toOld(\'101\',\'303\',\'202\',0)" title="示例课时"><a class="clicktitle"><span class="catalog_sbar">1.1</span>示例课时</a></div><script>function toOld(){var enc="' + (credential ? 'DEMO_STUDY_CREDENTIAL' : '') + '";}</script></body></html>').document;
  const frame = document.querySelector('iframe');
  Object.defineProperty(frame, 'contentDocument', { value: child });
  Object.defineProperty(frame, 'contentWindow', { value: { location: new URL('https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse?courseid=101&clazzid=202&cpi=404') } });
  const calls = [];
  const scope = {
    document, location: new URL('https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=101&clazzid=202&cpi=404&enc=DEMO_HOME_CREDENTIAL'),
    URL, URLSearchParams, AbortSignal, setTimeout: callback => callback(),
    DOMParser: class { parseFromString(html) { return parseHTML(html).document; } },
    fetch: async () => { throw new Error('Cross-origin content fetch must not be used'); },
    chrome: { runtime: { sendMessage: async message => {
      calls.push(message);
      if (message.url.includes('/mycourse/transfer')) return { ok: true, data: '<html><body><input id="cardcount" value="1"><iframe id="iframe" src="/mooc-ans/knowledge/cards?courseid=101&clazzid=202&knowledgeid=303"></iframe></body></html>' };
      if (message.url.includes('/ananas/status/')) return { ok: true, data: JSON.stringify({ filename: '示例.pdf', pdf: 'https://s3.cldisk.com/demo.pdf', objectid: 'example-home-doc' }) };
      return { ok: true, data: '<html><body><script>mArg={"coursename":"示例课程","attachments":[{"type":"document","property":{"objectid":"example-home-doc","name":"示例.pdf"}}]};</script></body></html>' };
    } } }
  };
  vm.runInNewContext(core + '\n' + page, scope);
  return { api: scope.CoursewarePage, calls };
}

test('new homepage finds nested catalog and uses the actual toOld credential across origins', async () => {
  const env = homepageEnvironment(), ctx = env.api.context();
  assert.equal(ctx.courseId, '101'); assert.equal(ctx.chapters.length, 1);
  assert.equal(ctx.chapters[0].name, '1.1 示例课时');
  const result = await env.api.scanChapter({ id: '303', name: 'untrusted replacement' });
  assert.equal(result.resources.length, 1);
  assert.equal(result.resources[0].chapter, '1.1 示例课时');
  assert.equal(new URL(env.calls[0].url).origin, 'https://mooc1.chaoxing.com');
  assert.equal(new URL(env.calls[0].url).pathname, '/mycourse/transfer');
  const study = new URL(new URL(env.calls[0].url).searchParams.get('refer'));
  assert.equal(study.searchParams.get('enc'), 'DEMO_STUDY_CREDENTIAL');
  assert(!env.calls.some(call => call.url.includes('DEMO_HOME_CREDENTIAL')));
  assert.match(env.calls[1].url, /^https:\/\/mooc1\.chaoxing\.com\/mooc-ans\/knowledge\/cards/);
  const resource = await env.api.resolve(result.resources[0]);
  assert.equal(resource.pdfUrl, 'https://s3.cldisk.com/demo.pdf');
  assert.match(env.calls[2].url, /^https:\/\/mooc1\.chaoxing\.com\/ananas\/status\//);
});

test('homepage missing its learning-page credential fails without guessing or bypassing gates', async () => {
  const env = homepageEnvironment({ credential: false });
  await assert.rejects(env.api.scanChapter({ id: '303' }), /章节入口/);
  assert.equal(env.calls.length, 0);
  const locked = homepageEnvironment({ locked: true });
  await assert.rejects(locked.api.scanChapter({ id: '303' }), /当前已开放/);
  assert.equal(locked.calls.length, 0);
});
