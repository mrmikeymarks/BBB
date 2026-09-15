# site-extract

Crawls a website with a real (headless Chromium) browser and produces two things:

1. **An offline mirror** (`site/`) that runs the way the live site does: the fully rendered DOM of every page, every stylesheet, script, image, font and JSON/XHR response the page loaded, with all references rewritten to relative local paths. A small runtime shim redirects the site's own JavaScript (fetch, XHR, dynamically inserted scripts/images) to the captured copies, so JS-driven content still works with no network.
2. **A text extraction** (`content/`) for every page: title, meta, headings, every visible text block in DOM order (tagged with its element and page region), links, images, JSON-LD, and a Markdown rendering. Suitable as a corpus for search, RAG, or rebuilding the site on another stack.

Because pages are rendered in a browser, it works on builder sites (Wix, Squarespace, Webflow) and client-rendered apps (React/Next/Nuxt) where a plain HTTP crawler only sees an empty shell.

## Setup

Node 18+.

```bash
cd tools/site-extract
npm install
npx playwright install chromium   # one-time browser download
```

## Run

```bash
# from the repo root
node tools/site-extract/src/crawl.js https://www.trueregentrips.com --out ./trueregentrips.com
```

Then open the mirror:

```bash
npx serve ./trueregentrips.com/site        # or: python3 -m http.server -d trueregentrips.com/site 8080
```

Serve it rather than double-clicking `index.html`: browsers block `fetch()` from `file://` pages, so the JS-driven parts only work over HTTP.

### Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--out <dir>` | `./<hostname>` | Output directory |
| `--max-pages <n>` | 500 | Stop after this many pages; the rest are listed in `manifest.uncrawled` |
| `--concurrency <n>` | 3 | Parallel browser tabs |
| `--delay <ms>` | 250 | Pause between pages per tab |
| `--wait <ms>` | 1500 | Settle time after load and scroll (raise for slow builders) |
| `--timeout <ms>` | 45000 | Navigation and request timeout |
| `--include-subdomains` | off | Also crawl `*.<domain>` |
| `--allow-host <host>` | | Treat another host as same-site (repeatable) |
| `--seed <url>` | | Extra start URL (repeatable) |
| `--strip-scripts` | off | Static snapshot: drop `<script>` tags and the shim. Use when the site's JS misbehaves offline |
| `--no-screenshots` | off | Skip full-page PNGs |
| `--no-sitemap` | off | Do not seed from `robots.txt` / `sitemap.xml` |
| `--headed` | off | Show the browser |
| `--proxy <url>` | `$HTTPS_PROXY` | HTTP(S) proxy for the browser and asset fetches (`--no-proxy` ignores the environment) |
| `--chromium <path>` | Playwright's Chromium | Use an existing Chromium/Chrome binary instead (also env `SITE_EXTRACT_CHROMIUM`) |
| `--user-agent <ua>` | Chrome UA | Override the User-Agent |
| `--viewport <WxH>` | 1366x900 | Browser viewport |

## Output layout

```
<out>/
  manifest.json            pages (url, status, local path, title), aliases (redirects), assets, failures, uncrawled
  site/                    the mirror; open site/index.html
    index.html, about/index.html, ...
    _assets/<host>/<path>  every captured resource, grouped by origin host
    _mirror/shim.js        runtime request redirector
    _mirror/map.js         original URL -> local path map used by the shim
  content/
    index.json             one row per page: url, slug, title, description, counts
    all-pages.json         every page's full extraction in one array
    all-pages.md           every page's Markdown, concatenated
    pages/<slug>.json      per-page extraction
    pages/<slug>.md        per-page Markdown
  screenshots/<slug>.png   full-page screenshots
```

Page slugs derive from the path: `/` is `home`, `/about` is `about`, `/blog/post-1` is `blog__post-1`. `all-pages.md` shows the shared header, navigation and footer once, then each page's own content with headings demoted under the page title. The CLI exits with status 3 when no page could be crawled.

### Per-page JSON

