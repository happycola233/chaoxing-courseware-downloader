/* Runs only when requested, in the extension's isolated world. No page code is executed. */
(() => {
  'use strict';
  const C = globalThis.CoursewareCore;

  async function read(url, referrer = location.href) {
    const valid = C.allowedUrl(url, location.href);
    if (!valid || new URL(valid).origin !== location.origin) throw new Error('无法从当前课程页面读取资源。');
    const path = new URL(valid).pathname;
    if (!/\/(?:ananas\/status\/|(?:mooc-ans\/)?(?:knowledge\/cards|mycourse\/studentstudyAjax))/.test(path)) {
      throw new Error('不支持的资源接口。');
    }
    const response = await fetch(valid, {
      credentials: 'include', cache: 'no-store', referrer,
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      signal: AbortSignal.timeout(18000)
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    if (new URL(response.url).hostname.includes('passport')) throw new Error('登录已失效');
    const text = await response.text();
    if (text.length > 4_000_000) throw new Error('页面数据过大，已停止解析。');
    return text;
  }

  function context() {
    const frame = document.querySelector('iframe#iframe, iframe[src*="/knowledge/cards"]');
    const cardsUrl = C.allowedUrl(frame?.getAttribute('src'), location.href);
    const page = new URL(location.href);
    const cards = cardsUrl ? new URL(cardsUrl) : null;
    return {
      cardsUrl,
      origin: location.origin,
      courseId: cards?.searchParams.get('courseid') || page.searchParams.get('courseId') || '',
      clazzId: cards?.searchParams.get('clazzid') || page.searchParams.get('clazzid') || '',
      cpi: cards?.searchParams.get('cpi') || page.searchParams.get('cpi') || '',
      chapter: document.querySelector('.posCatalog_active .posCatalog_name')?.getAttribute('title') || '',
      chapters: C.catalog(document, location.href)
    };
  }

  async function scanChapter(chapter) {
    const ctx = context();
    if (!ctx.cardsUrl || !ctx.courseId || !ctx.clazzId) throw new Error('请在“学生学习页面”使用目录扫描。');
    if (!ctx.chapters.some(c => c.id === chapter.id && !c.locked)) throw new Error('章节不在当前已开放的目录中。');
    const currentCards = new URL(ctx.cardsUrl);
    const prefix = currentCards.pathname.split('/knowledge/cards')[0];
    const url = new URL(prefix + '/mycourse/studentstudyAjax', location.origin);
    url.search = new URLSearchParams({
      courseId: ctx.courseId, clazzid: ctx.clazzId, chapterId: chapter.id,
      cpi: ctx.cpi, mooc2: '1', editorPreview: '0', isPreviewVideo: 'false', cardIndex: '0'
    });
    const outer = new DOMParser().parseFromString(await read(url.href), 'text/html');
    if (outer.querySelector('#chapterFaceState, input[type="password"]')) throw new Error('章节需要登录或身份验证，请先在课程页处理。');
    const frame = outer.querySelector('iframe#iframe, iframe[src*="/knowledge/cards"]');
    const firstCard = C.allowedUrl(frame?.getAttribute('src'), location.href);
    if (!firstCard) throw new Error('此章节未开放、需要验证，或页面结构暂不支持。');
    const count = Number(outer.querySelector('#cardcount')?.value || outer.querySelectorAll('[id^="dct"]').length || 1);
    if (!Number.isInteger(count) || count < 1 || count > 80) throw new Error('章节卡片数量异常，已停止。');
    const resources = [];
    let course = '';
    for (let index = 0; index < count; index++) {
      const card = new URL(firstCard);
      card.searchParams.set('num', String(index));
      const html = await read(card.href);
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const result = C.inspect(doc, card.href, { chapter: chapter.name, course });
      course = result.course || course;
      resources.push(...result.resources.map(r => ({ ...r, chapter: chapter.name })));
      if (index + 1 < count) await new Promise(resolve => setTimeout(resolve, 600));
    }
    return { resources: C.mergeResources(resources), course, cardCount: count };
  }

  async function resolve(resource) {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(resource.objectId || '')) return resource;
    const url = new URL('/ananas/status/' + encodeURIComponent(resource.objectId), location.origin);
    url.searchParams.set('flag', 'normal');
    url.searchParams.set('_dc', String(Date.now()));
    const data = JSON.parse(await read(url.href, location.origin + '/ananas/modules/pdf/index.html'));
    if (data.status && data.status !== 'success') throw new Error('资源正在转换或暂不可用：' + String(data.status).slice(0, 30));
    if (location.protocol === 'https:' && typeof data.download === 'string') data.download = data.download.replace(/^http:/, 'https:');
    const candidate = C.normalizeResource({ ...data, objectId: resource.objectId, name: data.filename || resource.name }, {
      base: location.origin + '/ananas/modules/pdf/index.html',
      course: resource.course, chapter: resource.chapter, sourceTabId: resource.sourceTabId
    });
    if (!candidate?.url) throw new Error('资源接口未提供可下载的原文件地址。');
    return { ...resource, ...candidate };
  }

  globalThis.CoursewarePage = { context, scanChapter, resolve };
  return C.inspect(document, location.href);
})();
