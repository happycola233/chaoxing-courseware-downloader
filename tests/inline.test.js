import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
const code = await readFile(new URL('../src/inline.js', import.meta.url), 'utf8');

function environment(header = true) {
  const { document } = parseHTML('<html><body>' + (header ? '<div class="headRight"><a class="backOld">体验新版</a></div>' : '') + '<iframe src="/mooc2-ans/mycourse/studentcourse"></iframe></body></html>');
  const observers = [], timers = [], messages = [];
  const window = { addEventListener() {} }; window.top = window;
  const scope = vm.createContext({
    document, window, location: new URL('https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=101'),
    CoursewareCore: { coursePage: () => true },
    chrome: { runtime: { getURL: path => 'chrome-extension://example-extension/' + path.replace(/^\//, ''), sendMessage: async message => { messages.push(message); return { ok: true, data: 1 }; } } },
    MutationObserver: class { constructor(callback) { observers.push(callback); } observe() {} },
    setTimeout: callback => { timers.push(callback); return timers.length; },
    clearTimeout() {}
  });
  return {
    document, messages, run: () => vm.runInContext(code, scope),
    changed: () => { for (const callback of observers) callback(); while (timers.length) timers.shift()(); }
  };
}
const entry = doc => doc.querySelector('#courseware-download-entry');

test('inaccessible catalog frame cannot suppress the outer-page entry or trigger requests', () => {
  const env = environment();
  Object.defineProperty(env.document.querySelector('iframe'), 'contentDocument', { get() { throw new Error('cross-origin frame'); } });
  env.run();
  assert.equal(entry(env.document).parentElement.className, 'headRight');
  assert.equal(env.messages.length, 0);
});

test('not-yet-loaded catalog gets a floating fallback; replacing it keeps one entry', () => {
  const env = environment(false);
  const frame = env.document.querySelector('iframe');
  Object.defineProperty(frame, 'contentDocument', { value: null });
  env.run();
  const button = entry(env.document);
  assert.equal(button.parentElement, env.document.body);
  assert.match(button.style.cssText, /position:fixed/);
  frame.replaceWith(env.document.createElement('iframe'));
  env.changed(); env.run();
  assert.equal(entry(env.document), button);
  assert.equal(env.document.querySelectorAll('#courseware-download-entry').length, 1);
});

test('outer-header redraw remounts the entry once without duplicate buttons', () => {
  const env = environment();
  env.run();
  const old = entry(env.document);
  env.document.querySelector('.headRight').replaceChildren();
  env.changed();
  assert.equal(old.isConnected, false);
  assert(entry(env.document).isConnected);
  env.changed(); env.changed();
  assert.equal(env.document.querySelectorAll('#courseware-download-entry').length, 1);
});
