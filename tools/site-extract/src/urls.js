'use strict';
// URL normalisation and URL -> local-path mapping for the mirror.
const crypto = require('crypto');
const path = require('path');

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid', '_ga', '_gl', 'igshid',
]);

// Extensions that mark a same-site link as a downloadable file rather than a page.
const FILE_EXT = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|gz|tar|csv|txt|rtf|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|mp3|mp4|m4a|m4v|mov|avi|webm|ogg|wav|woff2?|ttf|otf|eot|css|js|mjs|json|xml|rss|atom|ics|vcf|apk|dmg|exe|msi)$/i;

const MIME_EXT = [
  [/^text\/css/, '.css'],
  [/javascript|ecmascript/, '.js'],
  [/^application\/json|\+json/, '.json'],
  [/^text\/html|^application\/xhtml/, '.html'],
  [/^image\/svg/, '.svg'],
  [/^image\/png/, '.png'],
  [/^image\/jpe?g/, '.jpg'],
  [/^image\/gif/, '.gif'],
  [/^image\/webp/, '.webp'],
  [/^image\/avif/, '.avif'],
  [/^image\/x-icon|^image\/vnd\.microsoft\.icon/, '.ico'],
  [/^font\/woff2|^application\/font-woff2/, '.woff2'],
  [/^font\/woff|^application\/font-woff|^application\/x-font-woff/, '.woff'],
  [/^font\/ttf|^application\/x-font-ttf/, '.ttf'],
  [/^font\/otf|^application\/x-font-otf/, '.otf'],
  [/^video\/mp4/, '.mp4'],
  [/^video\/webm/, '.webm'],
  [/^audio\/mpeg/, '.mp3'],
  [/^application\/pdf/, '.pdf'],
  [/^text\/plain/, '.txt'],
  [/^text\/xml|^application\/xml|\+xml$/, '.xml'],
  [/^application\/manifest\+json/, '.webmanifest'],
];

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function shortHash(s, n = 8) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, n);
}

/**
 * Filesystem-safe path segment. Injective enough for mirroring: when any
 * character had to be replaced, a short hash of the original is appended
 * (before the extension) so distinct segments never collapse onto one name.
 */
