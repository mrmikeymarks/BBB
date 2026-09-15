/* site-extract runtime shim.
 * Loaded first on every mirrored page. Redirects runtime requests (fetch, XHR,
 * dynamically inserted <script>/<img>/<link>/<source>/<iframe>/<video>) from
 * their original absolute URLs to the captured local copies listed in
 * _mirror/map.js. Anything not captured passes through untouched (and fails
 * offline exactly as it would without the shim). Service workers are removed
 * so a worker cached from the live site cannot hijack the mirror.
 */
(function () {
  var ROOT = window.__MIRROR_ROOT || './';
  var ORIGIN = window.__MIRROR_ORIGIN || location.href;
  var MAP = window.__MIRROR_MAP || {};
  // Anchor the mirror root now: SPA routers call history.pushState() later and
  // location.href stops pointing at the page file.
  var ROOT_ABS;
  try { ROOT_ABS = new URL(ROOT, document.baseURI || location.href).href; } catch (e) { ROOT_ABS = ROOT; }
  var SITE_ORIGIN = null;
  try { SITE_ORIGIN = new URL(ORIGIN).origin; } catch (e) { /* ignore */ }

  function toLocal(u) {
    if (typeof u !== 'string' || !u) return null;
    if (/^(data:|blob:|javascript:|#|about:)/i.test(u)) return null;
    var abs;
    try { abs = new URL(u, ORIGIN).href; } catch (e) { return null; }
    var hash = ''; var hi = abs.indexOf('#');
    if (hi >= 0) { hash = abs.slice(hi); abs = abs.slice(0, hi); }
    // URLs the site built from the mirror's own location.origin refer to the site origin.
    if (SITE_ORIGIN && SITE_ORIGIN !== location.origin && abs.indexOf(location.origin + '/') === 0) {
      var asSite = SITE_ORIGIN + abs.slice(location.origin.length);
      if (MAP[asSite]) abs = asSite; // only when that exact site URL was captured
    }
    var local = MAP[abs];
    if (!local && abs.indexOf('?') < 0 && MAP[abs + '/']) local = MAP[abs + '/'];
    if (!local) return null;
    try { return new URL(local, ROOT_ABS).href + hash; } catch (e) { return ROOT_ABS + local + hash; }
  }
  window.__mirrorToLocal = toLocal;

  function parseSrcset(s) {
    var out = []; var toks = String(s || '').trim().split(/\s+/).filter(Boolean); var i = 0;
    while (i < toks.length) {
      var url = toks[i++]; var done = false;
      if (url.slice(-1) === ',') { url = url.replace(/,+$/, ''); done = true; }
      var desc = [];
      while (!done && i < toks.length) {
        var t = toks[i++]; var ci = t.indexOf(',');
        if (ci >= 0 && ci < t.length - 1) { desc.push(t.slice(0, ci)); toks.splice(i, 0, t.slice(ci + 1)); done = true; break; }
        if (t.slice(-1) === ',') { t = t.replace(/,+$/, ''); done = true; }
        if (t) desc.push(t);
      }
      if (url) out.push({ url: url, desc: desc.join(' ') });
    }
    return out;
  }
  function rewriteSrcset(v) {
    return parseSrcset(v).map(function (c) { return (toLocal(c.url) || c.url) + (c.desc ? ' ' + c.desc : ''); }).join(', ');
  }

  // fetch(): strings, URL objects and Request objects. A mapped request is
  // served by a static file server, so it becomes a plain GET.
  if (window.fetch) {
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        var l = null;
        if (typeof input === 'string') { l = toLocal(input); if (l) input = l; }
        else if (input && typeof input.href === 'string' && !(window.Request && input instanceof Request)) { l = toLocal(input.href); if (l) input = l; }
        else if (input && typeof input.url === 'string') { l = toLocal(input.url); if (l) input = new Request(l, { headers: input.headers, mode: input.mode === 'navigate' ? 'cors' : input.mode, credentials: input.credentials, cache: input.cache, redirect: input.redirect, referrer: input.referrer }); }
        if (l) { init = Object.assign({}, init || {}); init.method = 'GET'; delete init.body; }
      } catch (e) { /* fall through with the original arguments */ }
      return origFetch.call(this, input, init);
    };
  }
  // XMLHttpRequest
  if (window.XMLHttpRequest) {
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      var l = toLocal(typeof url === 'string' ? url : String(url));
      if (l) { var args = Array.prototype.slice.call(arguments); args[0] = 'GET'; args[1] = l; return origOpen.apply(this, args); }
      return origOpen.apply(this, arguments);
    };
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () { try { return origSend.apply(this, arguments); } catch (e) { return origSend.call(this); } };
  }
  // sendBeacon has nowhere to go offline; report success so callers do not retry.
  if (navigator.sendBeacon) { try { navigator.sendBeacon = function () { return true; }; } catch (e) { /* ignore */ } }

  // Property setters used by bundlers for code-splitting and by lazy-image code.
  function patchProp(proto, prop, isSrcset) {
    if (!proto) return;
    var d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set) return;
    Object.defineProperty(proto, prop, {
      configurable: true, enumerable: d.enumerable,
      get: d.get,
      set: function (v) {
        var nv = v;
        try { nv = isSrcset ? rewriteSrcset(v) : (toLocal(String(v)) || v); } catch (e) { nv = v; }
        return d.set.call(this, nv);
      }
    });
  }
  patchProp(window.HTMLScriptElement && HTMLScriptElement.prototype, 'src');
  patchProp(window.HTMLImageElement && HTMLImageElement.prototype, 'src');
  patchProp(window.HTMLImageElement && HTMLImageElement.prototype, 'srcset', true);
  patchProp(window.HTMLSourceElement && HTMLSourceElement.prototype, 'src');
  patchProp(window.HTMLSourceElement && HTMLSourceElement.prototype, 'srcset', true);
  patchProp(window.HTMLLinkElement && HTMLLinkElement.prototype, 'href');
  patchProp(window.HTMLIFrameElement && HTMLIFrameElement.prototype, 'src');
  patchProp(window.HTMLMediaElement && HTMLMediaElement.prototype, 'src');
  patchProp(window.HTMLTrackElement && HTMLTrackElement.prototype, 'src');
  patchProp(window.HTMLEmbedElement && HTMLEmbedElement.prototype, 'src');
  patchProp(window.HTMLObjectElement && HTMLObjectElement.prototype, 'data');
  var origSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    try {
      var n = String(name).toLowerCase();
      var tag = this.tagName;
      if (n === 'src' || n === 'href' || n === 'poster' || n === 'data-src' || n === 'data-lazy-src' || n === 'data' || n === 'xlink:href') {
        var l = (tag !== 'A' && tag !== 'AREA' && tag !== 'FORM' && tag !== 'BASE') ? toLocal(String(value)) : null;
        if (l) value = l;
      } else if (n === 'srcset' || n === 'data-srcset' || n === 'imagesrcset') { value = rewriteSrcset(value); }
    } catch (e) { /* keep the original value */ }
    return origSetAttr.call(this, name, value);
  };
  var origSetAttrNS = Element.prototype.setAttributeNS;
  Element.prototype.setAttributeNS = function (ns, name, value) {
    try { if (/href$/i.test(String(name))) { var l = toLocal(String(value)); if (l) value = l; } } catch (e) { /* ignore */ }
    return origSetAttrNS.call(this, ns, name, value);
  };

  // No service workers in the mirror: make feature detection fail cleanly.
  try {
    if (window.Navigator && Navigator.prototype && 'serviceWorker' in Navigator.prototype) delete Navigator.prototype.serviceWorker;
    if ('serviceWorker' in navigator) delete navigator.serviceWorker;
  } catch (e) { /* ignore */ }
  if ('serviceWorker' in navigator) {
    var inert = { register: function () { return Promise.reject(new Error('service workers are disabled in this mirror')); }, getRegistration: function () { return Promise.resolve(undefined); }, getRegistrations: function () { return Promise.resolve([]); }, ready: new Promise(function () {}), controller: null, addEventListener: function () {}, removeEventListener: function () {}, startMessages: function () {} };
    try { Object.defineProperty(navigator, 'serviceWorker', { get: function () { return inert; }, configurable: true }); } catch (e) { /* ignore */ }
  }
})();
