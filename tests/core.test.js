import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import '../src/core.js';
const C = globalThis.CoursewareCore;
const base = 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards';
const objectId = 'example-document-001';
const rawUrl = 'https://d0.cldisk.com/download/example-document-001?fn=demo.pdf&at_=EXAMPLE&ak_=EXAMPLE';
const doc = body => parseHTML('<html><body>' + body + '</body></html>').document;

test('only provider URLs are accepted; absent fields cannot turn into page URLs', () => {
  for (const value of ['', undefined, null, 'javascript:alert(1)', 'file:///secret', 'https://chaoxing.com.evil.test/x', 'https://user:pass@mooc1.chaoxing.com/x', 'https://127.0.0.1/x', 'https://mooc1.chaoxing.com:444/x']) assert.equal(C.allowedUrl(value, base), '');
  assert.equal(C.allowedUrl('/doc/demo.pdf', base), 'https://mooc1.chaoxing.com/doc/demo.pdf');
});

test('extract actual Chaoxing mArg and iframe metadata without executing scripts', () => {
  const args = { coursename: '示例课程', knowledgename: '示例章节', attachments: [{ type: 'document', property: { objectid: objectId, name: '示例文档.pdf', size: 100 } }] };
  const html = `<script>mArg = ""; try { mArg = ${JSON.stringify(args)}; } catch(e) {} window.doNotRun = true;</script><iframe data='${JSON.stringify(args.attachments[0].property)}'></iframe>`;
  const result = C.inspect(doc(html), base);
  assert.equal(result.resources.length, 1);
  assert.equal(result.resources[0].url, '');
  assert.equal(result.resources[0].name, '示例文档.pdf');
  assert.equal(result.course, '示例课程');
  assert.equal(globalThis.doNotRun, undefined);
});

test('single-quoted fileinfo exposes original download and filename from fn query', () => {
  const result = C.inspect(doc(`<script>var fileinfo = {'download':'${rawUrl}', 'objectId':'${objectId}', 'suffix':'pdf', 'filesize':'100', 'name':''};</script>`), 'https://pan-yz.chaoxing.com/screen/v2/file_example');
  assert.equal(result.resources.length, 1);
  assert.equal(result.resources[0].url, rawUrl);
  assert.equal(result.resources[0].name, 'demo.pdf');
  assert.equal(result.resources[0].size, 100);
});

test('safe literal decoding supports escaped quotation marks and Unicode', () => {
  assert.equal(C.stringLiteral("'demo\\'s \\u8bfe\\u4ef6.pdf'"), "demo's 课件.pdf");
  assert.equal(C.literalField('{ "download": "https:\\/\\/d0.cldisk.com\\/demo.pdf" }', 'download'), 'https://d0.cldisk.com/demo.pdf');
  assert.equal(C.assignedObject('mArg = {"title":"} {"}; evil()', 'mArg'), '{"title":"} {"}');
});

test('malformed or executable JS is not treated as JSON', () => {
  const result = C.inspect(doc('<script>mArg = {attachments: (() => { throw new Error("bad"); })()};</script>'), base);
  assert.equal(result.resources.length, 0);
  assert.equal(C.assignedObject('mArg = {"unterminated":1', 'mArg'), null);
});

test('merge same object across frames and refresh expiring signatures', () => {
  const metadata = C.normalizeResource({ objectId, name: '文件.pdf', size: 100 }, { base, course: '示例课程' });
  const download = C.normalizeResource({ objectId, name: '文件.pdf', url: rawUrl }, { base: 'https://pan-yz.chaoxing.com/screen/demo' });
  const merged = C.mergeResources([metadata, download]);
  assert.equal(merged.length, 1); assert.equal(merged[0].course, '示例课程'); assert.equal(merged[0].size, 100);
  const fresh = { ...download, url: rawUrl.replace('at_=EXAMPLE', 'at_=FRESH') };
  assert.equal(C.mergeResources([...merged, fresh])[0].url, fresh.url);
});

