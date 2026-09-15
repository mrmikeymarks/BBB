/* site-extract runtime shim.
 * Loaded first on every mirrored page. Redirects runtime requests (fetch, XHR,
 * dynamically inserted <script>/<img>/<link>/<source>/<iframe>) from their
 * original absolute URLs to the captured local copies listed in _mirror/map.js.
 * Anything not captured passes through untouched (and fails offline exactly as
 * it would without the shim). Service-worker registration is disabled so a
 * cached worker from the live site cannot hijack the mirror.
 */
(function () {
  var ROOT = window.__MIRROR_ROOT || './';
  var ORIGIN = window.__MIRROR_ORIGIN || location.href;
  var MAP = window.__MIRROR_MAP || {};
  function toLocal(u) {
    if (typeof u !== 'string' || !u) return null;
    if (/^(data:|blob:|javascript:|#)/i.test(u)) return null;
    var abs;
    try { abs = new URL(u, ORIGIN).href; } catch (e) { return null; }
    var hash = ''; var hi = abs.indexOf('#');
    if (hi >= 0) { hash = abs.slice(hi); abs = abs.slice(0, hi); }
    var local = MAP[abs];
    if (!local && abs.indexOf('?') < 0 && MAP[abs + '/']) local = MAP[abs + '/'];
    if (!local) return null;
    try { return new URL(ROOT + local, location.href).href + hash; } catch (e) { return ROOT + local + hash; }
  }
  window.__mirrorToLocal = toLocal;

  // fetch()
  if (window.fetch) {
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string') { var l = toLocal(input); if (l) input = l; }
        else if (input && typeof input.url === 'string') { var l2 = toLocal(input.url); if (l2) input = new Request(l2, input); }
      } catch (e) { /* fall through */ }
      return origFetch.call(this, input, init);
    };
  }
  // XMLHttpRequest
  if (window.XMLHttpRequest) {
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      var l = toLocal(typeof url === 'string' ? url : String(url));
      if (l) { var args = Array.prototype.slice.call(arguments); args[1] = l; return origOpen.apply(this, args); }
      return origOpen.apply(this, arguments);
    };
  }
  // Property setters used by bundlers for code-splitting and lazy images.
  function patchProp(proto, prop, isSrcset) {
    if (!proto) return;
    var d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set) return;
    Object.defineProperty(proto, prop, {
      configurable: true, enumerable: d.enumerable,
      get: d.get,
      set: function (v) { d.set.call(this, isSrcset ? rewriteSrcset(v) : (toLocal(String(v)) || v)); }
    });
  }
  function rewriteSrcset(v) {
    return String(v).split(/,\s+/).map(function (cand) {
      var parts = cand.trim().split(/\s+/); var l = toLocal(parts[0]);
      if (l) parts[0] = l; return parts.join(' ');
    }).join(', ');
  }
  patchProp(window.HTMLScriptElement && HTMLScriptElement.prototype, 'src');
  patchProp(window.HTMLImageElement && HTMLImageElement.prototype, 'src');
  patchProp(window.HTMLImageElement && HTMLImageElement.prototype, 'srcset', true);
  patchProp(window.HTMLSourceElement && HTMLSourceElement.prototype, 'src');
  patchProp(window.HTMLSourceElement && HTMLSourceElement.prototype, 'srcset', true);
  patchProp(window.HTMLLinkElement && HTMLLinkElement.prototype, 'href');
  patchProp(window.HTMLIFrameElement && HTMLIFrameElement.prototype, 'src');
  patchProp(window.HTMLMediaElement && HTMLMediaElement.prototype, 'src');
  var origSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    var n = String(name).toLowerCase();
    if (n === 'src' || n === 'href' || n === 'poster' || n === 'data-src') {
      var tag = this.tagName; var l = (tag !== 'A' && tag !== 'AREA' && tag !== 'FORM') ? toLocal(String(value)) : null;
      if (l) value = l;
    } else if (n === 'srcset' || n === 'data-srcset') { value = rewriteSrcset(value); }
    return origSetAttr.call(this, name, value);
  };
  // No service workers in the mirror.
  try { Object.defineProperty(navigator, 'serviceWorker', { get: function () { return undefined; }, configurable: true }); } catch (e) { /* ignore */ }
})();
