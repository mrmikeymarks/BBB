'use strict';
// Node-side rewriting of stylesheet text and listing of URLs referenced by CSS.
const { relativeHref } = require('./urls');

const URL_RE = /url\(\s*(['"]?)([^'")]*?)\1\s*\)/gi;
const IMPORT_RE = /@import\s+(['"])([^'"]+)\1/gi;

function resolveAgainst(u, base) {
  try { return new URL(u, base).href; } catch { return null; }
}

/** Absolute URLs referenced by a stylesheet (url() and @import). */
function cssReferences(cssText, cssUrl) {
  const out = new Set();
  let m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(cssText))) {
    if (!m[2] || /^(data:|blob:|#|about:)/i.test(m[2])) continue;
    const abs = resolveAgainst(m[2], cssUrl);
    if (abs && /^https?:/.test(abs)) out.add(abs.replace(/#.*$/, ''));
  }
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(cssText))) {
    const abs = resolveAgainst(m[2], cssUrl);
    if (abs && /^https?:/.test(abs)) out.add(abs.replace(/#.*$/, ''));
  }
  return [...out];
}

/**
 * Rewrite url()/@import in a stylesheet to relative local paths.
 * lookup(absUrlWithoutHash) -> siteRootRelativeLocalPath | null
 */
function rewriteCss(cssText, cssUrl, cssLocal, lookup) {
  const swap = (raw) => {
    const abs = resolveAgainst(raw, cssUrl);
    if (!abs) return null;
    const hashIdx = abs.indexOf('#');
    const clean = hashIdx >= 0 ? abs.slice(0, hashIdx) : abs;
    const local = lookup(clean);
    if (!local) return null;
    return relativeHref(cssLocal, local) + (hashIdx >= 0 ? abs.slice(hashIdx) : '');
  };
  return cssText
    .replace(URL_RE, (m, q, u) => { if (!u || /^(data:|blob:|#|about:)/i.test(u)) return m; const l = swap(u); return l ? `url(${q}${l}${q})` : m; })
    .replace(IMPORT_RE, (m, q, u) => { const l = swap(u); return l ? `@import ${q}${l}${q}` : m; });
}

module.exports = { cssReferences, rewriteCss };
