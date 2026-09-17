// Fictional UI preview only. Not used by the packaged extension.
export function createDemo() {
  const resources = [
    ['01 课程导学与学习目标.pdf', 'document', 'pdf', '1.1 课程导学', 864000],
    ['02 基础概念与方法.pptx', 'slides', 'pptx', '1.2 基础概念', 4280000],
    ['03 课堂练习与思考.pdf', 'document', 'pdf', '2.1 课堂练习', 1460000],
    ['04 实验数据记录.xlsx', 'sheet', 'xlsx', '2.2 实验设计', 248000],
    ['05 课后阅读材料.docx', 'document', 'docx', '3.1 延伸阅读', 650000],
    ['06 学习资源汇总.zip', 'archive', 'zip', '3.2 资源整理', 9700000]
  ].map(([name, type, ext, chapter, size], index) => ({ name, type, ext, chapter, size, course: '示例课程 · 学习方法', key: 'demo-' + index, objectId: '', url: '', sourceTabId: 1 }));
  const state = { resources, jobs: [], paused: false, settings: { folder: '超星课件', organize: true, concurrency: 2, retries: 1, saveAs: false, format: 'original' } };
  return { async request(message) {
    let data = {};
    if (message.type === 'TABS') data = [{ id: 1, title: '示例课程的学生学习页面', host: 'mooc1.chaoxing.com' }];
    if (message.type === 'STATE') data = structuredClone(state);
    if (message.type === 'SCAN_TAB') data = { count: resources.length, frames: 4 };
    if (message.type === 'CATALOG') data = { chapters: resources.map((r, i) => ({ id: String(i + 1), name: r.chapter, locked: false })) };
    if (message.type === 'SCAN_CHAPTER') data = { count: 1, cards: 1 };
    if (message.type === 'COPY_LINKS') data = { links: message.keys.map(key => ({ name: '示例文件.pdf', url: 'https://example.invalid/' + key + '.pdf' })), failures: [] };
    if (message.type === 'DOWNLOAD') {
      let count = 0;
      for (const key of message.keys) {
        if (state.jobs.some(j => j.resource.key === key)) continue;
        const resource = resources.find(r => r.key === key);
        state.jobs.push({ id: 'demo-job-' + key, resource, status: 'done', bytesReceived: resource.size, totalBytes: resource.size }); count++;
      }
      data = { count };
    }
    if (message.type === 'COMMAND') {
      if (message.action === 'settings') state.settings = { ...state.settings, ...message.payload };
      if (message.action === 'pause') state.paused = true;
      if (message.action === 'resume') state.paused = false;
      if (message.action === 'clearLibrary') state.resources = [];
      if (message.action === 'clearFinished') state.jobs = [];
    }
    return { ok: true, data };
  } };
}
