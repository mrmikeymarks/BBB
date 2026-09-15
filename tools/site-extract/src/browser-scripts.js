'use strict';
// Functions that run INSIDE the page via page.evaluate(). They must be fully
// self-contained: no references to Node scope, no require().

/**
 * Scan the rendered document: collect page links, referenced asset URLs and
 * a structured text extraction. Runs in the browser.
 */
function scanPage() {
  const abs = (v) => { try { return new URL(v, document.baseURI).href; } catch { return null; } };
  const isHttp = (h) => /^https?:/i.test(h || '');
  const links = new Set();
  const refs = new Set();
  const addRef = (v) => { if (!v || /^\s*#/.test(v)) return; const h = abs(v); if (h && isHttp(h)) refs.add(h); };
  const sheetText = (el) => { // CSSOM-only rules (insertRule / CSS-in-JS) are invisible in textContent
    try { if (el.sheet && el.sheet.cssRules.length && !el.textContent.trim()) return [...el.sheet.cssRules].map((r) => r.cssText).join('\n'); } catch { /* cross-origin */ }
    return el.textContent;
  };

  function parseSrcset(s) {
    const out = []; const toks = String(s || '').trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < toks.length) {
      let url = toks[i++]; let done = false;
      if (url.endsWith(',')) { url = url.replace(/,+$/, ''); done = true; }
      const desc = [];
      while (!done && i < toks.length) {
        let t = toks[i++];
        const ci = t.indexOf(',');
        if (ci >= 0 && ci < t.length - 1) { desc.push(t.slice(0, ci)); toks.splice(i, 0, t.slice(ci + 1)); done = true; break; }
        if (t.endsWith(',')) { t = t.replace(/,+$/, ''); done = true; }
        if (t) desc.push(t);
      }
      if (url) out.push({ url, desc: desc.join(' ') });
    }
    return out;
  }
  const cssUrls = (text) => {
    const out = []; const re = /url\(\s*(['"]?)([^'")]*?)\1\s*\)/gi; let m;
    while ((m = re.exec(text || ''))) if (m[2] && !/^(data:|blob:|#|about:)/i.test(m[2])) out.push(m[2]);
    const im = /@import\s+(['"])([^'"]+)\1/gi;
    while ((m = im.exec(text || ''))) out.push(m[2]);
    return out;
  };

  // ---- links + asset refs -------------------------------------------------
  for (const a of document.querySelectorAll('a[href], area[href]')) {
    const h = abs(a.getAttribute('href'));
    if (h && isHttp(h)) links.add(h);
  }
  const ATTRS = ['src', 'poster', 'data-src', 'data-lazy-src', 'data-original', 'data-bg', 'data-background'];
  for (const el of document.querySelectorAll('*')) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'base') continue;
    for (const at of ATTRS) if (el.hasAttribute(at)) addRef(el.getAttribute(at));
    if (tag === 'link') {
      const rel = (el.getAttribute('rel') || '').toLowerCase();
      if (/stylesheet|icon|preload|modulepreload|prefetch|manifest|apple-touch|mask-icon/.test(rel)) addRef(el.getAttribute('href'));
    }
    if (tag === 'object' && el.hasAttribute('data')) addRef(el.getAttribute('data'));
    if (tag === 'use' || tag === 'image') addRef(el.getAttribute('href') || el.getAttribute('xlink:href'));
    for (const at of ['srcset', 'data-srcset', 'data-lazy-srcset', 'imagesrcset']) if (el.hasAttribute(at)) for (const c of parseSrcset(el.getAttribute(at))) addRef(c.url);
    if (el.hasAttribute('style')) for (const u of cssUrls(el.getAttribute('style'))) addRef(u);
    if (tag === 'style') for (const u of cssUrls(sheetText(el))) addRef(u);
  }
  for (const sheet of (document.adoptedStyleSheets || [])) { try { for (const u of cssUrls([...sheet.cssRules].map((r) => r.cssText).join('\n'))) addRef(u); } catch { /* ignore */ } }

  // ---- text extraction ----------------------------------------------------
  const meta = (sel, attr = 'content') => { const el = document.querySelector(sel); return el ? (el.getAttribute(attr) || '').trim() : ''; };
  const clean = (s) => String(s || '').replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'HEAD', 'META', 'LINK', 'TITLE', 'OPTION', 'INPUT', 'TEXTAREA', 'SELECT']);
  const BLOCK_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'BLOCKQUOTE', 'PRE', 'TD', 'TH', 'FIGCAPTION', 'DT', 'DD', 'SUMMARY', 'CAPTION', 'BUTTON', 'LABEL', 'ADDRESS', 'LEGEND']);
  const STRUCTURAL = 'h1,h2,h3,h4,h5,h6,ul,ol,table';
  const REGION_SEL = 'header, nav, footer, aside, main, article, [role="navigation"], [role="banner"], [role="contentinfo"], [role="main"], [role="complementary"]';
  const parentOf = (n) => n.parentElement || (n.parentNode && n.parentNode.host) || null; // crosses shadow boundaries
  const regionOf = (el) => {
    let r = el.closest(REGION_SEL);
    // header/footer are landmarks only outside article/aside/main/nav/section.
    while (r && (r.tagName === 'HEADER' || r.tagName === 'FOOTER') && r.parentElement && r.parentElement.closest('article, aside, main, nav, section')) r = r.parentElement.closest(REGION_SEL);
    if (!r) { const host = el.getRootNode && el.getRootNode().host; return host ? regionOf(host) : 'body'; }
    const role = (r.getAttribute('role') || '').toLowerCase();
    if (role === 'navigation') return 'nav'; if (role === 'banner') return 'header'; if (role === 'contentinfo') return 'footer';
    if (role === 'main') return 'main'; if (role === 'complementary') return 'aside';
    return r.tagName.toLowerCase();
  };
  const isHidden = (el) => {
    for (let e = el; e && e !== document.documentElement; e = parentOf(e)) {
      if (SKIP.has(e.tagName) && e !== el) return true;
      if (SKIP.has(e.tagName) && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName)) return true;
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || e.getAttribute('aria-hidden') === 'true') return true;
    }
    return false;
  };
  const isBlockDisplay = (el) => /^(block|list-item|table|table-cell|table-row|table-caption|flex|grid|flow-root|-webkit-box)$/.test(getComputedStyle(el).display);
  const isStandalone = (el) => el.tagName === 'A' || el.tagName === 'BUTTON' || /^inline-(block|flex|grid)$/.test(getComputedStyle(el).display);

  // While scanning: authored case instead of CSS text-transform, aria-hidden
  // copies (icon fonts, split-text animation clones) out of the way, closed
  // <details> opened so FAQ/accordion answers are captured. All restored after.
  const tmpStyle = document.createElement('style');
  tmpStyle.textContent = '*,*::before,*::after{text-transform:none!important}[aria-hidden="true"]{display:none!important}';
  document.documentElement.appendChild(tmpStyle);
  const closedDetails = [...document.querySelectorAll('details:not([open])')];
  for (const d of closedDetails) d.open = true;
  const inCollapsed = (el) => closedDetails.some((d) => d.contains(el));

  const shadowHosts = [...document.querySelectorAll('*')].filter((e) => e.shadowRoot);
  const roots = [{ root: document.body, host: null }, ...shadowHosts.map((h) => ({ root: h.shadowRoot, host: h }))];
  const emitted = []; // { el, pos, tag, text? }
  const emittedSet = new Set();
  const insideEmitted = (el) => { for (let e = parentOf(el); e; e = parentOf(e)) if (emittedSet.has(e)) return true; return false; };
  let blocks = [];
  let headings = [];
  let fullTextParts = [];
  let linkList = [];
  try {
    for (const { root, host } of roots) {
      const posOf = (n) => host || n;
      // 1. Elements that are text blocks by markup. Containers that hold their
      //    own structure (headings, lists, tables) are left to their children.
      for (const el of root.querySelectorAll([...BLOCK_TAGS].join(','))) {
        if (isHidden(el) || insideEmitted(el)) continue;
        if (el.querySelector(STRUCTURAL)) continue;
        if (!clean(el.innerText)) continue;
        emitted.push({ el, pos: posOf(el), tag: el.tagName.toLowerCase() }); emittedSet.add(el);
      }
      // 2. Form controls carry their text in attributes.
      for (const el of root.querySelectorAll('input[type="submit"],input[type="button"],input[type="reset"],input[placeholder],textarea[placeholder],select')) {
        if (isHidden(el)) continue;
        let tag = 'input'; let text = '';
        if (el.tagName === 'SELECT') { tag = 'select'; text = [...el.options].map((o) => clean(o.textContent)).filter(Boolean).join(' | '); }
        else if (/^(submit|button|reset)$/i.test(el.type)) { tag = 'button'; text = clean(el.value); }
        else text = clean(el.getAttribute('placeholder'));
        if (text) emitted.push({ el, pos: posOf(el), tag, text });
      }
      // 3. Everything else: text not inside a block tag, grouped by its nearest
      //    block-level ancestor and split into inline runs.
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const hosts = new Set();
      let node;
      while ((node = walker.nextNode())) {
        if (!node.nodeValue || !node.nodeValue.trim()) continue;
        const parent = node.parentElement;
        if (!parent || isHidden(parent) || emittedSet.has(parent) || insideEmitted(parent)) continue;
        let h = parent;
        while (h && h !== root && !(h.nodeType === 1 && isBlockDisplay(h))) h = h.parentElement;
        hosts.add(h && h.nodeType === 1 ? h : (root.nodeType === 1 ? root : parent));
      }
      const emittedList = [...emittedSet];
      const wrapsOthers = (el) => emittedList.some((e) => e !== el && el.contains(e)) || [...hosts].some((x) => x !== el && el.contains(x));
      const textOf = (n) => (n.nodeType === 3 ? n.nodeValue : (n.nodeType === 1 && !isHidden(n) ? n.innerText : ''));
      for (const hostEl of hosts) {
        let run = [];
        const runHasText = () => run.some((n) => n.nodeType === 3 && n.nodeValue.trim());
        const flush = () => {
          if (run.length) {
            const text = clean(run.map(textOf).join(''));
            const els = run.filter((n) => n.nodeType === 1);
            const single = els.length === 1 && !runHasText() ? els[0] : null;
            if (text) emitted.push({ el: single || els[0] || hostEl, pos: posOf(run[0]), tag: (single || hostEl).tagName.toLowerCase(), text });
          }
          run = [];
        };
        const visit = (child) => {
          if (child.nodeType === 3) { run.push(child); return; }
          if (child.nodeType !== 1 || SKIP.has(child.tagName) || isHidden(child)) return;
          if (emittedSet.has(child) || isBlockDisplay(child)) { flush(); return; } // handled as its own block / host
          if (wrapsOthers(child)) { flush(); for (const c of child.childNodes) visit(c); flush(); return; } // inline wrapper around blocks (card links)
          if (isStandalone(child) && !runHasText()) { flush(); run.push(child); flush(); return; } // adjacent links / buttons
          run.push(child);
        };
        for (const child of hostEl.childNodes) visit(child);
        flush();
      }
      headings.push(...[...root.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter((h) => !isHidden(h)).map((h) => ({ level: +h.tagName[1], text: clean(h.innerText) })).filter((h) => h.text));
      fullTextParts.push(clean(host ? [...root.children].filter((c) => !SKIP.has(c.tagName)).map((c) => c.innerText).join('\n') : document.body.innerText));
    }
    emitted.sort((a, b) => (a.pos === b.pos ? 0 : (a.pos.compareDocumentPosition(b.pos) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1));
    for (const { el, tag, text: preText } of emitted) {
      const text = preText !== undefined ? preText : clean(el.innerText);
      if (!text) continue;
      const b = { tag, region: regionOf(el), text };
      const m = tag.match(/^h([1-6])$/); if (m) b.level = +m[1];
      if (tag === 'li') b.list = el.parentElement && el.parentElement.tagName === 'OL' ? 'ol' : 'ul';
      const a = tag === 'a' ? el : el.closest('a');
      if (a) { const h = abs(a.getAttribute('href')); if (h) b.href = h; }
      else { const inner = el.querySelectorAll ? el.querySelectorAll('a[href]') : []; if (inner.length === 1 && clean(inner[0].innerText) === text) { const h = abs(inner[0].getAttribute('href')); if (h) b.href = h; } }
      if (inCollapsed(el)) b.collapsed = true;
      if (el.getRootNode && el.getRootNode() !== document) b.shadow = true;
      blocks.push(b);
    }
    linkList = [...document.querySelectorAll('a[href]')].filter((a) => !isHidden(a)).map((a) => ({ text: clean(a.innerText) || clean(a.getAttribute('aria-label')) || clean(a.getAttribute('title')), href: abs(a.getAttribute('href')), region: regionOf(a) })).filter((l) => l.href);
  } finally {
    tmpStyle.remove();
    for (const d of closedDetails) d.open = false;
  }

  const images = [...document.querySelectorAll('img')].map((img) => ({ src: abs(img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src')), alt: clean(img.getAttribute('alt')), width: img.naturalWidth || null, height: img.naturalHeight || null })).filter((i) => i.src);
  const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => { try { return JSON.parse(s.textContent); } catch { return { _raw: s.textContent }; } });
  const metas = [...document.querySelectorAll('meta[name], meta[property]')].map((m) => ({ name: m.getAttribute('name') || m.getAttribute('property'), content: m.getAttribute('content') || '' })).filter((m) => m.content);

  const content = {
    title: clean(document.title),
    lang: document.documentElement.getAttribute('lang') || '',
    description: meta('meta[name="description"]'),
    canonical: (document.querySelector('link[rel="canonical"]') || {}).href || '',
    og: { title: meta('meta[property="og:title"]'), description: meta('meta[property="og:description"]'), image: meta('meta[property="og:image"]'), type: meta('meta[property="og:type"]') },
    metas, headings, blocks, links: linkList, images, jsonLd,
    fullText: clean(fullTextParts.join('\n\n')),
  };
  return { links: [...links], refs: [...refs], content };
}

/**
 * Serialise the document with every captured reference rewritten to a local
 * relative path. Works on a detached clone so the live page never re-fetches.
 * Runs in the browser. `arg.map` is { absoluteUrl: siteRootRelativeLocalPath }.
 */
function rewriteDocument(arg) {
  const { map, pageLocal, rootPrefix, stripScripts, pagePathFor, origin, stamp } = arg;
  const abs = (v) => { try { return new URL(v, document.baseURI).href; } catch { return null; } };
  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const rel = (toLocal) => {
    const from = dirOf(pageLocal).split('/').filter(Boolean);
    const to = toLocal.split('/');
    let i = 0; while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
    const up = from.length - i;
    return (up ? '../'.repeat(up) : '') + to.slice(i).join('/');
  };
  const noHash = (h) => h.replace(/#.*$/, '');
  const hashOf = (h) => { const i = h.indexOf('#'); return i >= 0 ? h.slice(i) : ''; };
  const localFor = (v) => { if (!v || /^\s*#/.test(v)) return null; const h = abs(v); if (!h) return null; const l = map[noHash(h)] || map[h]; return l ? rel(l) + hashOf(h) : null; };
  const pageMap = pagePathFor || {};

  function parseSrcset(s) {
    const out = []; const toks = String(s || '').trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < toks.length) {
      let url = toks[i++]; let done = false;
      if (url.endsWith(',')) { url = url.replace(/,+$/, ''); done = true; }
      const desc = [];
      while (!done && i < toks.length) {
        let t = toks[i++];
        const ci = t.indexOf(',');
        if (ci >= 0 && ci < t.length - 1) { desc.push(t.slice(0, ci)); toks.splice(i, 0, t.slice(ci + 1)); done = true; break; }
        if (t.endsWith(',')) { t = t.replace(/,+$/, ''); done = true; }
        if (t) desc.push(t);
      }
      if (url) out.push({ url, desc: desc.join(' ') });
    }
    return out;
  }
  const rewriteSrcset = (v) => parseSrcset(v).map((c) => (localFor(c.url) || c.url) + (c.desc ? ' ' + c.desc : '')).join(', ');
  const rewriteCssText = (text) => String(text || '')
    .replace(/url\(\s*(['"]?)([^'")]*?)\1\s*\)/gi, (m, q, u) => { if (!u || /^(data:|blob:|#|about:)/i.test(u)) return m; const l = localFor(u); return l ? `url(${q}${l}${q})` : m; })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => { const l = localFor(u); return l ? `@import ${q}${l}${q}` : m; });

  const root = document.documentElement.cloneNode(true);
  // Stylesheets whose rules live only in the CSSOM (insertRule, CSS-in-JS) have
  // an empty text node in the clone; serialise the live rules into it.
  const liveStyles = document.querySelectorAll('style');
  const cloneStyles = root.querySelectorAll('style');
  if (liveStyles.length === cloneStyles.length) {
    liveStyles.forEach((live, i) => {
      try { if (live.sheet && live.sheet.cssRules.length && !live.textContent.trim()) cloneStyles[i].textContent = [...live.sheet.cssRules].map((r) => r.cssText).join('\n'); } catch { /* ignore */ }
    });
  }
  const headEl = root.querySelector('head') || root;
  for (const sheet of (document.adoptedStyleSheets || [])) {
    try { const st = document.createElement('style'); st.setAttribute('data-mirror', 'adopted'); st.textContent = [...sheet.cssRules].map((r) => r.cssText).join('\n'); headEl.appendChild(st); } catch { /* ignore */ }
  }
  // Drop things that break an offline copy. The file is written as UTF-8, so
  // the charset declaration must say so whatever the live page declared.
  for (const el of root.querySelectorAll('base, meta[http-equiv="Content-Security-Policy" i], meta[charset], meta[http-equiv="Content-Type" i]')) el.remove();
  const charset = document.createElement('meta'); charset.setAttribute('charset', 'utf-8'); headEl.insertBefore(charset, headEl.firstChild);
  // Freeze the base URL at the page file so relative paths (and same-page
  // anchors) keep resolving after an SPA router calls history.pushState().
  const baseEl = document.createElement('base'); baseEl.setAttribute('href', pageLocal.split('/').pop()); baseEl.setAttribute('data-mirror', 'base');
  headEl.insertBefore(baseEl, charset.nextSibling);
  if (stripScripts) for (const s of root.querySelectorAll('script')) { if ((s.getAttribute('type') || '').toLowerCase() !== 'application/ld+json') s.remove(); }

  const ATTRS = ['src', 'poster', 'data-src', 'data-lazy-src', 'data-original', 'data-bg', 'data-background'];
  for (const el of root.querySelectorAll('*')) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' || tag === 'area') {
      const rawHref = el.getAttribute('href') || '';
      const h = /^\s*#/.test(rawHref) ? null : abs(rawHref); // same-page anchors stay as they are
      if (h && /^https?:/i.test(h)) {
        const key = noHash(h);
        const lp = pageMap[key] || pageMap[key.replace(/\/+$/, '')];
        const l = lp ? rel(lp) + hashOf(h) : localFor(h); // known pages win over a raw captured copy
        if (l) el.setAttribute('href', l);
      }
      // fall through: an <a> can also carry style/data-src/etc.
    }
    if (tag === 'form') continue;
    for (const at of ATTRS) if (el.hasAttribute(at)) { const l = localFor(el.getAttribute(at)); if (l) el.setAttribute(at, l); }
    if (tag === 'link') {
      const rel_ = (el.getAttribute('rel') || '').toLowerCase();
      if (/preconnect|dns-prefetch/.test(rel_)) { el.remove(); continue; }
      const l = localFor(el.getAttribute('href'));
      if (l) { el.setAttribute('href', l); el.removeAttribute('integrity'); el.removeAttribute('crossorigin'); }
    }
    if (tag === 'script' && el.hasAttribute('src') && localFor(el.getAttribute('src'))) { el.removeAttribute('integrity'); el.removeAttribute('crossorigin'); }
    if (tag === 'object' && el.hasAttribute('data')) { const l = localFor(el.getAttribute('data')); if (l) el.setAttribute('data', l); }
    if (tag === 'use' || tag === 'image') {
      for (const at of ['href', 'xlink:href']) if (el.hasAttribute(at)) { const l = localFor(el.getAttribute(at)); if (l) el.setAttribute(at, l); }
    }
    for (const at of ['srcset', 'data-srcset', 'data-lazy-srcset', 'imagesrcset']) if (el.hasAttribute(at)) el.setAttribute(at, rewriteSrcset(el.getAttribute(at)));
    if (el.hasAttribute('style')) el.setAttribute('style', rewriteCssText(el.getAttribute('style')));
    if (tag === 'style') el.textContent = rewriteCssText(el.textContent);
    if (tag === 'iframe' && el.hasAttribute('src')) { const l = localFor(el.getAttribute('src')); if (l) el.setAttribute('src', l); }
  }

  // Runtime shim: must be the very first script so later code sees patched APIs.
  if (!stripScripts) {
    const head = root.querySelector('head') || root;
    const mapScript = document.createElement('script');
    mapScript.setAttribute('src', rootPrefix + '_mirror/map.js');
    mapScript.setAttribute('data-mirror', 'map');
    const cfg = document.createElement('script');
    cfg.setAttribute('data-mirror', 'config');
    cfg.textContent = `window.__MIRROR_ROOT=${JSON.stringify(rootPrefix)};window.__MIRROR_ORIGIN=${JSON.stringify(document.baseURI)};`;
    const shim = document.createElement('script');
    shim.setAttribute('src', rootPrefix + '_mirror/shim.js');
    shim.setAttribute('data-mirror', 'shim');
    const anchor = baseEl.nextSibling;
    head.insertBefore(cfg, anchor);
    head.insertBefore(mapScript, anchor);
    head.insertBefore(shim, anchor);
  }

  const doctype = document.doctype ? `<!DOCTYPE ${document.doctype.name}${document.doctype.publicId ? ` PUBLIC "${document.doctype.publicId}"` : ''}${document.doctype.systemId ? ` "${document.doctype.systemId}"` : ''}>` : '<!DOCTYPE html>';
  return `${doctype}\n<!-- mirrored from ${origin} at ${stamp} by site-extract -->\n${root.outerHTML}`;
}

/** Scroll through the page to trigger lazy loading, then return to the top. */
async function autoScroll(stepPx, pauseMs) {
  const total = () => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
  let y = 0; let guard = 0;
  while (y < total() && guard++ < 400) { y += stepPx; window.scrollTo(0, y); await new Promise((r) => setTimeout(r, pauseMs)); }
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, pauseMs));
}

module.exports = { scanPage, rewriteDocument, autoScroll };
