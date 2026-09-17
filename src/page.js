/* Isolated parser. Returned HTML is data: no site scripts are evaluated. */
(() => {
  'use strict';
  const C = globalThis.CoursewareCore;

  async function read(url, referrer = location.href) {
    const valid = C.allowedUrl(url, location.href);
    if (!valid || !C.readablePage(valid)) throw new Error('不支持的资源接口。');
    if (new URL(valid).origin !== location.origin) {
      const reply = await chrome.runtime.sendMessage({ type: 'READ_PAGE', url: valid, referrer });
      if (!reply?.ok) throw new Error(reply?.error || '课程入口未响应。');
      return reply.data;
    }
    const response = await fetch(valid, {
      credentials: 'include', cache: 'no-store', referrer,
      headers: { 'X-Requested-With': 'XMLHttpRequest' }, signal: AbortSignal.timeout(18000)
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    if (new URL(response.url).hostname.includes('passport')) throw new Error('登录已失效');
    const text = await response.text();
    if (text.length > 4_000_000) throw new Error('页面数据过大，已停止解析。');
    return text;
  }

  function documents() {
    const result = [{ doc: document, url: location.href }];
    for (const frame of document.querySelectorAll('iframe[src*="/mycourse/studentcourse"]')) {
      try {
        if (frame.contentDocument?.body) result.push({ doc: frame.contentDocument, url: frame.contentWindow.location.href });
      } catch { /* Cross-origin frames are read separately by the background scanner. */ }
    }
    return result;
  }

  function context() {
    const entries = documents().map(entry => ({ ...entry, chapters: C.catalog(entry.doc, entry.url) }));
    const entry = entries.find(e => e.chapters.length) || entries[0];
    const frame = entry.doc.querySelector('iframe#iframe, iframe[src*="/knowledge/cards"]');
    const cardsUrl = C.allowedUrl(frame?.getAttribute('src'), entry.url);
    const page = new URL(entry.url), cards = cardsUrl ? new URL(cardsUrl) : null;
    let studyOrigin = '', studyEnc = '';
    if (entry.chapters.some(c => c.courseId)) {
      // toOld contains the learning-page credential, different from homepage enc.
      for (const script of entry.doc.querySelectorAll('script:not([src])')) {
        const source = script.textContent || '';
        if (source.length > 2_000_000 || !/function\s+toOld\s*\(/.test(source)) continue;
        const match = source.match(/\bvar\s+enc\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/);
        studyEnc = match ? C.stringLiteral(match[1]) : '';
      }
      studyOrigin = 'https://mooc1.' + (page.hostname.endsWith('.chaoxing.com.cn') ? 'chaoxing.com.cn' : 'chaoxing.com');
    }
    return {
      cardsUrl, origin: page.origin, studyOrigin, studyEnc,
      courseId: cards?.searchParams.get('courseid') || page.searchParams.get('courseId') || page.searchParams.get('courseid') || '',
      clazzId: cards?.searchParams.get('clazzid') || page.searchParams.get('clazzid') || '',
      cpi: cards?.searchParams.get('cpi') || page.searchParams.get('cpi') || '',
      chapter: entry.doc.querySelector('.posCatalog_active .posCatalog_name')?.getAttribute('title') || '',
      chapters: entry.chapters
    };
  }

  async function scanChapter(chapter) {
    const ctx = context();
    const listed = ctx.chapters.find(c => c.id === chapter.id && !c.locked);
    if (!listed) throw new Error('章节不在当前已开放的目录中。');
    if (!ctx.courseId || !ctx.clazzId) throw new Error('请先打开课程的章节目录。');
    let url;
    if (ctx.cardsUrl) {
      const cards = new URL(ctx.cardsUrl);
      url = new URL(cards.pathname.split('/knowledge/cards')[0] + '/mycourse/studentstudyAjax', cards.origin);
    } else if (ctx.studyOrigin && ctx.studyEnc) {
      url = new URL('/mycourse/studentstudy', ctx.studyOrigin);
    } else throw new Error('暂未找到章节入口，请进入任意课时后再扫描目录。');
    url.search = new URLSearchParams({
      courseId: listed.courseId || ctx.courseId, clazzid: listed.clazzId || ctx.clazzId, chapterId: listed.id,
      cpi: ctx.cpi, mooc2: '1', editorPreview: '0', isPreviewVideo: 'false', cardIndex: '0'
    });
    if (!ctx.cardsUrl) { url.searchParams.set('enc', ctx.studyEnc); url.searchParams.set('hidetype', '0'); url.searchParams.set('fanyaVersion', '0'); }
    let entryUrl = url.href;
    if (!ctx.cardsUrl) {
      // Follow the homepage's real transfer entrance; it may add a server-issued openc.
      const transfer = new URL('/mycourse/transfer', ctx.studyOrigin);
      transfer.search = new URLSearchParams({ moocId: listed.courseId || ctx.courseId, clazzid: listed.clazzId || ctx.clazzId,
        linkTime: String(Date.now()), ut: 's', refer: url.href });
      entryUrl = transfer.href;
    }
    const outer = new DOMParser().parseFromString(await read(entryUrl), 'text/html');
    if (outer.querySelector('#chapterFaceState, input[type="password"]')) throw new Error('章节需要登录或身份验证，请先在课程页处理。');
    const frame = outer.querySelector('iframe#iframe, iframe[src*="/knowledge/cards"]');
    const firstCard = C.allowedUrl(frame?.getAttribute('src'), url.href);
    if (!firstCard) throw new Error('此章节未开放、需要验证，或页面结构暂不支持。');
    const count = Number(outer.querySelector('#cardcount')?.value || outer.querySelectorAll('[id^="dct"]').length || 1);
    if (!Number.isInteger(count) || count < 1 || count > 80) throw new Error('章节卡片数量异常，已停止。');
    const resources = [];
    let course = '';
    for (let index = 0; index < count; index++) {
      const card = new URL(firstCard); card.searchParams.set('num', String(index));
      const doc = new DOMParser().parseFromString(await read(card.href, url.href), 'text/html');
      const result = C.inspect(doc, card.href, { chapter: listed.name, course });
      course = result.course || course;
      resources.push(...result.resources.map(r => ({ ...r, chapter: listed.name })));
      if (index + 1 < count) await new Promise(resolve => setTimeout(resolve, 600));
    }
    return { resources: C.mergeResources(resources), course, cardCount: count };
  }

  async function resolve(resource) {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(resource.objectId || '')) return resource;
    const source = C.allowedUrl(resource.sourceUrl) || location.href;
    const origin = new URL(source).hostname.endsWith('cldisk.com') ? location.origin : new URL(source).origin;
    const url = new URL('/ananas/status/' + encodeURIComponent(resource.objectId), origin);
    url.searchParams.set('flag', 'normal'); url.searchParams.set('_dc', String(Date.now()));
    const data = JSON.parse(await read(url.href, origin + '/ananas/modules/pdf/index.html'));
    if (data.status && data.status !== 'success') throw new Error('资源正在转换或暂不可用：' + String(data.status).slice(0, 30));
    if (location.protocol === 'https:' && typeof data.download === 'string') data.download = data.download.replace(/^http:/, 'https:');
    const candidate = C.normalizeResource({ ...data, objectId: resource.objectId, name: data.filename || resource.name }, {
      base: origin + '/ananas/modules/pdf/index.html', course: resource.course, chapter: resource.chapter, sourceTabId: resource.sourceTabId
    });
    if (!candidate?.url) throw new Error('资源接口未提供可下载的原文件地址。');
    return { ...resource, ...candidate };
  }

  globalThis.CoursewarePage = { context, scanChapter, resolve };
  return C.inspect(document, location.href);
})();
