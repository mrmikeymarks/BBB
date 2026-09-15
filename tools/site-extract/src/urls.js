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
  [/^text\/xml|^application\/xml/, '.xml'],
  [/^application\/manifest\+json/, '.webmanifest'],
];

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function shortHash(s, n = 8) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, n);
}

function sanitizeSegment(seg) {
  let s = seg.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+$/, '_');
  if (WINDOWS_RESERVED.test(s.replace(/\..*$/, ''))) s = '_' + s;
  if (s.length > 96) s = s.slice(0, 64) + '__' + shortHash(seg) + s.slice(-20).replace(/^[^.]*/, '');
  return s || '_';
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

/** Deterministic local path (posix, relative to site root) for a page URL. */
function pageLocalPath(u) {
  const decoded = safeDecode(u.pathname).replace(/\/+$/, '');
  const segs = decoded.split('/').filter(Boolean).map(sanitizeSegment);
  let file = 'index.html';
  const last = segs[segs.length - 1];
  if (last && /\.[a-z0-9]{1,6}$/i.test(last) && !/^\.+$/.test(last)) {
    segs.pop();
    file = /\.html?$/i.test(last) ? last : last.replace(/\.[^.]+$/, '') + '.html';
  }
  if (u.search) file = file.replace(/\.html?$/i, '') + '__q_' + shortHash(u.search) + '.html';
  return path.posix.join(...segs, file);
}

function extFromContentType(ct) {
  if (!ct) return '';
  for (const [re, ext] of MIME_EXT) if (re.test(ct)) return ext;
  return '';
}

/** Local path (posix, relative to site root) for an asset URL. */
function assetLocalPath(u, contentType) {
  const host = sanitizeSegment(u.hostname + (u.port ? '_' + u.port : ''));
  const decoded = safeDecode(u.pathname);
  const endsWithSlash = decoded.endsWith('/') || decoded === '';
  const segs = decoded.split('/').filter(Boolean).map(sanitizeSegment);
  let file = endsWithSlash ? 'index' : (segs.pop() || 'index');
  const m = file.match(/^(.*?)(\.[A-Za-z0-9]{1,8})?$/);
  let base = m[1] || file;
  let ext = (m[2] || '').toLowerCase();
  if (!base) { base = ext; ext = ''; } // dotfiles like ".well-known"
  const wantExt = extFromContentType(contentType);
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
  const p = localPath.replace(/\/?index\.html$/, '').replace(/\.html$/, '');
  return p ? p.replace(/\//g, '__') : 'home';
}

module.exports = {
  normalizeUrl, normalizePageUrl, isSameSite, looksLikeFile, pageLocalPath, assetLocalPath,
  relativeHref, rootPrefix, slugForPage, shortHash, sanitizeSegment, extFromContentType, registrableHost,
};