function sanitizeSegment(seg) {
  const m = seg.match(/^(.*?)(\.[A-Za-z0-9]{1,8})?$/);
  let base = m[1];
  let ext = m[2] || '';
  if (!base) { base = ext; ext = ''; }
  let s = base.replace(/[^A-Za-z0-9._-]+/g, '_');
  if (/^\.+$/.test(s)) s = '_';
  if (s !== base) s = (s.replace(/_+$/, '') || '_') + '-' + shortHash(seg, 6);
  if (WINDOWS_RESERVED.test(s.replace(/\..*$/, ''))) s = '_' + s;
  if (s.length > 96) s = s.slice(0, 64) + '__' + shortHash(seg);
  const extSafe = ext.replace(/[^A-Za-z0-9.]/g, '');
  return (s || '_') + extSafe;
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Parse + canonicalise a URL. Returns a URL object or null when not http(s). */
function normalizeUrl(raw, base) {
  let u;
  try { u = new URL(String(raw).trim(), base); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.username = '';
  u.password = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = '';
  return u;
}

/** Page-level normalisation: also drop tracking params, sort params, trim trailing slash. */
function normalizePageUrl(raw, base) {
  const u = normalizeUrl(raw, base);
  if (!u) return null;
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.has(k.toLowerCase())) u.searchParams.delete(k);
  u.searchParams.sort();
  if (u.search === '?') u.search = '';
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  return u;
}

function registrableHost(hostname) {
  return hostname.toLowerCase().replace(/^www\./, '');
}

/** Same-site test for crawl scope. */
function isSameSite(u, startUrl, { includeSubdomains = false, allowHosts = [] } = {}) {
  const h = u.hostname.toLowerCase();
  const root = registrableHost(startUrl.hostname);
  if (h === startUrl.hostname.toLowerCase() || registrableHost(h) === root) return true;
  if (includeSubdomains && h.endsWith('.' + root)) return true;
  return allowHosts.some((a) => h === a.toLowerCase() || h.endsWith('.' + a.toLowerCase()));
}

function looksLikeFile(u) {
  return FILE_EXT.test(u.pathname);
}

/**
 * Deterministic local path (posix, relative to site root) for a page URL.
 * `/` -> index.html, `/about` -> about/index.html, `/a/b.html` -> a/b.html,
 * anything else with a dotted last segment (`/about.php`, `/team/j.smith`) is
 * kept verbatim as a directory. Pages on a host other than the start host
 * (subdomains, --allow-host, other ports) live under _hosts/<host>/.
 */
function pageLocalPath(u, startUrl) {
  const decoded = safeDecode(u.pathname).replace(/\/+$/, '');
  const segs = decoded.split('/').filter(Boolean).map(sanitizeSegment);
  let file = 'index.html';
  const last = segs[segs.length - 1];
  if (last && /\.html?$/i.test(last)) file = segs.pop();
  if (u.search) file = file.replace(/\.html?$/i, '') + '__q_' + shortHash(u.search) + '.html';
  const prefix = [];
  if (startUrl && (registrableHost(u.hostname) !== registrableHost(startUrl.hostname) || u.port !== startUrl.port)) {
    prefix.push('_hosts', sanitizeSegment(u.hostname + (u.port ? '_' + u.port : '')));
  }
  return path.posix.join(...prefix, ...segs, file);
}

function extFromContentType(ct) {
  if (!ct) return '';
  for (const [re, ext] of MIME_EXT) if (re.test(ct)) return ext;
  return '';
}

/**
 * Local path (posix, relative to site root) for an asset URL. `fileNameHint`
 * (Content-Disposition filename) supplies an extension when neither the URL
 * nor the content type has a useful one.
 */
function assetLocalPath(u, contentType, fileNameHint) {
  const host = sanitizeSegment(u.hostname + (u.port ? '_' + u.port : ''));
  const decoded = safeDecode(u.pathname);
  const endsWithSlash = decoded.endsWith('/') || decoded === '';
  const segs = decoded.split('/').filter(Boolean).map(sanitizeSegment);
  let file = endsWithSlash ? 'index' : (segs.pop() || 'index');
  const m = file.match(/^(.*?)(\.[A-Za-z0-9]{1,8})?$/);
  let base = m[1] || file;
  let ext = (m[2] || '').toLowerCase();
  if (!base) { base = ext; ext = ''; } // dotfiles like ".well-known"
  let wantExt = extFromContentType(contentType);
  if (!wantExt && !ext && fileNameHint) { const hm = String(fileNameHint).match(/(\.[A-Za-z0-9]{1,8})$/); if (hm) wantExt = hm[1].toLowerCase(); }
  if (wantExt) {
    const okFamily = (ext === wantExt)
      || (wantExt === '.js' && (ext === '.mjs' || ext === '.cjs'))
      || (wantExt === '.jpg' && ext === '.jpeg')
      || (wantExt === '.html' && ext === '.htm')
      || (wantExt === '.txt' && (ext === '.md' || ext === '.map'))
      || (wantExt === '.xml' && (ext === '.rss' || ext === '.atom' || ext === '.svg'));
    if (!okFamily) { base = base + (ext ? ext.replace('.', '_') : ''); ext = wantExt; }
  }
  if (u.search) base = base + '__q_' + shortHash(u.search);
  return path.posix.join('_assets', host, ...segs, base + ext);
}

/** Relative href from one local file to another (both posix, site-root relative). */
function relativeHref(fromLocal, toLocal) {
  const rel = path.posix.relative(path.posix.dirname(fromLocal), toLocal);
  return rel === '' ? path.posix.basename(toLocal) : rel;
}

/** Prefix that takes a page back to the site root (e.g. "../../" or ""). */
function rootPrefix(fromLocal) {
  const depth = fromLocal.split('/').length - 1;
  return depth ? '../'.repeat(depth) : './';
}

function slugForPage(localPath) {
  const p = localPath.replace(/\/?index\.html$/, '').replace(/\.html$/, '').replace(/^_hosts\//, '');
  return p ? p.replace(/\//g, '__') : 'home';
}

module.exports = {
  normalizeUrl, normalizePageUrl, isSameSite, looksLikeFile, pageLocalPath, assetLocalPath,
  relativeHref, rootPrefix, slugForPage, shortHash, sanitizeSegment, extFromContentType, registrableHost,
};
