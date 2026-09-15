'use strict';
// End-to-end test: crawl the fixture site, check the mirror + extraction, then
// open the mirror with ALL network access to the original host blocked and
// verify the JS-driven parts of the page still work through the runtime shim.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const { start, serveStatic } = require('./fixture-server');
const { crawl } = require('../src/crawl');

const read = (f) => fs.readFileSync(f, 'utf8');
const exists = (f) => fs.existsSync(f);

async function main() {
  const fixture = await start();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'site-extract-test-'));
  const log = [];
  let manifest;
  try {
    manifest = await crawl(fixture.origin + '/', { out, concurrency: 2, delay: 0, wait: 300, timeout: 15000, log: (m) => log.push(m) });
  } finally { fixture.server.close(); }

  const site = path.join(out, 'site');
  const A = `_assets/127.0.0.1_${fixture.port}`;
  const origin = fixture.origin;

  // ---- pages -------------------------------------------------------------
  const pageUrls = manifest.pages.filter((p) => p.kind === 'page' && !p.error).map((p) => p.url).sort();
  assert.deepStrictEqual(pageUrls, [
    `${origin}/`, `${origin}/about.html`, `${origin}/blog/post-1`, `${origin}/blog/post-2`, `${origin}/orphan-page.html`, `${origin}/services`,
  ].sort(), 'crawled page set');
  const p404 = manifest.pages.find((p) => p.url === `${origin}/blog/post-2`);
  assert.strictEqual(p404.status, 404, '404 page recorded with its status');
  assert.ok(manifest.pages.find((p) => p.url === `${origin}/orphan-page.html`), 'sitemap-only page crawled');
  assert.deepStrictEqual(manifest.aliases, { [`${origin}/old`]: `${origin}/about.html` }, 'redirect recorded as alias');
  assert.ok(manifest.pages.find((p) => p.url === `${origin}/files/brochure.pdf` && p.kind === 'file') || manifest.assets[`${origin}/files/brochure.pdf`], 'PDF link captured as a file');

  for (const f of ['index.html', 'about/index.html'.replace('about/index.html', 'about.html'), 'services/index.html', 'blog/post-1/index.html', 'orphan-page.html', 'old/index.html',
    `${A}/css/main.css`, `${A}/css/extra.css`, `${A}/fonts/f.woff2`, `${A}/img/a.png`, `${A}/img/a_2x.png`, `${A}/img/lazy.png`, `${A}/img/bg.png`, `${A}/img/hero.png`,
    `${A}/img/dynamic.png`, `${A}/img/cdn-only.png`, `${A}/img/favicon.png`, `${A}/img/sprite.svg`, `${A}/js/app.js`, `${A}/js/chunk.js`, `${A}/api/data.json`, `${A}/api/xhr.json`,
    `${A}/files/brochure.pdf`, '_mirror/shim.js', '_mirror/map.js']) {
    assert.ok(exists(path.join(site, f)), `missing mirrored file: ${f}`);
  }

  // ---- HTML rewriting ----------------------------------------------------
  const home = read(path.join(site, 'index.html'));
  assert.ok(!home.includes(`href="${origin}`) && !home.includes(`src="${origin}`), 'no absolute origin URLs left in src/href');
  assert.ok(home.includes(`href="${A}/css/main.css"`), 'stylesheet rewritten');
  assert.ok(home.includes(`srcset="${A}/img/a.png 1x, ${A}/img/a_2x.png 2x"`), `srcset rewritten: ${home.match(/srcset="[^"]*"/)}`);
  assert.ok(home.includes(`href="about.html"`), 'relative page link rewritten');
  assert.ok(home.includes(`href="services/index.html"`), 'directory page link rewritten');
  assert.ok(home.includes(`href="about.html#team"`), 'tracking params dropped, fragment kept');
  assert.ok(home.includes(`href="old/index.html"`), 'redirect link points to stub');
  assert.ok(home.includes('href="https://external.example.org/partner"'), 'external link untouched');
  assert.ok(home.includes('href="mailto:hello@fixture.test"'), 'mailto untouched');
  assert.ok(home.includes(`href="${A}/files/brochure.pdf"`), 'file link rewritten');
  assert.ok(home.includes(`url("${A}/img/hero.png")`) || home.includes(`url(${A}/img/hero.png)`), 'inline <style> url() rewritten');
  assert.ok(/style="background:\s*url\(['"]?_assets\/[^)]*img\/bg\.png/.test(home), 'style attribute url() rewritten');
  assert.ok(!home.includes('rel="preconnect"'), 'preconnect removed');
  assert.ok(home.includes('_mirror/shim.js') && home.includes('_mirror/map.js') && home.indexOf('_mirror/shim.js') < home.indexOf('js/app.js'), 'shim injected before app script');
  assert.ok(home.includes('application/ld+json'), 'JSON-LD kept');
  const services = read(path.join(site, 'services/index.html'));
  assert.ok(services.includes(`href="../${A}/css/main.css"`), 'nested page uses ../ asset path');
  assert.ok(services.includes(`href="../index.html"`) && services.includes(`href="../about.html"`), 'nested page links rewritten');
  assert.ok(services.includes(`href="../${A}/img/sprite.svg#icon-leaf"`), 'svg <use> rewritten with fragment');
  const about = read(path.join(site, 'about.html'));
  assert.ok(about.includes(`srcset="${A}/img/a_2x.png 2x, ${A}/img/a.png 1x"`), '<source srcset> rewritten');
  const stub = read(path.join(site, 'old/index.html'));
  assert.ok(stub.includes('url=../about.html'), 'redirect stub points at target');

  // ---- CSS rewriting -----------------------------------------------------
  const css = read(path.join(site, `${A}/css/main.css`));
  assert.ok(css.includes('@import "extra.css"'), '@import rewritten (same dir)');
  assert.ok(css.includes('url(../fonts/f.woff2)'), 'font url rewritten');
  assert.ok(css.includes('url("../img/bg.png")'), 'absolute css url rewritten');
  assert.ok(css.includes('url(../img/cdn-only.png)'), 'css-only asset fetched and rewritten');
  assert.ok(css.includes("url('data:image/svg+xml"), 'data: url untouched');

  // ---- shim map -----------------------------------------------------------
  const map = JSON.parse(read(path.join(site, '_mirror/map.js')).replace(/^window\.__MIRROR_MAP=/, '').replace(/;\s*$/, ''));
  assert.strictEqual(map[`${origin}/api/data.json`], `${A}/api/data.json`);
  assert.strictEqual(map[`${origin}/js/chunk.js`], `${A}/js/chunk.js`);

  // ---- content extraction ------------------------------------------------
  const homeJson = JSON.parse(read(path.join(out, 'content/pages/home.json')));
  assert.strictEqual(homeJson.title, 'Fixture Travel Co - Home');
  assert.strictEqual(homeJson.description, 'Fixture Travel Co plans curated regenerative trips.');
  assert.deepStrictEqual(homeJson.headings, [{ level: 1, text: 'Travel that gives back' }, { level: 2, text: 'Featured destinations' }]);
  const texts = homeJson.blocks.map((b) => b.text);
  assert.ok(texts.includes('We design small-group trips that leave places better than we found them.'), 'paragraph extracted');
  assert.ok(texts.includes('Coast walk') && texts.includes('Wetland stay'), `JS-rendered list items extracted: ${JSON.stringify(texts)}`);
  assert.ok(!texts.includes('Loading...'), 'pre-render placeholder gone');
  assert.ok(texts.some((t) => t.startsWith('Orphan text in a span')), 'orphan text captured');
  assert.ok(!texts.some((t) => /must not be extracted/.test(t)), 'hidden text excluded');
  assert.ok(!homeJson.fullText.includes('must not be extracted'), 'hidden text excluded from fullText');
  assert.ok(homeJson.blocks.find((b) => b.tag === 'button' && b.text === 'Get a quote'), 'button captured');
  assert.ok(homeJson.blocks.find((b) => b.tag === 'blockquote'), 'blockquote captured');
  assert.strictEqual(homeJson.blocks.find((b) => b.text === 'Home').region, 'nav', 'nav region tagged');
  assert.strictEqual(homeJson.blocks.find((b) => b.text.startsWith('©')).region, 'footer', 'footer region tagged');
  assert.ok(homeJson.images.find((i) => i.alt === 'Lazy loaded mountain'), 'lazy image listed');
  assert.ok(homeJson.images.find((i) => i.alt === 'Dynamically inserted'), 'dynamic image listed');
  assert.strictEqual(homeJson.jsonLd[0]['@type'], 'TravelAgency');
  assert.ok(homeJson.links.find((l) => l.text === 'Partner' && l.href === 'https://external.example.org/partner'));
  const md = read(path.join(out, 'content/pages/home.md'));
  assert.ok(md.startsWith('# Fixture Travel Co - Home') && md.includes('# Travel that gives back') && md.includes('- Coast walk') && md.includes('[Button: Get a quote]'), 'markdown rendering');
  const aboutJson = JSON.parse(read(path.join(out, 'content/pages/about.json')));
  assert.ok(aboutJson.blocks.find((b) => b.tag === 'li' && b.list === 'ol' && b.text === 'Alex, founder'), 'ordered list items');
  const svc = JSON.parse(read(path.join(out, 'content/pages/services.json')));
  assert.ok(svc.blocks.find((b) => b.tag === 'td' && b.text === 'Coast'), 'table cells');
  assert.ok(exists(path.join(out, 'content/all-pages.md')) && exists(path.join(out, 'content/all-pages.json')) && exists(path.join(out, 'content/index.json')));
  assert.ok(exists(path.join(out, 'screenshots/home.png')), 'screenshot written');
  assert.ok(exists(path.join(out, 'manifest.json')));

  // ---- offline run --------------------------------------------------------
  const mirror = await serveStatic(site);
  const browser = await chromium.launch({ executablePath: process.env.SITE_EXTRACT_CHROMIUM || undefined });
  try {
    const ctx = await browser.newContext();
    const failed = [];
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith(mirror.origin + '/')) return route.continue();
      failed.push(u); return route.abort();
    });
    const page = await ctx.newPage();
    const bad = [];
    page.on('response', (r) => { if (r.status() >= 400) bad.push(r.url()); });
    await page.goto(mirror.origin + '/index.html', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.body.getAttribute('data-chunk') === 'loaded', null, { timeout: 5000 });
    assert.deepStrictEqual(await page.$$eval('#dynamic-list li', (els) => els.map((e) => e.textContent)), ['Coast walk', 'Wetland stay', 'Mountain hut'], 'fetch() served from mirror');
    assert.strictEqual(await page.getAttribute('body', 'data-xhr'), 'yes', 'XHR served from mirror');
    assert.ok((await page.getAttribute('#dyn-img', 'src')).includes(`${A}/img/dynamic.png`), `dynamic img src rewritten: ${await page.getAttribute('#dyn-img', 'src')}`);
    assert.ok((await page.getAttribute('img.lazy', 'src')).includes(`${A}/img/lazy.png`), 'setAttribute(src) rewritten');
    assert.deepStrictEqual(failed, [], `requests escaped the mirror: ${failed.join(', ')}`);
    assert.deepStrictEqual(bad, [], `broken requests inside the mirror: ${bad.join(', ')}`);
    const fontOk = await page.evaluate(() => getComputedStyle(document.body).fontFamily.includes('Fixture'));
    assert.ok(fontOk, 'stylesheet applied');
    await page.goto(mirror.origin + '/old/index.html', { waitUntil: 'load' });
    await page.waitForURL('**/about.html', { timeout: 5000 });
    assert.strictEqual(await page.textContent('h1'), 'About us', 'redirect stub works');
    await page.goto(mirror.origin + '/services/index.html', { waitUntil: 'networkidle' });
    assert.deepStrictEqual(failed, [], 'nested page stays inside the mirror');
    await page.click('text=Home');
    await page.waitForURL('**/index.html');
    assert.deepStrictEqual(bad, [], `broken requests after navigation: ${bad.join(', ')}`);
  } finally { await browser.close(); mirror.server.close(); }

  // ---- strip-scripts variant ----------------------------------------------
  const fixture2 = await start();
  const out2 = fs.mkdtempSync(path.join(os.tmpdir(), 'site-extract-test-static-'));
  try {
    await crawl(fixture2.origin + '/', { out: out2, concurrency: 1, delay: 0, wait: 200, timeout: 15000, stripScripts: true, screenshots: false, sitemap: false, maxPages: 1, log: () => {} });
  } finally { fixture2.server.close(); }
  const staticHome = read(path.join(out2, 'site/index.html'));
  assert.ok(!/<script(?![^>]*ld\+json)/.test(staticHome), 'scripts stripped');
  assert.ok(staticHome.includes('<li>Coast walk</li>'), 'rendered DOM kept in static snapshot');
  assert.ok(!exists(path.join(out2, 'site/_mirror')), 'no shim in static snapshot');

  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(out2, { recursive: true, force: true });
  console.log(`OK: ${manifest.counts.pages} pages, ${manifest.counts.assets} assets, ${manifest.counts.aliases} alias, ${manifest.counts.failed} failed`);
  if (manifest.counts.failed) console.log('failed:', manifest.failed);
}

main().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
