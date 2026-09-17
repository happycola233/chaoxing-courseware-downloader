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
  assert.equal(env.calls.length, 3); assert.equal(result.resources[0].chapter, '1.1 示例章节');
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