```jsonc
{
  "url": "https://www.example.com/about",
  "title": "...", "lang": "en", "description": "...", "canonical": "...",
  "og": { "title": "...", "description": "...", "image": "...", "type": "..." },
  "metas": [{ "name": "...", "content": "..." }],
  "headings": [{ "level": 1, "text": "..." }],
  "blocks": [ { "tag": "p", "region": "main", "text": "...", "href": "...", "level": 2, "list": "ul" } ],
  "links": [{ "text": "...", "href": "...", "region": "nav" }],
  "images": [{ "src": "...", "alt": "...", "width": 800, "height": 600 }],
  "jsonLd": [ ... ],
  "fullText": "visible text of the whole page"
}
```

`region` is one of `header`, `nav`, `main`, `article`, `aside`, `footer`, `body`, taken from the nearest landmark ancestor (a `header`/`footer` inside an article or section is not a page landmark). Blocks are emitted in DOM order: block-level elements as units, and any other visible text grouped by its nearest block ancestor and split into inline runs, so adjacent links or buttons stay separate and a card link keeps its eyebrow text. Text is captured as authored (CSS `text-transform` is not applied). Hidden elements (`display:none`, `visibility:hidden`, `hidden`, `aria-hidden`) are excluded; content of closed `<details>` is included and flagged `collapsed: true`; text inside open shadow roots is included and flagged `shadow: true`; form controls contribute their submit value, placeholder or option list. A block whose text is a single link carries that link's `href`.

## How the mirror works

* Each page is loaded, scrolled to the bottom to trigger lazy loading, and left to settle. Every network response the browser saw is saved under `site/_assets/<host>/...` (file names keep the URL path; query strings become a short hash suffix; extensions are corrected from the Content-Type when missing).
* Responsive image candidates, lazy-load attributes, `<link>`s, inline `style` and `<style>` references, SVG `<use>` targets and same-site file links (PDFs etc.) that the browser did not load are fetched separately so the mirror is complete.
* Stylesheets are rewritten after the crawl: `url()` and `@import` targets are fetched (fonts, background images) and rewritten to relative paths.
* Same-site `<a href>`s are rewritten to the deterministic local path of the target page. Redirecting URLs get a stub page that forwards to the real target (or to the off-site destination), extension-less URLs that turn out to be files get a stub that forwards to the captured file, so every link keeps working.
* Stylesheet rules that exist only in the CSSOM (`insertRule`, CSS-in-JS runtimes) are serialised into the saved `<style>` tags; `adoptedStyleSheets` are appended as extra `<style>` tags.
* Files are written as UTF-8 and the charset declaration is normalised to match, whatever the live page declared.
* `<base>`, CSP meta tags, `preconnect`/`dns-prefetch` hints, and `integrity` attributes on rewritten resources are removed. Service workers are disabled.
* The shim is the first script on each page. It patches `fetch`, `XMLHttpRequest.open`, `setAttribute`, and the `src`/`href`/`srcset` setters on script, image, source, link, iframe and media elements, mapping original absolute URLs to captured files. Anything not captured falls through unchanged.

Third-party embeds that need a live service (maps, booking widgets, analytics, chat) will not function offline; everything else does. If a site's JavaScript wipes the rendered DOM when its backend is unreachable, run again with `--strip-scripts` for a static snapshot.

## Test

```bash
npm test
```

Starts a local fixture site (redirects on and off site, lazy images, `srcset`/`imagesrcset`, `@import`, fonts, fetch/XHR-driven content including page-relative fetches, CSSOM-only rules, a sitemap-only page, PDFs with and without an extension, an attachment download, an RSS feed, non-ASCII and dotted slugs, a Latin-1 page, Wix-style file/directory path clashes), crawls it, checks the rewritten output and extraction, then loads the mirror in a browser with every request to the original host blocked and verifies the JS-driven content still renders.

In a sandbox without a Playwright browser download, point the test at an existing binary: `SITE_EXTRACT_CHROMIUM=/path/to/chrome npm test`.
