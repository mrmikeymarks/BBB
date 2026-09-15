'use strict';
// Tiny HTTP server for the fixture site: static files plus a redirect, JSON
// endpoints, robots.txt and a sitemap whose host is filled in at runtime.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'fixture');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.pdf': 'application/pdf', '.xml': 'application/xml', '.txt': 'text/plain' };

function start(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const host = req.headers.host;
    if (url.pathname === '/old') { res.writeHead(301, { Location: '/about.html' }); return res.end(); }
    if (url.pathname === '/fb') { res.writeHead(302, { Location: 'https://external.example.org/fb' }); return res.end(); }
    if (url.pathname === '/download') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="price-list.bin"' }); return res.end('BINARY-DOWNLOAD'); }
    if (url.pathname === '/latin.html') { res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' }); return res.end(fs.readFileSync(path.join(ROOT, 'latin.html'))); }
    if (url.pathname === '/menu') { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end('%PDF-1.4 menu'); }
    if (url.pathname === '/feed') { res.writeHead(200, { 'content-type': 'application/rss+xml' }); return res.end('<?xml version="1.0"?><rss><channel><title>Feed</title></channel></rss>'); }
    if (url.pathname === '/media/x.jpg/v1/fill/w_10/x.jpg') { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end('JPGFAKE-transformed'); }
    const pathAlias = { '/team/john.smith': '/team/john.smith.html', '/team/john.doe': '/team/john.doe.html', '/%E4%BC%9A%E7%A4%BE%E6%A6%82%E8%A6%81': '/company-jp.html', '/%E3%81%8A%E5%95%8F%E3%81%84%E5%90%88%E3%82%8F%E3%81%9B': '/contact-jp.html' };
    if (pathAlias[url.pathname]) url.pathname = pathAlias[url.pathname];
    if (url.pathname === '/api/data.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ items: ['Coast walk', 'Wetland stay', 'Mountain hut'] })); }
    if (url.pathname === '/api/xhr.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true })); }
    if (url.pathname === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(`User-agent: *\nAllow: /\nSitemap: http://${host}/sitemap.xml\n`); }
    if (url.pathname === '/sitemap.xml') { res.writeHead(200, { 'content-type': 'application/xml' }); return res.end(fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8').replace(/HOST/g, host)); }
    let file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      if (!url.pathname.endsWith('/')) { res.writeHead(301, { Location: url.pathname + '/' }); return res.end(); }
      file = path.join(file, 'index.html');
    }
    if (!fs.existsSync(file)) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<h1>Not found</h1>'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, origin: `http://127.0.0.1:${server.address().port}` })));
}

/** Static server for a mirror directory (used to open the mirror offline). */
function serveStatic(root, port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found: ' + url.pathname); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, origin: `http://127.0.0.1:${server.address().port}` })));
}

module.exports = { start, serveStatic };
if (require.main === module) start(+process.argv[2] || 0).then(({ origin }) => console.log('fixture at', origin));
