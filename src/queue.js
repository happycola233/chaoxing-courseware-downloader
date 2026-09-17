import './core.js';
const C = globalThis.CoursewareCore;
export const DEFAULTS = Object.freeze({ folder: '超星课件', organize: true, concurrency: 2, retries: 1, saveAs: false, format: 'original' });

export function settingsFrom(input = {}) {
  return {
    folder: C.safeName(input.folder || DEFAULTS.folder, DEFAULTS.folder, 40),
    organize: input.organize !== false,
    concurrency: Math.min(4, Math.max(1, Math.floor(Number(input.concurrency) || 2))),
    retries: Math.min(2, Math.max(0, Math.floor(Number(input.retries) || 0))),
    saveAs: input.saveAs === true,
    format: input.format === 'pdf' ? 'pdf' : 'original'
  };
}

export class DownloadQueue {
  constructor(io) {
    this.io = io;
    this.state = { resources: [], jobs: [], paused: false };
    this.settings = { ...DEFAULTS };
    this.tail = Promise.resolve();
    this.ready = this.initialize();
  }

  async initialize() {
    const saved = await this.io.load();
    this.state = saved.state || this.state;
    this.settings = settingsFrom({ ...DEFAULTS, ...saved.settings });
    // A worker can be stopped between resolution and handing a task to Chrome.
    for (const job of this.state.jobs) {
      if (job.status === 'resolving') {
        const existing = job.startedAt && this.io.recover ? await this.io.recover(job) : null;
        if (existing) { job.downloadId = existing.id; job.status = 'downloading'; }
        else { job.status = 'pending'; job.error = ''; }
      }
    }
  }

  run(fn) {
    const result = this.tail.then(() => this.ready).then(fn);
    this.tail = result.catch(() => {});
    return result;
  }

  async save() { await this.io.save(this.state, this.settings); }
  async snapshot() { return this.run(async () => structuredClone({ ...this.state, settings: this.settings })); }

  async addResources(resources) {
    return this.run(async () => {
      this.state.resources = C.mergeResources([...this.state.resources, ...resources]).slice(-2000);
      // Fresh scans update waiting/retry jobs as signatures may have expired.
      for (const job of this.state.jobs) {
        const fresh = this.state.resources.find(r => r.key === job.resource.key);
        if (fresh && !['downloading', 'done'].includes(job.status)) { job.resource = { ...fresh }; job.sourceResource = { ...fresh }; }
      }
      await this.save();
      return this.state.resources.length;
    });
  }

  async enqueue(keys) {
    return this.run(async () => {
      let added = 0;
      for (const key of new Set(keys)) {
        const resource = this.state.resources.find(r => r.key === key);
        if (!resource) continue;
        if (this.state.jobs.some(j => j.resource.key === key && (j.format || 'original') === this.settings.format && ['pending', 'resolving', 'downloading', 'done'].includes(j.status))) continue;
        if (this.state.jobs.length >= 2000) throw new Error('队列最多保留 2,000 个任务，请清理已结束记录后继续。');
        this.state.jobs.push({ id: crypto.randomUUID(), resource: { ...resource }, sourceResource: { ...resource }, format: this.settings.format, status: 'pending', attempt: 0, downloadId: null, error: '', bytesReceived: 0, totalBytes: resource.size || 0, nextRetryAt: 0 });
        added++;
      }
      await this.save();
      return added;
    });
  }

  fail(job, error, automatic = false) {
    const raw = String(error?.message || error);
    job.error = C.safeError(raw);
    job.status = 'failed';
    const retryable = /NETWORK_|SERVER_FAILED|SERVER_FORBIDDEN|403|HTTP 5\d\d|fetch|timeout|超时/i.test(raw);
    if (automatic && retryable && job.attempt <= this.settings.retries) {
      job.status = 'pending';
      job.nextRetryAt = Date.now() + Math.min(30000, job.attempt * 5000);
    }
  }

  async reconcile() {
    for (const job of this.state.jobs.filter(j => j.status === 'downloading' && Number.isInteger(j.downloadId))) {
      const item = await this.io.search(job.downloadId);
      if (!item) { this.fail(job, '下载记录已移除，请重新添加。'); continue; }
      job.bytesReceived = item.bytesReceived || 0;
      job.totalBytes = item.totalBytes > 0 ? item.totalBytes : job.resource.size || 0;
      job.browserPaused = item.paused === true;
      if (item.state === 'complete') {
        if (/text\/html|application\/json/.test(item.mime || '')) this.fail(job, '服务器返回了网页而不是课件，请重新登录并扫描。');
        else { job.status = 'done'; job.error = ''; }
        await this.io.cleanup(job.id);
      } else if (item.state === 'interrupted') {
        this.fail(job, item.error || '下载中断', true);
        await this.io.cleanup(job.id);
      }
    }
  }

  async pump() {
    return this.run(async () => {
      await this.reconcile();
      if (!this.state.paused) {
        const active = this.state.jobs.filter(j => ['resolving', 'downloading'].includes(j.status)).length;
        const slots = (this.settings.saveAs ? 1 : this.settings.concurrency) - active;
        const pending = this.state.jobs.filter(j => j.status === 'pending' && j.nextRetryAt <= Date.now()).slice(0, Math.max(0, slots));
        for (const job of pending) {
          job.status = 'resolving'; job.attempt++; job.error = '';
          await this.save();
          try {
            job.resource = await this.io.resolve(job.sourceResource || job.resource, { ...this.settings, format: job.format || 'original' });
            if (!C.allowedUrl(job.resource.url)) throw new Error('未找到可下载地址，请打开对应章节后重新扫描。');
            job.startedAt = Date.now();
            await this.save();
            await this.io.prepare(job);
            job.downloadId = await this.io.download({
              url: job.resource.url,
              filename: C.downloadPath(job.resource, this.settings),
              conflictAction: 'uniquify', saveAs: this.settings.saveAs
            });
            job.status = 'downloading';
            // Persist before accepting another task to survive worker suspension.
            await this.save();
          } catch (error) {
            this.fail(job, error, true);
            await this.io.cleanup(job.id);
          }
        }
      }
      await this.save();
    });
  }

  async command(action, payload) {
    return this.run(async () => {
      if (action === 'settings') this.settings = settingsFrom({ ...this.settings, ...payload });
      if (action === 'pause' || action === 'resume') {
        this.state.paused = action === 'pause';
        for (const job of this.state.jobs.filter(j => j.status === 'downloading')) {
          try { await this.io[action](job.downloadId); } catch { /* Completion may race a pause. */ }
        }
      }
      if (action === 'retry') {
        for (const job of this.state.jobs.filter(j => ['failed', 'cancelled'].includes(j.status))) {
          job.status = 'pending'; job.error = ''; job.attempt = 0; job.nextRetryAt = 0; job.downloadId = null; job.format = this.settings.format;
        }
      }
      if (action === 'cancel') {
        for (const job of this.state.jobs.filter(j => ['pending', 'resolving', 'downloading'].includes(j.status))) {
          if (job.status === 'downloading') try { await this.io.cancel(job.downloadId); } catch { /* Already ended. */ }
          job.status = 'cancelled'; job.error = '已取消';
          await this.io.cleanup(job.id);
        }
      }
      if (action === 'clearLibrary') this.state.resources = [];
      if (action === 'clearFinished') this.state.jobs = this.state.jobs.filter(j => ['pending', 'resolving', 'downloading'].includes(j.status));
      await this.save();
    });
  }
}
