/* Minimal in-page entry. No network access until the user opens the panel. */
(() => {
  'use strict';
  if (window.top !== window || !globalThis.CoursewareCore.coursePage(location.href) || globalThis.CoursewareInline) return;
  globalThis.CoursewareInline = true;
  let host, panel, button, open = false, tabId;
  const extensionOrigin = chrome.runtime.getURL('/').replace(/\/$/, '');
  function toggle(value) {
    open = value;
    if (!panel) return;
    panel.hidden = !value;
    button.setAttribute('aria-expanded', String(value));
    if (value) {
      const rect = button.getBoundingClientRect(), view = button.ownerDocument.defaultView;
      const height = Math.min(600, view.innerHeight - 24);
      panel.style.height = height + 'px';
      panel.style.left = Math.max(12, Math.min(rect.right - 470, view.innerWidth - 482)) + 'px';
      panel.style.top = Math.max(12, Math.min(rect.bottom + 8, view.innerHeight - height - 12)) + 'px';
    } else button.focus();
  }
  function install(doc, anchor) {
    if (host?.isConnected) return;
    host = doc.createElement('span');
    host.id = 'courseware-download-entry';
    host.style.cssText = anchor ? 'display:inline-block;margin-left:20px;vertical-align:middle;position:relative;z-index:100;' : 'position:fixed;right:24px;bottom:28px;z-index:2147483600;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const installedHost = host;
    const style = doc.createElement('style');
    style.textContent = ':host{all:initial}button{display:inline-flex;align-items:center;gap:7px;border:1px solid #dce2e7;background:#fff;color:#334155;border-radius:8px;padding:8px 12px;font:500 13px/18px system-ui,"Microsoft YaHei",sans-serif;cursor:pointer;box-shadow:0 1px 2px #0f172a08}button:hover{border-color:#94a3b8;background:#f8fafc}button:focus-visible{outline:2px solid #2563eb;outline-offset:3px}svg{width:16px;height:16px}iframe{position:fixed;z-index:2147483647;width:min(470px,calc(100vw - 24px));border:1px solid #e2e8f0;border-radius:12px;background:white;box-shadow:0 12px 40px #0f172a26;color-scheme:light}iframe[hidden]{display:none}';
    button = doc.createElement('button');
    button.type = 'button'; button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-label', '下载课件');
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.8'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
    const path = doc.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', 'M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4'); svg.append(path);
    button.append(svg, doc.createTextNode('下载课件'));
    button.addEventListener('click', async event => {
      if (!event.isTrusted) return;
      try {
        if (!panel) {
          const reply = await chrome.runtime.sendMessage({ type: 'INLINE_TAB' });
          if (host !== installedHost || !installedHost.isConnected) return;
          if (!reply?.ok) throw new Error();
          tabId = reply.data;
          panel = doc.createElement('iframe');
          panel.title = '课件下载面板'; panel.allow = 'clipboard-write';
          panel.src = chrome.runtime.getURL('manager.html') + '?embedded=1&tab=' + tabId;
          panel.hidden = true; shadow.append(panel);
        }
        toggle(!open);
      } catch { button.textContent = '请刷新页面后重试'; }
    });
    shadow.append(style, button);
    if (anchor) anchor.insertAdjacentElement('afterend', host);
    else doc.body.append(host);
  }
  // Keep the entry in the outer document. A catalog iframe can be inaccessible,
  // still loading, or replaced; none of these should hide the download entry.
  function mount() {
    if (host?.isConnected) return;
    panel = null; open = false;
    install(document, document.querySelector('.headRight .backOld'));
  }
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && open) toggle(false); });
  document.addEventListener('pointerdown', event => { if (open && !event.composedPath().includes(host)) toggle(false); }, true);
  window.addEventListener('message', event => {
    if (panel && event.source === panel.contentWindow && event.origin === extensionOrigin && event.data === 'courseware-close') toggle(false);
  });
  window.addEventListener('resize', () => { if (open) toggle(true); });
  let scheduled;
  new MutationObserver(() => {
    // Throttle, rather than debounce: a busy page must not postpone remounting forever.
    if (!scheduled) scheduled = setTimeout(() => { scheduled = null; mount(); }, 150);
  }).observe(document.body, { childList: true, subtree: true });
  mount();
})();
