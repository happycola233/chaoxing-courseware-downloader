import test from 'node:test';
import assert from 'node:assert/strict';
import { DownloadQueue } from '../src/queue.js';
const C = globalThis.CoursewareCore;
function harness(saved = {}) {
  const files = new Map(); const calls = []; let persistent = saved;
  const io = {
    load: async () => structuredClone(persistent),
    save: async (state, settings) => { persistent = structuredClone({ state, settings }); },
    download: async options => { const id = files.size + 1; files.set(id, { id, state: 'in_progress', bytesReceived: 0, totalBytes: 100, mime: 'application/pdf' }); calls.push(options); return id; },
    search: async id => files.get(id), resolve: async r => r, prepare: async () => {}, cleanup: async () => {},
    pause: async id => { files.get(id).paused = true; }, resume: async id => { files.get(id).paused = false; },
    cancel: async id => { files.get(id).state = 'interrupted'; files.get(id).error = 'USER_CANCELED'; }
  };
  return { queue: new DownloadQueue(io), io, files, calls, saved: () => persistent };
}
function resource(id) { return C.normalizeResource({ objectId: 'example-object-' + id, name: '示例' + id + '.pdf', url: 'https://d0.cldisk.com/demo-' + id + '.pdf' }, { base: 'https://mooc1.chaoxing.com/demo' }); }
async function seed(h, count = 3) { const items = Array.from({ length: count }, (_, i) => resource(i)); await h.queue.addResources(items); await h.queue.enqueue(items.map(r => r.key)); return items; }

test('queue honors concurrency and starts the next item on completion', async () => {
  const h = harness(); await seed(h); await h.queue.pump(); assert.equal(h.calls.length, 2);
  h.files.get(1).state = 'complete'; await h.queue.pump(); assert.equal(h.calls.length, 3);
  assert.equal((await h.queue.snapshot()).jobs.filter(j => j.status === 'done').length, 1);
});
test('double submission and concurrent pump calls do not duplicate downloads', async () => {
  const h = harness(); const items = await seed(h, 1); await h.queue.enqueue([items[0].key]);
  await Promise.all([h.queue.pump(), h.queue.pump(), h.queue.pump()]); assert.equal(h.calls.length, 1);
});
test('pause suspends downloads and prevents new starts until resumed', async () => {
  const h = harness(); await seed(h); await h.queue.pump(); await h.queue.command('pause'); await h.queue.pump();
  assert.equal(h.calls.length, 2); assert.equal(h.files.get(1).paused, true);
  await h.queue.command('resume'); assert.equal(h.files.get(1).paused, false);
});
test('worker recreation reconciles existing native downloads without restarting them', async () => {
  const h = harness(); await seed(h, 2); await h.queue.pump();
  const restarted = new DownloadQueue({ ...h.io, load: async () => structuredClone(h.saved()) });
  h.files.get(1).state = 'complete'; await restarted.pump();
  assert.equal(h.calls.length, 2); assert.equal((await restarted.snapshot()).jobs[0].status, 'done');
});
test('network interruption is retried with backoff; cancelled files are not auto-retried', async () => {
  const h = harness(); await seed(h, 2); await h.queue.pump();
  h.files.get(1).state = 'interrupted'; h.files.get(1).error = 'NETWORK_FAILED';
  h.files.get(2).state = 'interrupted'; h.files.get(2).error = 'USER_CANCELED';
  await h.queue.pump(); const state = await h.queue.snapshot();
  assert.equal(state.jobs[0].status, 'pending'); assert(state.jobs[0].nextRetryAt > Date.now());
  assert.equal(state.jobs[1].status, 'failed'); assert.equal(h.calls.length, 2);
});
test('downloaded login HTML is marked as failed, never as a completed PDF', async () => {
  const h = harness(); await seed(h, 1); await h.queue.pump();
  h.files.get(1).state = 'complete'; h.files.get(1).mime = 'text/html'; await h.queue.pump();
  const job = (await h.queue.snapshot()).jobs[0]; assert.equal(job.status, 'failed'); assert.match(job.error, /网页/);
});
test('fresh scans update pending signatures without resetting completed tasks', async () => {
  const h = harness(); const items = await seed(h, 1); const fresh = { ...items[0], url: items[0].url + '?signature=FRESH' };
  await h.queue.addResources([fresh]); await h.queue.pump(); assert.equal(h.calls[0].url, fresh.url);
});
test('save-as mode serializes prompts and cancellation stops all outstanding tasks', async () => {
  const h = harness(); await seed(h); await h.queue.command('settings', { saveAs: true, concurrency: 4 }); await h.queue.pump();
  assert.equal(h.calls.length, 1); await h.queue.command('cancel'); await h.queue.pump();
  assert((await h.queue.snapshot()).jobs.every(j => j.status === 'cancelled')); assert.equal(h.calls.length, 1);
});
test('clearing the library does not destroy a running download snapshot', async () => {
  const h = harness(); await seed(h, 1); await h.queue.pump(); await h.queue.command('clearLibrary');
  const state = await h.queue.snapshot(); assert.equal(state.resources.length, 0); assert.equal(state.jobs.length, 1);
});

test('recovery handles termination between a native download and recording its ID', async () => {
  const h = harness(); await seed(h, 1); await h.queue.pump();
  const saved = structuredClone(h.saved()); saved.state.jobs[0].status = 'resolving'; saved.state.jobs[0].downloadId = null;
  const restarted = new DownloadQueue({ ...h.io, load: async () => saved, recover: async () => h.files.get(1) });
  await restarted.pump(); assert.equal(h.calls.length, 1); assert.equal((await restarted.snapshot()).jobs[0].downloadId, 1);
});
