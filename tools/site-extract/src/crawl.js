#!/usr/bin/env node
'use strict';
/**
 * site-extract: crawl a website with a real browser, save a self-contained
 * offline mirror (rendered HTML + every asset, links rewritten) and a
 * structured text extraction (JSON + Markdown) for every page.
 *
 *   node src/crawl.js https://www.example.com --out ./example.com
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { chromium } = require('playwright');
const U = require('./urls');
const { cssReferences, rewriteCss } = require('./rewrite');
const B = require('./browser-scripts');

const DEFAULTS = {
  out: null,
  maxPages: 500,
  maxAssets: 20000,
  maxAssetBytes: 100 * 1024 * 1024,
  concurrency: 3,
  delay: 250,
  wait: 1500,
  timeout: 45000,
  includeSubdomains: false,
  allowHosts: [],
  seeds: [],
  stripScripts: false,
  screenshots: true,
  sitemap: true,
  headless: true,
  proxy: null,
  chromium: process.env.SITE_EXTRACT_CHROMIUM || null,
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  viewport: { width: 1366, height: 900 },
  log: (...a) => console.error(...a),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const firstLine = (e) => String(e && e.message ? e.message : e).split('\n')[0];

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

async function writeFileSafe(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, data);
}

class Crawler {
  constructor(startUrl, opts) {
    this.opts = { ...DEFAULTS, ...opts };
    this.start = U.normalizePageUrl(startUrl);
    if (!this.start) throw new Error(`Not an http(s) URL: ${startUrl}`);
    this.outDir = path.resolve(this.opts.out || this.start.hostname);
    this.siteDir = path.join(this.outDir, 'site');
    this.contentDir = path.join(this.outDir, 'content');
    this.shotsDir = path.join(this.outDir, 'screenshots');
    this.pages = new Map();        // normalized href -> page record
    this.queue = [];
    this.assets = new Map();       // abs url (no hash) -> { local, contentType, size, kind }
    this.localPaths = new Map();   // local file path -> abs url (collision guard)
    this.dirPrefixes = new Set();  // every directory prefix of a saved asset
    this.pageLocals = new Map();   // page local path -> page url
    this.redirects = new Map();    // abs url -> abs url
    this.failed = new Map();       // abs url -> reason
    this.inFlight = new Map();     // abs url -> promise
    this.cssText = new Map();      // abs url -> stylesheet text (written at finalize)
    this.contents = [];            // per-page extraction summaries
    this.pagesDone = 0;
    this.log = this.opts.log;
  }

  isSameSite(u) { return U.isSameSite(u, this.start, this.opts); }
  pageLocal(u) { return U.pageLocalPath(u, this.start); }

  enqueue(href) {
    if (this.pages.has(href)) return false;
    this.pages.set(href, { url: href, done: false });
    this.queue.push(href);
    return true;
  }

  resolveLocal(key) {
    let k = key;
    for (let hop = 0; hop < 10 && k; hop++) {
      const a = this.assets.get(k);
      if (a && a.local) return a.local;
      k = this.redirects.get(k);
    }
    return null;
  }

  /** absolute url -> site-root-relative local path, including redirect sources. */
  buildMap() {
    const map = {};
    for (const [k, a] of this.assets) if (a.local) map[k] = a.local;
    for (const k of this.redirects.keys()) { const l = this.resolveLocal(k); if (l) map[k] = l; }
    return map;
  }

  /** Pick a local path that collides with no other file and no directory. */
  claimLocalPath(wanted, key) {
    let local = wanted;
    const suffixLeaf = (p, suf) => p.replace(/(\.[^./]+)?$/, (m) => `${suf}${m || ''}`);
    for (let guard = 0; guard < 8; guard++) {
      if (this.localPaths.has(local) && this.localPaths.get(local) !== key) { local = suffixLeaf(local, `__${U.shortHash(key)}`); continue; }
      const parts = local.split('/');
      let fileAncestor = null;
      for (let i = 1; i < parts.length; i++) { const pre = parts.slice(0, i).join('/'); if (this.localPaths.has(pre)) { fileAncestor = pre; break; } }
      if (fileAncestor) { local = fileAncestor + '__d/' + local.slice(fileAncestor.length + 1); continue; }
      if (this.dirPrefixes.has(local)) { local = suffixLeaf(local, '__f'); continue; }
      break;
    }
    this.localPaths.set(local, key);
    const parts = local.split('/');
    for (let i = 1; i < parts.length; i++) this.dirPrefixes.add(parts.slice(0, i).join('/'));
    return local;
  }

  saveAsset(key, body, contentType, kind) {
    const existing = this.assets.get(key);
    if (existing && existing.local) return existing;
    if (this.assets.size >= this.opts.maxAssets) { this.failed.set(key, 'max-assets reached'); return null; }
    const local = this.claimLocalPath(U.assetLocalPath(new URL(key), contentType), key);
    const rec = { local, contentType, size: body.length, kind };
    this.assets.set(key, rec);
    if (/^text\/css/.test(contentType)) {
      this.cssText.set(key, body.toString('utf8'));
    } else {
      rec.write = writeFileSafe(path.join(this.siteDir, local), body).catch((e) => {
        this.failed.set(key, 'write: ' + firstLine(e));
        this.assets.delete(key);
        this.localPaths.delete(local);
      });
    }
    return rec;
  }

  async onResponse(resp) {
    try {
      const req = resp.request();
      const rt = req.resourceType();
      if (rt === 'websocket' || rt === 'eventsource') return;
      const u = U.normalizeUrl(resp.url());
      if (!u) return;
      const key = u.href;
      const status = resp.status();
      if (status >= 300 && status < 400) {
        // Recorded for documents too, so a page whose redirect target is
        // unreachable can still be classified from the chain.
        const loc = resp.headers()['location'];
        const t = loc && U.normalizeUrl(loc, key);
        if (t) this.redirects.set(key, t.href);
        return;
      }
      if (rt === 'document') return;
      if (status < 200 || status >= 300 || status === 204 || status === 206) return; // 206: range request, partial body
      if (this.assets.has(key)) return;
      this.assets.set(key, { pending: true });
      let body;
      try { body = await resp.body(); } catch (e) { this.assets.delete(key); return; }
      if (body.length > this.opts.maxAssetBytes) { this.assets.delete(key); this.failed.set(key, 'too large'); return; }
      // Chromium hands back an empty body for prefetches and for images it could
      // not decode; leave those to the follow-up fetch pass instead of saving junk.
      if (body.length === 0 && resp.headers()['content-length'] !== '0') { this.assets.delete(key); return; }
      this.assets.delete(key);
      const ct = (resp.headers()['content-type'] || '').split(';')[0].trim().toLowerCase();
      this.saveAsset(key, body, ct, rt);
    } catch (e) { /* ignore per-response errors */ }
  }

  /** Fetch a URL outside the browser (shares cookies) and store it as an asset. */
  async fetchAsset(rawUrl, kind) {
    const u = U.normalizeUrl(rawUrl);
    if (!u) return null;
    const key = u.href;
    const have = this.resolveLocal(key);
    if (have) return have;
    if (this.failed.has(key)) return null;
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    const p = (async () => {
      try {
        const r = await this.request.get(key, { timeout: this.opts.timeout, maxRedirects: 10, headers: { 'user-agent': this.opts.userAgent } });
        const status = r.status();
        if (status < 200 || status >= 300) { this.failed.set(key, `HTTP ${status}`); return null; }
        const finalU = U.normalizeUrl(r.url());
        const finalKey = finalU ? finalU.href : key;
        if (finalKey !== key) this.redirects.set(key, finalKey);
        const body = await r.body();
        if (body.length > this.opts.maxAssetBytes) { this.failed.set(key, 'too large'); return null; }
        const ct = (r.headers()['content-type'] || '').split(';')[0].trim().toLowerCase();
        const rec = this.saveAsset(finalKey, body, ct, kind);
        return rec ? rec.local : null;
      } catch (e) {
        this.failed.set(key, firstLine(e));
        return null;
      } finally { this.inFlight.delete(key); }
    })();
    this.inFlight.set(key, p);
    return p;
  }

  async seedFromSitemaps() {
    const seen = new Set();
    const sitemaps = [new URL('/sitemap.xml', this.start).href];
    try {
      const r = await this.request.get(new URL('/robots.txt', this.start).href, { timeout: this.opts.timeout });
      if (r.ok()) for (const m of (await r.text()).matchAll(/^\s*sitemap:\s*(\S+)/gim)) sitemaps.push(m[1]);
    } catch { /* no robots */ }
    let added = 0;
    while (sitemaps.length && seen.size < 50) {
      const sm = sitemaps.shift();
      if (seen.has(sm)) continue;
      seen.add(sm);
      try {
        const r = await this.request.get(sm, { timeout: this.opts.timeout });
        if (!r.ok()) continue;
        const xml = await r.text();
        const isIndex = /<sitemapindex/i.test(xml);
        for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
          const loc = m[1].replace(/&amp;/g, '&');
          if (isIndex) { sitemaps.push(loc); continue; }
          const n = U.normalizePageUrl(loc);
          if (n && this.isSameSite(n) && !U.looksLikeFile(n) && this.enqueue(n.href)) added++;
        }
      } catch { /* skip */ }
    }
    if (added) this.log(`[sitemap] seeded ${added} URLs from ${seen.size} sitemap(s)`);
  }

  async processPage(pageUrl, page) {
    const rec = this.pages.get(pageUrl);
    rec.startedAt = new Date().toISOString();
    let resp = null;
    try {
      resp = await page.goto(pageUrl, { waitUntil: 'load', timeout: this.opts.timeout });
    } catch (e) {
      if (!/Timeout/i.test(e.message)) {
        // A redirect chain that leaves the site (vanity /facebook links) can fail
        // in the browser when the target is unreachable; classify it from the chain.
        let hop = pageUrl; let end = null;
        for (let i = 0; i < 10 && this.redirects.has(hop); i++) { hop = this.redirects.get(hop); end = hop; }
        const endU = end && U.normalizePageUrl(end);
        if (endU && !this.isSameSite(endU)) { rec.finalUrl = endU.href; rec.kind = 'external-redirect'; rec.done = true; return rec; }
        // Downloads and aborted navigations (Content-Disposition: attachment, PDFs
        // in some Chromium builds) surface as errors; capture the bytes directly.
        const local = await this.fetchAsset(pageUrl, 'file');
        const asset = local && [...this.assets.values()].find((a) => a.local === local);
        if (asset && !/html/.test(asset.contentType || '')) { rec.kind = 'file'; rec.local = local; rec.done = true; return rec; }
        rec.error = firstLine(e); rec.done = true; return rec;
      }
      this.log(`[warn] load timeout, continuing with partial page: ${pageUrl}`);
    }
    try { await page.waitForLoadState('networkidle', { timeout: Math.min(this.opts.timeout, 15000) }); } catch { /* busy page */ }
    if (resp) {
      rec.status = resp.status();
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (ct && !/html/.test(ct)) {
        let body = null;
        try { body = await resp.body(); } catch { /* ignore */ }
        const saved = body ? this.saveAsset(U.normalizeUrl(resp.url()).href, body, ct.split(';')[0].trim(), 'file') : null;
        rec.kind = 'file'; rec.local = saved ? saved.local : null; rec.done = true; return rec;
      }
    }
    const finalU = U.normalizePageUrl(page.url());
    rec.finalUrl = finalU.href;
    let canonicalHref = pageUrl;
    if (finalU.href !== pageUrl) {
      if (!this.isSameSite(finalU)) { rec.kind = 'external-redirect'; rec.done = true; return rec; }
      rec.kind = 'alias'; rec.alias = finalU.href; rec.done = true;
      const target = this.pages.get(finalU.href);
      if (target && target.done) return rec;
      if (!target) this.pages.set(finalU.href, { url: finalU.href, done: false });
      canonicalHref = finalU.href;
    }
    const canon = this.pages.get(canonicalHref);
    canon.finalUrl = finalU.href;
    canon.status = rec.status;
    const local = this.pageLocal(new URL(canonicalHref));
    if (this.pageLocals.has(local) && this.pageLocals.get(local) !== canonicalHref) this.log(`[warn] ${canonicalHref} and ${this.pageLocals.get(local)} both map to site/${local}; the later one wins`);
    this.pageLocals.set(local, canonicalHref);
    canon.local = local;

    try { await page.evaluate(B.autoScroll, 700, 120); } catch { /* ignore */ }
    if (this.opts.wait) await page.waitForTimeout(this.opts.wait);
    try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch { /* ignore */ }

    const scan = await page.evaluate(B.scanPage);
    canon.title = scan.content.title;

    // Discover pages + same-site file links.
    const pagePathFor = {};
    const fileLinks = [];
    let newLinks = 0;
    for (const raw of scan.links) {
      const n = U.normalizePageUrl(raw);
      if (!n || !this.isSameSite(n)) continue;
      const rawKey = raw.replace(/#.*$/, '');
      const known = this.pages.get(n.href);
      if (U.looksLikeFile(n) || (known && known.kind === 'file')) {
        fileLinks.push(n.href);
        if (rawKey !== n.href) this.redirects.set(rawKey, n.href); // tracking params / param order
        continue;
      }
      pagePathFor[rawKey] = this.pageLocal(n);
      if (this.enqueue(n.href)) newLinks++;
    }
    // Fetch referenced assets the browser did not load (other srcset candidates, lazy images, file links).
    const isKnownPage = (k) => { const n = U.normalizePageUrl(k); if (!n) return false; const r = this.pages.get(n.href); return n.href === canonicalHref || n.href === pageUrl || !!(r && r.kind !== 'file'); };
    const missing = [...new Set([...scan.refs.map((r) => (U.normalizeUrl(r) || {}).href), ...fileLinks])]
      .filter((k) => k && !this.resolveLocal(k) && !this.failed.has(k) && !isKnownPage(k));
    await mapLimit(missing, 6, (k) => this.fetchAsset(k, 'ref'));

    const html = await page.evaluate(B.rewriteDocument, {
      map: this.buildMap(), pageLocal: local, rootPrefix: U.rootPrefix(local), stripScripts: this.opts.stripScripts,
      pagePathFor, origin: canonicalHref, stamp: new Date().toISOString(),
    });
    await writeFileSafe(path.join(this.siteDir, local), html);

    const slug = U.slugForPage(local);
    const content = { url: canonicalHref, local, slug, status: canon.status, crawledAt: new Date().toISOString(), ...scan.content };
    await writeFileSafe(path.join(this.contentDir, 'pages', slug + '.json'), JSON.stringify(content, null, 2));
    await writeFileSafe(path.join(this.contentDir, 'pages', slug + '.md'), toMarkdown(content));
    this.contents.push(content);

    if (this.opts.screenshots) {
      try { await page.screenshot({ path: path.join(this.shotsDir, slug + '.png'), fullPage: true, timeout: 20000 }); canon.screenshot = `screenshots/${slug}.png`; }
      catch (e) { this.log(`[warn] screenshot failed for ${canonicalHref}: ${firstLine(e)}`); }
    }
    canon.done = true;
    canon.linksFound = scan.links.length;
    this.pagesDone++;
    this.log(`[page ${this.pagesDone}] ${canonicalHref} -> site/${local} (${scan.links.length} links, ${newLinks} new, queue ${this.queue.length})`);
    return canon;
  }

  async runWorkers() {
    let active = 0;
    const n = Math.max(1, this.opts.concurrency);
    const workers = Array.from({ length: n }, async () => {
      let page = await this.context.newPage();
      for (;;) {
        if (this.pagesDone >= this.opts.maxPages) break;
        if (this.queue.length === 0) { if (active === 0) break; await sleep(200); continue; }
        const url = this.queue.shift();
        const rec = this.pages.get(url);
        if (!rec || rec.done) continue;
        active++;
        try { await this.processPage(url, page); }
        catch (e) {
          rec.error = firstLine(e); rec.done = true;
          this.log(`[error] ${url}: ${rec.error}`);
          if (page.isClosed()) page = await this.context.newPage();
        } finally { active--; }
        if (this.opts.delay) await sleep(this.opts.delay);
      }
      if (!page.isClosed()) await page.close();
    });
    await Promise.all(workers);
  }

  async finalize() {
    // Resolve stylesheet dependencies (fonts, background images, @import) that were never loaded.
    for (let round = 0; round < 6; round++) {
      const missing = new Set();
      for (const [cssUrl, text] of this.cssText) for (const ref of cssReferences(text, cssUrl)) if (!this.resolveLocal(ref) && !this.failed.has(ref)) missing.add(ref);
      if (!missing.size) break;
      this.log(`[css] fetching ${missing.size} stylesheet dependencies (round ${round + 1})`);
      await mapLimit([...missing], 6, (k) => this.fetchAsset(k, 'css'));
    }
    for (const [cssUrl, text] of this.cssText) {
      const rec = this.assets.get(cssUrl);
      await writeFileSafe(path.join(this.siteDir, rec.local), rewriteCss(text, cssUrl, rec.local, (k) => this.resolveLocal(k)));
    }
    await Promise.all([...this.assets.values()].map((a) => a.write).filter(Boolean));

    const map = this.buildMap();
    if (!this.opts.stripScripts) {
      await writeFileSafe(path.join(this.siteDir, '_mirror', 'shim.js'), await fsp.readFile(path.join(__dirname, 'shim.js')));
      await writeFileSafe(path.join(this.siteDir, '_mirror', 'map.js'), `window.__MIRROR_MAP=${JSON.stringify(map)};\n`);
    }

    // Redirect stubs so every deterministic link target exists: aliases
    // (redirects) and page-looking URLs that turned out to be files.
    const aliases = {};
    const writeStub = async (fromUrl, targetLocal, label) => {
      const stubLocal = this.pageLocal(new URL(fromUrl));
      if (stubLocal === targetLocal || this.pageLocals.has(stubLocal) || this.localPaths.has(stubLocal)) return null;
      const stubFile = path.join(this.siteDir, stubLocal);
      if (fs.existsSync(stubFile)) return null;
      const href = U.relativeHref(stubLocal, targetLocal);
      await writeFileSafe(stubFile, `<!DOCTYPE html>\n<meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${href}"><title>Redirecting</title><a href="${href}">${label}</a>\n`);
      return stubLocal;
    };
    for (const rec of this.pages.values()) {
      if (rec.kind === 'alias' && rec.alias) {
        const target = this.pages.get(rec.alias);
        if (!target || !target.local) continue;
        aliases[rec.url] = rec.alias;
        const stub = await writeStub(rec.url, target.local, rec.alias);
        if (stub) rec.local = stub;
      } else if (rec.kind === 'file' && rec.local && !U.looksLikeFile(new URL(rec.url))) {
        await writeStub(rec.url, rec.local, rec.url);
      } else if (rec.kind === 'external-redirect' && rec.finalUrl) {
        const stubLocal = this.pageLocal(new URL(rec.url));
        if (!this.pageLocals.has(stubLocal) && !this.localPaths.has(stubLocal) && !fs.existsSync(path.join(this.siteDir, stubLocal))) {
          await writeFileSafe(path.join(this.siteDir, stubLocal), `<!DOCTYPE html>\n<meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${rec.finalUrl}"><title>Redirecting</title><a href="${rec.finalUrl}">${rec.finalUrl}</a>\n`);
          rec.local = stubLocal;
        }
      }
    }

    const uncrawled = this.queue.filter((u) => { const r = this.pages.get(u); return r && !r.done; });
    if (uncrawled.length) this.log(`[warn] page limit reached; ${uncrawled.length} discovered URLs were not crawled (see manifest.uncrawled)`);

    const pages = [...this.pages.values()].filter((r) => r.done && r.kind !== 'alias').map((r) => ({
      url: r.url, finalUrl: r.finalUrl, status: r.status, kind: r.kind || 'page', local: r.local ? (r.kind === 'file' ? `site/${r.local}` : `site/${r.local}`) : null,
      title: r.title || '', screenshot: r.screenshot || null, linksFound: r.linksFound, error: r.error || null,
    }));
    const manifest = {
      tool: 'site-extract', startUrl: this.start.href, crawledAt: new Date().toISOString(),
      options: { ...this.opts, log: undefined, out: this.outDir },
      counts: { pages: pages.filter((p) => p.kind === 'page' && !p.error).length, files: pages.filter((p) => p.kind === 'file').length, aliases: Object.keys(aliases).length, assets: this.assets.size, failed: this.failed.size, uncrawled: uncrawled.length },
      pages, aliases,
      assets: Object.fromEntries([...this.assets].map(([k, a]) => [k, { local: `site/${a.local}`, contentType: a.contentType, size: a.size, kind: a.kind }])),
      redirects: Object.fromEntries(this.redirects),
      failed: Object.fromEntries(this.failed),
      uncrawled,
    };
    await writeFileSafe(path.join(this.outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    this.contents.sort((a, b) => a.local.localeCompare(b.local));
    await writeFileSafe(path.join(this.contentDir, 'all-pages.json'), JSON.stringify(this.contents, null, 2));
    await writeFileSafe(path.join(this.contentDir, 'all-pages.md'), this.contents.map(toMarkdown).join('\n\n---\n\n') + '\n');
    await writeFileSafe(path.join(this.contentDir, 'index.json'), JSON.stringify(this.contents.map((c) => ({ url: c.url, slug: c.slug, title: c.title, description: c.description, headings: c.headings.length, blocks: c.blocks.length, words: c.fullText.split(/\s+/).filter(Boolean).length, json: `content/pages/${c.slug}.json`, markdown: `content/pages/${c.slug}.md` })), null, 2));
    return manifest;
  }

  async run() {
    await fsp.mkdir(this.siteDir, { recursive: true });
    this.browser = await chromium.launch({ headless: this.opts.headless, executablePath: this.opts.chromium || undefined, proxy: this.opts.proxy ? { server: this.opts.proxy } : undefined });
    this.context = await this.browser.newContext({ userAgent: this.opts.userAgent, viewport: this.opts.viewport, ignoreHTTPSErrors: true, serviceWorkers: 'block', bypassCSP: true });
    this.request = this.context.request;
    this.context.on('response', (r) => { this.onResponse(r); });
    try {
      this.enqueue(this.start.href);
      for (const s of this.opts.seeds) { const n = U.normalizePageUrl(s, this.start); if (n && this.isSameSite(n)) this.enqueue(n.href); }
      if (this.opts.sitemap) await this.seedFromSitemaps();
      await this.runWorkers();
      return await this.finalize();
    } finally {
      await this.browser.close().catch(() => {});
    }
  }
}

function toMarkdown(c) {
  const lines = [`# ${c.title || c.url}`, '', `Source: ${c.url}`, ''];
  if (c.description) lines.push(`> ${c.description}`, '');
  let region = null;
  for (const b of c.blocks) {
    if (b.region !== region) { region = b.region; lines.push(`<!-- ${region} -->`, ''); }
    const text = b.href && b.tag !== 'li' ? `[${b.text}](${b.href})` : b.text;
    if (b.level) lines.push('#'.repeat(b.level) + ' ' + b.text);
    else if (b.tag === 'li') lines.push((b.list === 'ol' ? '1. ' : '- ') + (b.href ? `[${b.text}](${b.href})` : b.text));
    else if (b.tag === 'blockquote') lines.push('> ' + b.text.replace(/\n/g, '\n> '));
    else if (b.tag === 'pre') lines.push('```', b.text, '```');
    else if (b.tag === 'button') lines.push(`[Button: ${b.text}]`);
    else lines.push(text);
    lines.push('');
  }
  if (c.images && c.images.length) { lines.push('## Images', ''); for (const i of c.images) lines.push(`- ![${i.alt}](${i.src})`); lines.push(''); }
  return lines.join('\n');
}

function parseArgs(argv) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`Missing value for ${a}`); return argv[++i]; };
    switch (a) {
      case '--out': opts.out = next(); break;
      case '--max-pages': opts.maxPages = +next(); break;
      case '--max-assets': opts.maxAssets = +next(); break;
      case '--concurrency': opts.concurrency = +next(); break;
      case '--delay': opts.delay = +next(); break;
      case '--wait': opts.wait = +next(); break;
      case '--timeout': opts.timeout = +next(); break;
      case '--include-subdomains': opts.includeSubdomains = true; break;
      case '--allow-host': (opts.allowHosts = opts.allowHosts || []).push(next()); break;
      case '--seed': (opts.seeds = opts.seeds || []).push(next()); break;
      case '--strip-scripts': opts.stripScripts = true; break;
      case '--no-screenshots': opts.screenshots = false; break;
      case '--no-sitemap': opts.sitemap = false; break;
      case '--headed': opts.headless = false; break;
      case '--proxy': opts.proxy = next(); break;
      case '--chromium': opts.chromium = next(); break;
      case '--user-agent': opts.userAgent = next(); break;
      case '--viewport': { const [w, h] = next().split('x').map(Number); opts.viewport = { width: w, height: h }; break; }
      case '-h': case '--help': opts.help = true; break;
      default: if (a.startsWith('-')) throw new Error(`Unknown option ${a}`); pos.push(a);
    }
  }
  return { opts, pos };
}