test('duplicate download links collapse even if only one has an object ID', () => {
  const byUrl = C.normalizeResource({ name: 'demo.pdf', url: rawUrl }, { base });
  const byObject = C.normalizeResource({ objectId, name: 'demo.pdf', url: rawUrl }, { base });
  assert.equal(C.mergeResources([byUrl, byObject]).length, 1);
  assert.equal(C.mergeResources([byObject, byUrl]).length, 1);
});

test('direct documents and media work; thumbnails and javascript links are ignored', () => {
  const result = C.inspect(doc('<a href="https://d0.cldisk.com/demo.pptx">课件</a><video src="https://mooc1.chaoxing.com/demo.mp4"></video><img src="https://d0.cldisk.com/thumb/1.png"><a href="javascript:alert(1)" download="bad.pdf">bad</a>'), base);
  assert.deepEqual(result.resources.map(r => r.ext), ['pptx', 'mp4']);
});

test('directory extraction reads only genuine chapter handlers and deduplicates', () => {
  const html = `<span class="posCatalog_name" title="示例章节" onclick="getTeacherAjax('101','202','303');"><em class="posCatalog_sbar">1.1</em>示例章节</span><span onclick="getTeacherAjax('101','202','303');">duplicate</span><span onclick="deleteNote('404')">not a chapter</span>`;
  const chapters = C.catalog(doc(html), base);
  assert.equal(chapters.length, 1); assert.equal(chapters[0].id, '303'); assert.equal(chapters[0].name, '1.1 示例章节');
});

test('filenames cannot escape the Downloads folder and keep extensions', () => {
  assert.equal(C.safeName('CON.pdf'), '_CON.pdf');
  assert.equal(C.safeName('../../危险\\文件?.pdf'), '_.._危险_文件_.pdf');
  assert.equal(C.safeName('   '), '未命名');
  const path = C.downloadPath({ name: 'a'.repeat(160) + '.pptx', course: '../课程', chapter: '章:节' }, { folder: '../../root' });
  assert(!path.split('/').includes('..')); assert(path.endsWith('.pptx')); assert(path.length < 250);
});

test('public exports contain no URLs, object IDs, tab IDs or signatures', () => {
  const resource = C.normalizeResource({ objectId, url: rawUrl, name: '示例文件.pdf' }, { base, sourceTabId: 999 });
  const serialized = JSON.stringify(C.publicManifest([resource]));
  for (const value of [objectId, rawUrl, 'sourceTabId', '999', 'ak_', 'sourceUrl']) assert(!serialized.includes(value));
});

test('errors redact URLs and token values instead of leaking signatures', () => {
  const error = C.safeError('failure ' + rawUrl + ' token=EXAMPLE');
  assert(!error.includes('https://')); assert(!error.includes('EXAMPLE'));
  assert.match(C.safeError('SERVER_FORBIDDEN'), /403/);
});

test('status responses retain PDF and original alternatives without renaming Office files', () => {
  const original = 'https://d0.cldisk.com/download/example-slides';
  const pdf = 'https://s3.cldisk.com/demo/converted.pdf';
  const resource = C.normalizeResource({ objectid: 'example-slides', filename: '示例.pptx', download: original, pdf, length: 1000 }, { base });
  assert.equal(resource.originalUrl, original); assert.equal(resource.pdfUrl, pdf);
  assert.equal(C.transferResource(resource).url, original);
  const converted = C.transferResource(resource, { format: 'pdf' });
  assert.equal(converted.url, pdf); assert.equal(converted.name, '示例.pdf'); assert.equal(converted.ext, 'pdf'); assert.equal(converted.size, 0);
});
test('PDF resources prefer the PDF endpoint; absent conversions fail explicitly', () => {
  const pdf = 'https://s3.cldisk.com/demo/file.pdf';
  const resource = C.normalizeResource({ filename: 'demo.pdf', download: rawUrl, pdf }, { base });
  assert.equal(C.transferResource(resource).url, pdf);
  assert.throws(() => C.transferResource({ ...resource, name: 'demo.pptx', ext: 'pptx', type: 'slides', pdfUrl: '' }, { format: 'pdf' }), /未提供/);
});
