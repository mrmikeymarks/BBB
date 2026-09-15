# BBB

## Site extraction

`tools/site-extract/` crawls a website with a real browser and writes an offline-runnable mirror plus a per-page text extraction (JSON + Markdown). See [tools/site-extract/README.md](tools/site-extract/README.md).

To capture www.trueregentrips.com into this repo:

```bash
cd tools/site-extract && npm install && npx playwright install chromium && cd ../..
node tools/site-extract/src/crawl.js https://www.trueregentrips.com --out ./trueregentrips.com
npx serve ./trueregentrips.com/site      # browse the offline copy
```

Output lands in `trueregentrips.com/` (`site/` mirror, `content/` text, `screenshots/`, `manifest.json`).