const HELP = `Usage: node src/crawl.js <start-url> [options]

Options:
  --out <dir>             Output directory (default: ./<hostname>)
  --max-pages <n>         Stop after this many pages (default 500)
  --max-assets <n>        Cap on captured assets (default 20000)
  --concurrency <n>       Parallel browser tabs (default 3)
  --delay <ms>            Pause between pages per tab (default 250)
  --wait <ms>             Extra settle time after load + scroll (default 1500)
  --timeout <ms>          Navigation/request timeout (default 45000)
  --include-subdomains    Also crawl *.<domain>
  --allow-host <host>     Extra host to treat as same-site (repeatable)
  --seed <url>            Extra start URL (repeatable)
  --strip-scripts         Static snapshot: remove <script> tags, no runtime shim
  --no-screenshots        Skip full-page PNGs
  --no-sitemap            Do not seed from robots.txt / sitemap.xml
  --headed                Show the browser window
  --proxy <url>           HTTP(S) proxy for the browser and fetches
  --chromium <path>       Use this Chromium/Chrome binary (or env SITE_EXTRACT_CHROMIUM)
  --user-agent <ua>       Override the User-Agent
  --viewport <WxH>        Browser viewport (default 1366x900)

Output:
  <out>/site/             Offline mirror: open site/index.html (serve it, e.g. "npx serve site")
  <out>/content/          Per-page JSON + Markdown text extraction, plus all-pages.*
  <out>/screenshots/      Full-page PNG per page
  <out>/manifest.json     Pages, assets, redirects, failures
`;

async function crawl(startUrl, opts = {}) {
  return new Crawler(startUrl, opts).run();
}

if (require.main === module) {
  (async () => {
    let parsed;
    try { parsed = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); console.error(HELP); process.exit(2); }
    if (parsed.opts.help || parsed.pos.length !== 1) { console.error(HELP); process.exit(parsed.opts.help ? 0 : 2); }
    const manifest = await crawl(parsed.pos[0], parsed.opts);
    const c = manifest.counts;
    console.error(`\nDone: ${c.pages} pages, ${c.files} files, ${c.aliases} redirects, ${c.assets} assets, ${c.failed} failed, ${c.uncrawled} uncrawled`);
    console.error(`Output: ${manifest.options.out}`);
  })().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { crawl, Crawler, toMarkdown, parseArgs };
