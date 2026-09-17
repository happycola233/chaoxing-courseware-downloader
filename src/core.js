/* Shared, dependency-free helpers. Also injected into an ISOLATED content-script world. */
(() => {
  'use strict';
  const GROUPS = {
    document: ['pdf', 'doc', 'docx', 'odt', 'rtf'],
    slides: ['ppt', 'pptx', 'odp'],
    sheet: ['xls', 'xlsx', 'csv', 'ods'],
    archive: ['zip', 'rar', '7z', 'tar', 'gz'],
    text: ['txt', 'md', 'epub'],
    image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'],
    media: ['mp4', 'mp3', 'm4a', 'wav', 'webm', 'ogg']
  };
  const EXTENSIONS = new Set(Object.values(GROUPS).flat());
  const HOSTS = ['chaoxing.com', 'chaoxing.com.cn', 'cldisk.com'];
  const LIMIT = 2_000_000;

  function allowedUrl(value, base) {
    try {
      if (typeof value !== 'string' || !value.trim()) return '';
      const url = new URL(String(value || '').replace(/&amp;/g, '&'), base);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return '';
      if (!HOSTS.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) return '';
      url.hash = '';
      return url.href;
    } catch { return ''; }
  }

  function extension(name = '', url = '') {
    let candidates = [String(name)];
    try {
      const parsed = new URL(url);
      candidates.push(parsed.searchParams.get('fn') || parsed.searchParams.get('filename') || '', decodeURIComponent(parsed.pathname));
    } catch { /* A filename alone is enough. */ }
    for (const value of candidates) {
      const ext = value.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase();
      if (ext && EXTENSIONS.has(ext)) return ext;
    }
    return '';
  }

  function category(ext) {
    return Object.keys(GROUPS).find(group => GROUPS[group].includes(ext)) || 'other';
  }

  function filenameFromUrl(url) {
    try {
      const u = new URL(url);
      return u.searchParams.get('fn') || u.searchParams.get('filename') || decodeURIComponent(u.pathname.split('/').pop());
    } catch { return ''; }
  }

  function safeName(value, fallback = '未命名', max = 90) {
    let name = String(value || '').normalize('NFC')
      .replace(/[\x00-\x1f\x7f<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/g, '_')
      .replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '');
    if (!name) name = fallback;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
    if (name.length > max) {
      const ext = name.match(/\.[a-z0-9]{1,8}$/i)?.[0] || '';
      name = Array.from(name.slice(0, max - ext.length)).join('').replace(/[\uD800-\uDBFF]$/, '') + ext;
    }
    return name;
  }

  function downloadPath(resource, settings = {}) {
    const parts = [safeName(settings.folder || '超星课件', '超星课件', 40)];
    if (settings.organize !== false) {
      parts.push(safeName(resource.course, '课程', 45), safeName(resource.chapter, '未分章节', 50));
    }
    parts.push(safeName(resource.name, '课件' + (resource.ext ? '.' + resource.ext : ''), 100));
    return parts.join('/');
  }

  // Decode a quoted JavaScript *string literal*, never executable source.
  function stringLiteral(token) {
    if (!/^(['"])[\s\S]*\1$/.test(token || '')) return '';
    return token.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, value) => {
      if (value[0] === 'u' || value[0] === 'x') return String.fromCharCode(parseInt(value.slice(1), 16));
      return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[value] ?? value;
    });
  }

  function literalField(text, key) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(text).match(new RegExp('(?:["\\\']?' + escaped + '["\\\']?)\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|\\\'(?:\\\\.|[^\\\'\\\\])*\\\')'));
    return match ? stringLiteral(match[1]) : '';
  }

  function assignedObject(text, identifier) {
    if (typeof text !== 'string' || text.length > LIMIT) return null;
    const expression = new RegExp('(?:^|[;\\s])(?:var\\s+|let\\s+|const\\s+)?' + identifier + '\\s*=\\s*\\{', 'g');
    let match;
    while ((match = expression.exec(text))) {
      const start = text.indexOf('{', match.index);
      let depth = 0, quote = '', escaped = false;
      for (let index = start; index < text.length; index++) {
        const char = text[index];
        if (quote) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === quote) quote = '';
        } else if (char === '"' || char === "'") quote = char;
        else if (char === '{') depth++;
        else if (char === '}' && --depth === 0) return text.slice(start, index + 1);
      }
    }
    return null;
  }

  function normalizeResource(value, context = {}) {
    const property = value.property || value;
    const objectId = String(property.objectid || property.objectId || value.objectid || value.objectId || '');
    const cleanObject = /^[a-zA-Z0-9_-]{8,128}$/.test(objectId) ? objectId : '';
    const originalUrl = allowedUrl(value.originalUrl || value.download || property.download, context.base);
    const pdfUrl = allowedUrl(value.pdfUrl || value.pdf, context.base);
    const url = allowedUrl(value.url || originalUrl || property.url || pdfUrl, context.base);
    let name = String(property.name || property.filename || property.title || value.filename || filenameFromUrl(url) || '');
    let ext = extension(name, url) || String(property.suffix || property.type || '').replace(/^\./, '').toLowerCase();
    if (!EXTENSIONS.has(ext)) ext = '';
    if (!cleanObject && !url) return null;
    if (!ext && !/document|insertdoc|attachment|file/i.test(value.type || property.module || '') && !url) return null;
    if (!name) name = '课件' + (ext ? '.' + ext : '');
    if (ext && !extension(name)) name += '.' + ext;
    const size = Number(property.size || property.filesize || property.length || value.length || value.size || 0);
    const key = cleanObject ? 'object:' + cleanObject : 'url:' + canonicalUrl(url);
    return {
      key, objectId: cleanObject, name: safeName(name, '课件', 180), ext, type: category(ext),
      size: Number.isFinite(size) && size > 0 ? size : 0, url, originalUrl, pdfUrl,
      sourceUrl: allowedUrl(context.base), origin: allowedUrl(context.base) ? new URL(context.base).origin : '',
      course: String(context.course || '').slice(0, 160), chapter: String(context.chapter || '').slice(0, 160),
      sourceTabId: context.sourceTabId ?? null, foundAt: Date.now()
    };
  }

  function canonicalUrl(value) {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(at_|ak_|ad_|enc|openc|token|signature|nonce|timestamp|expires|auth|t)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.href;
  }

  function mergeResources(items) {
    const result = new Map();
    const urls = new Map();
    for (const item of items.filter(Boolean)) {
      let key = item.key;
      const urlKey = item.url ? canonicalUrl(item.url) : '';
      if (urlKey && urls.has(urlKey)) {
        const priorKey = urls.get(urlKey);
        if (!item.objectId) key = priorKey;
        else if (priorKey !== key && result.has(priorKey)) {
          const prior = result.get(priorKey);
          result.delete(priorKey);
          result.set(key, { ...prior, ...item });
        }
      }
      const old = result.get(key);
      if (!old) result.set(key, { ...item, key });
      else {
        const updated = { ...old, ...item, key };
        for (const field of ['url', 'originalUrl', 'pdfUrl', 'course', 'chapter', 'sourceTabId', 'objectId', 'ext', 'size']) if (!item[field]) updated[field] = old[field];
        if (item.name === '课件' || (!item.ext && old.ext)) updated.name = old.name;
        updated.type = category(updated.ext);
        // The resource-bearing frame supplies the correct request origin.
        if (!item.url && old.url) updated.sourceUrl = old.sourceUrl;
        result.set(key, updated);
      }
      if (urlKey) urls.set(urlKey, key);
    }
    return [...result.values()];
  }

  function inspect(doc, base, context = {}) {
    const items = [];
    const local = { ...context, base };
    for (const script of doc.querySelectorAll('script:not([src])')) {
      const text = script.textContent || '';
      const json = assignedObject(text, 'mArg');
      if (json) {
        try {
          const data = JSON.parse(json);
          local.course = data.coursename || local.course;
          local.chapter = data.knowledgename || local.chapter;
          for (const attachment of data.attachments || []) items.push(normalizeResource(attachment, local));
        } catch { /* Unsupported legacy object syntax is not executed. */ }
      }
      const info = assignedObject(text, 'fileinfo');
      if (info) {
        const name = doc.querySelector('#fileInfoNameInput')?.value || literalField(info, 'name');
        items.push(normalizeResource({
          name, download: literalField(info, 'download'), objectId: literalField(info, 'objectId'),
          suffix: literalField(info, 'suffix'), filesize: literalField(info, 'filesize'), type: 'document'
        }, local));
      }
    }
    for (const frame of doc.querySelectorAll('iframe[data], [data-objectid]')) {
      try {
        const data = JSON.parse(frame.getAttribute('data') || '{}');
        if (!data.objectid) data.objectid = frame.getAttribute('data-objectid');
        items.push(normalizeResource(data, local));
      } catch { /* Malformed page metadata is ignored. */ }
    }
    for (const element of doc.querySelectorAll('a[href], video[src], audio[src], source[src], embed[src], object[data]')) {
      const raw = element.getAttribute('href') || element.getAttribute('src') || element.getAttribute('data');
      const url = allowedUrl(raw, base);
      if (!url) continue;
      const label = element.getAttribute('download') || element.getAttribute('title') || '';
      if (!extension(label, url)) continue;
      items.push(normalizeResource({ url, name: extension(label) ? label : filenameFromUrl(url) }, local));
    }
    return { resources: mergeResources(items), course: local.course || '', chapter: local.chapter || '' };
  }

  function catalog(doc, base) {
    const chapters = new Map();
    for (const el of doc.querySelectorAll('.posCatalog_name[onclick], [onclick*="getTeacherAjax"], .chapter_item[onclick*="toOld"], a[href*="studentstudy?"]')) {
      const onclick = el.getAttribute('onclick') || '';
      const args = onclick.match(/getTeacherAjax\(\s*['"]?(\d+)['"]?\s*,\s*['"]?(\d+)['"]?\s*,\s*['"]?(\d+)/);
      const homeArgs = onclick.match(/toOld\(\s*['"]?(\d+)['"]?\s*,\s*['"]?(\d+)['"]?\s*,\s*['"]?(\d+)/);
      let id = args?.[3] || homeArgs?.[2];
      const href = allowedUrl(el.getAttribute('href'), base);
      if (!id && href) id = new URL(href).searchParams.get('chapterId');
      if (!id || !/^\d+$/.test(id)) continue;
      const label = (el.getAttribute('title') || el.querySelector('.clicktitle')?.textContent || el.textContent || '章节').trim().replace(/\s+/g, ' ');
      const number = el.querySelector('.posCatalog_sbar, .catalog_sbar')?.textContent?.trim() || '';
      const locked = /(?:^|\s)(?:locked|disabled)(?:\s|$)/.test(el.className || '') || el.getAttribute('aria-disabled') === 'true' || Boolean(el.querySelector('.icon_suo, .catalog_lock'));
      if (!chapters.has(id)) chapters.set(id, { id, name: (number && !label.startsWith(number) ? number + ' ' : '') + label, locked,
        ...(homeArgs ? { courseId: homeArgs[1], clazzId: homeArgs[3] } : {}) });
    }
    return [...chapters.values()];
  }

  function coursePage(value) {
    const valid = allowedUrl(value);
    if (!valid) return false;
    const url = new URL(valid);
    return !url.hostname.endsWith('cldisk.com') && /^\/(?:mooc(?:2)?-ans\/)?mycourse\/(?:stu|studentcourse|studentstudy)\/?$/.test(url.pathname);
  }

  function readablePage(value) {
    const valid = allowedUrl(value);
    if (!valid) return false;
    const url = new URL(valid);
    if (url.pathname === '/mycourse/transfer') {
      const refer = allowedUrl(url.searchParams.get('refer'));
      if (!refer || url.hostname.endsWith('cldisk.com')) return false;
      const destination = new URL(refer);
      return destination.origin === url.origin && destination.pathname === '/mycourse/studentstudy' &&
        /^\d+$/.test(url.searchParams.get('moocId') || '') &&
        destination.searchParams.get('courseId') === url.searchParams.get('moocId') &&
        destination.searchParams.get('clazzid') === url.searchParams.get('clazzid');
    }
    return !url.hostname.endsWith('cldisk.com') && /^\/(?:ananas\/status\/[a-zA-Z0-9_-]{8,128}|(?:mooc(?:2)?-ans\/)?(?:knowledge\/cards|mycourse\/studentstudy(?:Ajax)?))\/?$/.test(url.pathname);
  }

  function safeError(error) {
    const text = String(error?.message || error || '未知错误');
    if (/服务器返回了网页/.test(text)) return '服务器返回了网页而不是课件，请重新登录并扫描。';
    if (/403|SERVER_FORBIDDEN/.test(text)) return '服务器拒绝下载（403）。刷新课件后重新扫描；也可能是当前账号没有下载权限。';
    if (/401|login|登录/.test(text)) return '登录已失效，请在课程页面重新登录后扫描。';
    if (/429/.test(text)) return '请求过于频繁，请稍后重试，或降低并发数。';
    if (/Failed to fetch|NETWORK_|fetch failed/i.test(text)) return '网络请求失败，请检查网络后重试。';
    if (/aborted|timeout|AbortError|TimeoutError/i.test(text)) return '请求超时或已停止，请重试。';
    return text.replace(/https?:\/\/[^\s<>"']+/g, '[链接已隐藏]')
      .replace(/[a-f\d]{24,}/gi, '[标识已隐藏]')
      .replace(/(?:enc|cpi|cookie|token|signature|authorization)\s*[:=]\s*[^\s,;]+/gi, '[敏感字段已隐藏]').slice(0, 240);
  }

  function publicManifest(resources) {
    // Deliberate allowlist: no URL, account/course ID, object ID, signature or tab ID.
    return { schema: 1, createdAt: new Date().toISOString(), items: resources.map(r => ({
      name: r.name, course: r.course, chapter: r.chapter, type: r.type, extension: r.ext, bytes: r.size || 0
    })) };
  }

  function transferResource(resource, settings = {}) {
    const preferPdf = settings.format === 'pdf' || resource.ext === 'pdf';
    if (preferPdf && resource.pdfUrl) {
      const converted = resource.ext !== 'pdf';
      return { ...resource, url: resource.pdfUrl, ext: 'pdf', type: 'document',
        size: converted ? 0 : resource.size,
        name: resource.name.replace(/\.[a-z0-9]{1,8}$/i, '') + '.pdf' };
    }
    if (settings.format === 'pdf' && resource.ext !== 'pdf' && ['document', 'slides', 'sheet'].includes(resource.type)) {
      throw new Error('平台未提供此文件的 PDF 版，请切换为原文件后重试。');
    }
    return { ...resource, url: resource.originalUrl || resource.url };
  }

  globalThis.CoursewareCore = Object.freeze({
    GROUPS, allowedUrl, extension, category, filenameFromUrl, safeName, downloadPath,
    stringLiteral, literalField, assignedObject, normalizeResource, canonicalUrl,
    mergeResources, inspect, catalog, coursePage, readablePage, safeError, publicManifest, transferResource
  });
})();
