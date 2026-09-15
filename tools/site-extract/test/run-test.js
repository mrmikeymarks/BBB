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
const { sanitizeSegment } = require('../src/urls');
const A2X = sanitizeSegment('a@2x.png'); // '@' is not filesystem-safe, so the name carries a hash suffix

const read = (f) => fs.readFileSync(f, 'utf8');
const exists = (f) => fs.existsSync(f);

const tmpDirs = [];
const log = [];
setTimeout(() => { console.error('TEST TIMEOUT after 240s'); process.exit(1); }, 240000).unref();

async function main() {
  const fixture = await start();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'site-extract-test-'));
  tmpDirs.push(out);
  let manifest;
  try {
    manifest = await crawl(fixture.origin + '/', { out, concurrency: 2, delay: 0, wait: 300, timeout: 4000, log: (m) => log.push(m) });
  } finally { fixture.server.close(); }
  assert.ok(!log.some((l) => /^\[error\]/.test(l)), `crawler logged errors:\n${log.filter((l) => /^\[error\]/.test(l)).join('\n')}`);

  const site = path.join(out, 'site');
  const A = `_assets/127.0.0.1_${fixture.port}`;
  const origin = fixture.origin;

  // ---- pages -------------------------------------------------------------
  const pageUrls = manifest.pages.filter((p) => p.kind === 'page' && !p.error).map((p) => p.url).sort();
  assert.deepStrictEqual(pageUrls, [
    `${origin}/`, `${origin}/about.html`, `${origin}/blog/post-1`, `${origin}/blog/post-2`, `${origin}/orphan-page.html`, `${origin}/services`,
    `${origin}/team/john.smith`, `${origin}/team/john.doe`, `${origin}/%E4%BC%9A%E7%A4%BE%E6%A6%82%E8%A6%81`, `${origin}/%E3%81%8A%E5%95%8F%E3%81%84%E5%90%88%E3%82%8F%E3%81%9B`,
    `${origin}/latin.html`, `${origin}/slash-only`,
  ].sort(), 'crawled page set');
  assert.strictEqual(manifest.pages.find((p) => p.url === `${origin}/fb`).kind, 'external-redirect', 'off-site redirect recorded');
  assert.strictEqual(manifest.pages.find((p) => p.url === `${origin}/download`).kind, 'file', 'attachment download captured as file');
  assert.ok(!manifest.assets[`${origin}/`] && !manifest.assets[`${origin}/about.html`] && !manifest.assets[`${origin}/services`] && !manifest.assets[`${origin}/services/`], `pages must not be captured as raw assets: ${Object.keys(manifest.assets).filter((k) => /html|\/$/.test(k))}`);
  assert.strictEqual(manifest.pages.find((p) => p.url === `${origin}/menu`).kind, 'file', 'extension-less PDF recorded as file');
  const slashOnly = manifest.pages.find((p) => p.url === `${origin}/slash-only`);
  assert.ok(slashOnly && slashOnly.status === 200 && slashOnly.kind === 'page', `page served only with a trailing slash is fetched as linked: ${JSON.stringify(slashOnly)}`);
  const hang = manifest.pages.find((p) => p.url === `${origin}/hang`);
  assert.ok(hang && /timed out/.test(hang.error || '') && !manifest.aliases[`${origin}/hang`], `never-answering page is an error, not an alias: ${JSON.stringify(hang)} ${JSON.stringify(manifest.aliases)}`);
  assert.ok(!fs.existsSync(path.join(site, 'hang/index.html')), 'no stub for a page that never loaded');
  assert.strictEqual(manifest.pages.find((p) => p.url === `${origin}/feed`).kind, 'file', 'RSS feed recorded as file, not page');
  const p404 = manifest.pages.find((p) => p.url === `${origin}/blog/post-2`);
  assert.strictEqual(p404.status, 404, '404 page recorded with its status');
  assert.ok(manifest.pages.find((p) => p.url === `${origin}/orphan-page.html`), 'sitemap-only page crawled');
  assert.deepStrictEqual(manifest.aliases, { [`${origin}/old`]: `${origin}/about.html` }, 'redirect recorded as alias');
  assert.ok(manifest.pages.find((p) => p.url === `${origin}/files/brochure.pdf` && p.kind === 'file') || manifest.assets[`${origin}/files/brochure.pdf`], 'PDF link captured as a file');

  for (const f of ['index.html', 'about/index.html'.replace('about/index.html', 'about.html'), 'services/index.html', 'blog/post-1/index.html', 'orphan-page.html', 'old/index.html',
    `${A}/css/main.css`, `${A}/css/extra.css`, `${A}/fonts/f.woff2`, `${A}/img/a.png`, `${A}/img/${A2X}`, `${A}/img/lazy.png`, `${A}/img/bg.png`, `${A}/img/hero.png`,
    `${A}/img/dynamic.png`, `${A}/img/cdn-only.png`, `${A}/img/favicon.png`, `${A}/img/sprite.svg`, `${A}/js/app.js`, `${A}/js/chunk.js`, `${A}/api/data.json`, `${A}/api/xhr.json`,
    `${A}/files/brochure.pdf`, '_mirror/shim.js', '_mirror/map.js', `${A}/menu.pdf`, 'menu/index.html', `${A}/feed.xml`, `${A}/services/data.json`,
    'team/john.smith/index.html', 'team/john.doe/index.html']) {
    assert.ok(exists(path.join(site, f)), `missing mirrored file: ${f}`);
  }

  for (const [f, expected] of [[`${A}/img/a.png`, 'PNGFAKE-a'], [`${A}/img/${A2X}`, 'PNGFAKE-a2x'], [`${A}/img/lazy.png`, 'PNGFAKE-lazy'], [`${A}/img/hero.png`, 'PNGFAKE-hero'], [`${A}/img/dynamic.png`, 'PNGFAKE-dyn'], [`${A}/fonts/f.woff2`, 'WOFF2FAKE'], [`${A}/api/data.json`, null]]) {
    const got = read(path.join(site, f));
    assert.ok(got.length > 0 && (expected === null || got === expected), `asset body captured intact: ${f} (${JSON.stringify(got.slice(0, 30))})`);
  }
  assert.ok(fs.readFileSync(path.join(site, `${A}/img/real.png`)).equals(fs.readFileSync(path.join(__dirname, 'fixture/img/real.png'))), 'valid PNG captured byte-for-byte');

  // ---- HTML rewriting ----------------------------------------------------
  const home = read(path.join(site, 'index.html'));
  assert.ok(!home.includes(`href="${origin}`) && !home.includes(`src="${origin}`), 'no absolute origin URLs left in src/href');
  assert.ok(home.includes(`href="${A}/css/main.css"`), 'stylesheet rewritten');
  assert.ok(home.includes(`srcset="${A}/img/a.png 1x, ${A}/img/${A2X} 2x"`), `srcset rewritten: ${home.match(/srcset="[^"]*"/)}`);
  assert.ok(home.includes(`href="about.html"`), 'relative page link rewritten');
  assert.ok(home.includes(`href="services/index.html"`), 'directory page link rewritten');
  assert.ok(home.includes(`href="about.html#team"`), 'tracking params dropped, fragment kept');
  assert.ok(home.includes(`href="old/index.html"`), 'redirect link points to stub');
  assert.ok(home.includes('href="https://external.example.org/partner"'), 'external link untouched');
  assert.ok(home.includes('href="mailto:hello@fixture.test"'), 'mailto untouched');
  assert.ok(home.includes(`href="${A}/files/brochure.pdf"`), 'file link rewritten');
  assert.ok(home.includes(`href="${A}/files/brochure.pdf">Brochure (tracked link)`), `tracked file link rewritten: ${home.match(/href="[^"]*">Brochure \(tracked link\)/)}`);
  assert.ok(/href="_assets\/[^"]*\/files\/brochure__q_[0-9a-f]{8}\.pdf">Brochure \(unsorted params\)/.test(home), 'query file link rewritten');
  assert.ok(home.includes(`href="menu/index.html"`), 'extension-less file link goes to its stub');
  assert.ok(read(path.join(site, 'menu/index.html')).includes(`url=../${A}/menu.pdf`), 'file stub forwards to the captured file');
  assert.ok(home.includes(`href="about.html">About us`), 'prefetched page link still points at the mirrored page, not the raw copy');
  assert.ok(home.includes(`href="index.html">Home`) && home.includes(`href="#top">Top`), `home/anchor links intact: ${home.match(/href="[^"]*">(Home|Top)</g)}`);
  assert.ok(home.includes(`<use href="#icon-inline">`), 'fragment-only <use> untouched');
  assert.ok(/class="card" href="services\/index\.html" style="background-image: url\(['"]?_assets\/[^)]*img\/hero\.png/.test(home), `<a style=background> rewritten: ${home.match(/class="card"[^>]*>/)}`);
  assert.ok(new RegExp(`<style id="cssom">[^<]*url\\("?${A.replace(/[.]/g, '\\.')}/img/bg\\.png`).test(home), `CSSOM rules serialised and rewritten: ${home.match(/<style id="cssom">[^<]*<\/style>/)}`);
  assert.ok(home.includes(`imagesrcset="${A}/img/a.png 1x, ${A}/img/${A2X} 2x"`), 'imagesrcset rewritten');
  assert.ok(home.includes(`href="fb/index.html"`) && read(path.join(site, 'fb/index.html')).includes('url=https://external.example.org/fb'), 'external redirect stub');
  assert.ok(home.includes(`href="download/index.html"`), 'extension-less download link goes to its stub');
  const dl = manifest.pages.find((p) => p.url === `${origin}/download`);
  assert.ok(dl && dl.kind === 'file' && dl.local.endsWith('/download.bin'), `attachment saved with the Content-Disposition extension: ${JSON.stringify(dl)}`);
  assert.ok(read(path.join(site, 'download/index.html')).includes(`url=../${dl.local.replace(/^site\//, '')}`), 'download stub forwards to the captured file');
  assert.ok(home.startsWith('<!DOCTYPE html>') && /<head><meta charset="utf-8"><base href="index.html" data-mirror="base"><script data-mirror="config">/.test(home), `charset meta, frozen base, then shim: ${home.slice(0, 260)}`);
  const latin = fs.readFileSync(path.join(site, 'latin.html'));
  assert.ok(latin.toString('utf8').includes('<meta charset="utf-8">') && !latin.toString('utf8').includes('iso-8859-1') && latin.toString('utf8').includes('Café crème €'), 'latin-1 page re-declared as utf-8 with intact text');
  assert.ok(home.includes(`href="team/john.smith/index.html"`) && home.includes(`href="team/john.doe/index.html"`), 'dotted slugs kept distinct');
  assert.ok(read(path.join(site, 'team/john.smith/index.html')).includes('JOHN SMITH PAGE') && read(path.join(site, 'team/john.doe/index.html')).includes('JOHN DOE PAGE'), 'dotted-slug pages not overwritten');
  const jpPages = manifest.pages.filter((p) => /%E4%BC%9A|%E3%81%8A/.test(p.url)).map((p) => p.local);
  assert.strictEqual(new Set(jpPages).size, 2, `non-ASCII pages get distinct paths: ${jpPages}`);
  assert.ok(read(path.join(out, jpPages[0])).includes('PAGE') && read(path.join(out, jpPages[1])).includes('PAGE'));
  const mediaOrig = manifest.assets[`${origin}/media/x.jpg`], mediaVar = manifest.assets[`${origin}/media/x.jpg/v1/fill/w_10/x.jpg`];
  assert.ok(mediaOrig && mediaVar && mediaOrig.local !== mediaVar.local, 'file/dir prefix conflict: both assets recorded with distinct paths');
  assert.strictEqual(read(path.join(out, mediaOrig.local)), 'JPGFAKE-orig', 'file/dir prefix conflict: original written');
  assert.strictEqual(read(path.join(out, mediaVar.local)), 'JPGFAKE-transformed', 'file/dir prefix conflict: variant written');
  assert.ok(home.includes(`src="${mediaOrig.local.replace(/^site\//, '')}"`) && home.includes(`src="${mediaVar.local.replace(/^site\//, '')}"`), 'file/dir prefix conflict: HTML references both');
  assert.ok(!Object.keys(manifest.failed).length, `no failed assets: ${JSON.stringify(manifest.failed)}`);
  assert.ok(home.includes(`url("${A}/img/hero.png")`) || home.includes(`url(${A}/img/hero.png)`), 'inline <style> url() rewritten');
  assert.ok(/style="background:\s*url\(['"]?_assets\/[^)]*img\/bg\.png/.test(home), 'style attribute url() rewritten');
  assert.ok(!home.includes('rel="preconnect"'), 'preconnect removed');
  assert.ok(home.includes('_mirror/shim.js') && home.includes('_mirror/map.js') && home.indexOf('_mirror/shim.js') < home.indexOf('js/app.js'), 'shim injected before app script');
  assert.ok(home.includes('application/ld+json'), 'JSON-LD kept');
  const services = read(path.join(site, 'services/index.html'));
  assert.ok(services.includes(`window.__MIRROR_ORIGIN="${origin}/services/"`), `shim origin keeps the trailing slash: ${services.match(/__MIRROR_ORIGIN="[^"]*"/)}`);
  assert.ok(services.includes('<base href="index.html" data-mirror="base">') && read(path.join(site, 'about.html')).includes('<base href="about.html" data-mirror="base">'), 'base tag names the page file');
  assert.ok(services.includes(`href="../${A}/css/main.css"`), 'nested page uses ../ asset path');
  assert.ok(services.includes(`href="../index.html"`) && services.includes(`href="../about.html"`), 'nested page links rewritten');
  assert.ok(services.includes(`href="../${A}/img/sprite.svg#icon-leaf"`), 'svg <use> rewritten with fragment');
  const about = read(path.join(site, 'about.html'));
  assert.ok(about.includes(`srcset="${A}/img/${A2X} 2x, ${A}/img/a.png 1x"`), '<source srcset> rewritten');
  const stub = read(path.join(site, 'old/index.html'));
  assert.ok(stub.includes('url=../about.html'), 'redirect stub points at target');

  // ---- CSS rewriting -----------------------------------------------------
  const css = read(path.join(site, `${A}/css/main.css`));
  assert.ok(css.includes('@import "extra.css"'), '@import rewritten (same dir)');
  assert.ok(css.includes('url(../fonts/f.woff2)'), 'font url rewritten');
  assert.ok(css.includes('url("../img/bg.png")'), 'absolute css url rewritten');
  assert.ok(css.includes('url(../img/cdn-only.png)'), 'css-only asset fetched and rewritten');
  assert.ok(css.includes("url('data:image/svg+xml"), 'data: url untouched');
  assert.ok(css.includes(`url(../img/${A2X})`), `CSS-escaped url() resolved and rewritten: ${css.match(/\.esc[^}]*}/)}`);

  // ---- shim map -----------------------------------------------------------
  const map = JSON.parse(read(path.join(site, '_mirror/map.js')).replace(/^window\.__MIRROR_MAP=/, '').replace(/;\s*$/, ''));
  assert.strictEqual(map[`${origin}/api/data.json`], `${A}/api/data.json`);
  assert.strictEqual(map[`${origin}/js/chunk.js`], `${A}/js/chunk.js`);

  // ---- content extraction ------------------------------------------------
  const homeJson = JSON.parse(read(path.join(out, 'content/pages/home.json')));
  assert.strictEqual(homeJson.title, 'Fixture Travel Co - Home');
  assert.strictEqual(homeJson.description, 'Fixture Travel Co plans curated regenerative trips.');
  assert.deepStrictEqual(homeJson.headings, [{ level: 1, text: 'Travel that gives back' }, { level: 2, text: 'Featured destinations' }, { level: 3, text: 'Card title' }, { level: 3, text: 'Feature one' }, { level: 2, text: 'Split Title' }, { level: 2, text: 'Post header inside article' }]);
  const texts = homeJson.blocks.map((b) => b.text);
  assert.ok(texts.includes('We design small-group trips that leave places better than we found them.'), 'paragraph extracted');
  assert.ok(texts.includes('Coast walk') && texts.includes('Wetland stay'), `JS-rendered list items extracted: ${JSON.stringify(texts)}`);
  assert.ok(!texts.includes('Loading...'), 'pre-render placeholder gone');
  assert.ok(texts.some((t) => t.startsWith('Orphan text in a span')), 'orphan text captured');
  assert.ok(!texts.some((t) => /must not be extracted/.test(t)), 'hidden text excluded');
  assert.ok(!homeJson.fullText.includes('must not be extracted'), 'hidden text excluded from fullText');
  assert.ok(homeJson.blocks.find((b) => b.tag === 'button' && b.text === 'Get a quote'), 'button captured');
  assert.ok(homeJson.blocks.find((b) => b.tag === 'blockquote'), 'blockquote captured');
  assert.strictEqual(homeJson.blocks.find((b) => b.text === 'Home').region, 'nav', 'nav region tagged (and text-transform not applied)');
  assert.ok(!texts.includes('HOME') && !homeJson.fullText.includes('ABOUT US'), 'CSS text-transform not baked into the extraction');
  const cta = homeJson.blocks.filter((b) => b.text === 'Book now' || b.text === 'Learn more');
  assert.deepStrictEqual(cta.map((b) => [b.tag, b.href]), [['a', `${origin}/services/`], ['a', `${origin}/about.html`]], `adjacent links are separate blocks: ${JSON.stringify(texts.filter((t) => /Book|Learn/.test(t)))}`);
  const card = homeJson.blocks.filter((b) => /^(12 May 2026|Card title|Card excerpt text\.)$/.test(b.text));
  assert.deepStrictEqual(card.map((b) => b.text), ['12 May 2026', 'Card title', 'Card excerpt text.'], `inline card link keeps its eyebrow text: ${JSON.stringify(card)}`);
  assert.strictEqual(card[0].href, `${origin}/blog/post-1/`, 'eyebrow run inherits the card link');
  assert.ok(homeJson.blocks.find((b) => b.tag === 'h3' && b.text === 'Feature one' && b.level === 3), 'heading inside <li> is its own block');
  assert.ok(homeJson.blocks.find((b) => b.tag === 'p' && b.text === 'Feature one detail.'), 'paragraph inside <li> is its own block');
  assert.ok(homeJson.blocks.find((b) => b.tag === 'li' && b.text === 'Plain feature' && b.list === 'ul'), 'simple <li> still a list item');
  assert.strictEqual(homeJson.blocks.filter((b) => b.text === 'Split Title').length, 1, 'aria-hidden split-text clone deduplicated');
  assert.ok(homeJson.blocks.find((b) => b.tag === 'summary' && b.text === 'What is included?'), 'details summary');
  const answer = homeJson.blocks.find((b) => b.text === 'Flights, lodging and guides are included.');
  assert.ok(answer && answer.collapsed === true, `closed <details> content extracted and flagged: ${JSON.stringify(answer)}`);
  assert.ok(homeJson.blocks.find((b) => b.tag === 'input' && b.text === 'Your email'), 'placeholder extracted');
  assert.ok(homeJson.blocks.find((b) => b.tag === 'select' && b.text === 'Coast | Mountain'), 'select options extracted');
  assert.ok(homeJson.blocks.find((b) => b.tag === 'button' && b.text === 'Send request'), 'submit value extracted');
  assert.strictEqual(homeJson.blocks.find((b) => b.text === 'Post header inside article').region, 'article', 'header inside article is not the page header');
  assert.strictEqual(homeJson.blocks.find((b) => b.text === 'Article footer note').region, 'article', 'footer inside article is not the page footer');
  const shadow = homeJson.blocks.find((b) => b.text === 'Shadow widget text');
  assert.ok(shadow && shadow.shadow === true && shadow.tag === 'p', `shadow DOM text extracted: ${JSON.stringify(shadow)}`);
  assert.ok(homeJson.fullText.includes('Shadow widget text'), 'shadow text in fullText');
  const navHome = homeJson.blocks.find((b) => b.tag === 'li' && b.text === 'Home');
  assert.strictEqual(navHome.href, `${origin}/`, 'list item takes the href of its single link');
  assert.strictEqual(homeJson.blocks.find((b) => b.text.startsWith('©')).region, 'footer', 'footer region tagged');
  assert.ok(homeJson.images.find((i) => i.alt === 'Lazy loaded mountain'), 'lazy image listed');
  assert.ok(homeJson.images.find((i) => i.alt === 'Dynamically inserted'), 'dynamic image listed');
  assert.strictEqual(homeJson.jsonLd[0]['@type'], 'TravelAgency');
  assert.ok(homeJson.links.find((l) => l.text === 'Partner' && l.href === 'https://external.example.org/partner'));
  const md = read(path.join(out, 'content/pages/home.md'));
  assert.ok(md.startsWith('# Fixture Travel Co - Home') && md.includes('\n## Travel that gives back') && !md.includes('\n# Travel that gives back') && md.includes('- Coast walk') && md.includes('[Button: Get a quote]') && md.includes(`- [Home](${origin}/)`), `markdown rendering: ${md.slice(0, 400)}`);
  const allMd = read(path.join(out, 'content/all-pages.md'));
  assert.strictEqual((allMd.match(/\[Legacy link\]/g) || []).length, 1, 'all-pages.md renders the shared nav once');
  assert.ok(allMd.includes('### Travel that gives back') && allMd.includes('## Services - Fixture Travel Co'), 'all-pages.md demotes page headings under page titles');
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
    await page.waitForFunction(() => document.getElementById('rel-fetch').textContent !== 'pending', null, { timeout: 5000 });
    assert.strictEqual(await page.textContent('#rel-fetch'), 'rel-fetch:true', 'relative fetch on a directory page resolves through the shim');
    // SPA-style navigation: after pushState every runtime load must still hit the mirror.
    await page.evaluate(() => history.pushState({}, '', '/services/deep/route'));
    const afterPush = await page.evaluate(async () => {
      const r = await fetch(new URL('/api/data.json', location.origin)); // URL object built from the mirror's own origin
      const j = await r.json();
      const p = await fetch('/api/xhr.json', { method: 'POST', body: '{}' }); // captured response served to a POST
      const pj = await p.json();
      const img = new Image();
      const loaded = new Promise((res) => { img.onload = () => res('ok'); img.onerror = () => res('err'); });
      img.src = '/img/real.png';
      const x = await new Promise((res) => { const xhr = new XMLHttpRequest(); xhr.open('POST', 'data.json'); xhr.onload = () => res(JSON.parse(xhr.responseText).ok); xhr.onerror = () => res('err'); xhr.send('{}'); });
      const a = document.createElement('a'); a.href = 'index.html';
      return { items: j.items.length, post: pj.ok, img: await loaded, imgSrc: img.src, xhr: x, sw: 'serviceWorker' in navigator, anchor: a.href };
    });
    assert.deepStrictEqual(afterPush, { items: 3, post: true, img: 'ok', imgSrc: `${mirror.origin}/${A}/img/real.png`, xhr: true, sw: false, anchor: `${mirror.origin}/services/index.html` }, 'runtime loads after pushState');
    assert.deepStrictEqual(bad, [], `broken requests after pushState: ${bad.join(', ')}`);
    await page.goBack();

    await page.click('text=Home');
    await page.waitForURL('**/index.html');
    assert.deepStrictEqual(bad, [], `broken requests after navigation: ${bad.join(', ')}`);
    const stubResp = await page.goto(mirror.origin + '/menu/index.html', { waitUntil: 'load' }).catch(() => null);
    assert.ok(stubResp === null || stubResp.ok(), 'file stub page served');
    assert.ok(read(path.join(site, 'menu/index.html')).includes(`url=../${A}/menu.pdf`), 'file stub forwards to the captured PDF');
  } finally { await browser.close(); mirror.server.close(); }

  // ---- page budget and CLI exit status -------------------------------------
  const fixture3 = await start();
  const out3 = fs.mkdtempSync(path.join(os.tmpdir(), 'site-extract-test-budget-'));
  try {
    const m3 = await crawl(fixture3.origin + '/', { out: out3, concurrency: 3, delay: 0, wait: 200, timeout: 15000, screenshots: false, maxPages: 2, log: () => {} });
    assert.strictEqual(m3.counts.pages, 2, `--max-pages is a hard cap even with concurrency: ${m3.counts.pages}`);
    assert.ok(m3.uncrawled.length > 0, 'uncrawled URLs reported');
  } finally { fixture3.server.close(); fs.rmSync(out3, { recursive: true, force: true }); }
  const { spawnSync } = require('child_process');
  const cli = spawnSync(process.execPath, [path.join(__dirname, '../src/crawl.js'), 'http://127.0.0.1:9/', '--out', path.join(os.tmpdir(), 'site-extract-test-unreachable'), '--timeout', '5000', '--no-sitemap', '--no-screenshots'], { encoding: 'utf8', env: { ...process.env }, timeout: 60000 });
  assert.strictEqual(cli.status, 3, `CLI exits 3 when nothing could be crawled (got ${cli.status}): ${cli.stderr.slice(-400)}`);
  assert.ok(/No pages could be crawled/.test(cli.stderr), 'CLI explains the failure');
  fs.rmSync(path.join(os.tmpdir(), 'site-extract-test-unreachable'), { recursive: true, force: true });

  // ---- strip-scripts variant ----------------------------------------------
  const fixture2 = await start();
  const out2 = fs.mkdtempSync(path.join(os.tmpdir(), 'site-extract-test-static-'));
  tmpDirs.push(out2);
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

main().catch((e) => {
  console.error('TEST FAILED:', e && e.stack || e);
  if (tmpDirs.length) console.error('Output kept for inspection:', tmpDirs.join(', '));
  if (log.length) console.error('Last crawler log lines:\n' + log.slice(-20).join('\n'));
  process.exit(1);
});
