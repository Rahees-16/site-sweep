'use strict';
const http = require('node:http');

const page = (title, body, { head = '', lang = 'en', desc = true } = {}) =>
  `<!doctype html><html${lang ? ` lang="${lang}"` : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${title === null ? '' : `<title>${title}</title>`}${desc ? '<meta name="description" content="Fixture page">' : ''}${head}</head><body><main>${body}</main></body></html>`;

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#000"/></svg>';

function buildPages(externalBase) {
  return {
    '/': page('Home', `<h1>Home</h1><ul>${['clean', 'broken', 'markup', 'console', 'subres', 'bare', 'contrast', 'overflow', 'slow', 'secret', 'autosubmit', 'd1']
      .map((p) => `<li><a href="/${p}">${p}</a></li>`).join('')}<li><a href="/clean#frag">dupe</a></li><li><a href="/files/doc.pdf">pdf</a></li></ul>`),
    '/clean': page('Clean', '<h1>Clean</h1><p>All good.</p><img src="/logo.svg" alt="Logo"><label for="q">Search</label><input id="q" type="text">'),
    '/broken': page('Broken', `<h1>Broken</h1><a href="/missing">gone</a> <a href="${externalBase}/gone">ext gone</a> <a href="${externalBase}/ok">ext ok</a>`),
    '/markup': page('Markup', '<h1>Markup</h1><img src="/logo.svg"><div id="dup">a</div><div id="dup">b</div><input type="text" name="q">'),
    '/console': page('Console', '<h1>Console</h1><script>console.error("planted console error");console.warn("planted warning");setTimeout(function(){throw new Error("planted uncaught")},10)</script>'),
    '/subres': page('Subres', '<h1>Subres</h1><script src="/api/broken.js"></script>'),
    '/bare': page(null, '<p>no title no h1</p>', { lang: '', desc: false }),
    '/contrast': page('Contrast', '<h1>Contrast</h1><p style="color:#ccc;background:#fff">faint text that is hard to read</p>'),
    '/overflow': page('Overflow', '<h1>Overflow</h1><div style="width:900px;height:20px;background:#333" id="wide"></div>'),
    '/slow': page('Slow', '<h1>Slow</h1><p>slow</p>'),
    '/secret': page('Secret', '<h1>Secret</h1><p>robots-disallowed</p>'),
    '/autosubmit': page('Autosubmit', '<h1>Autosubmit</h1><form method="post" action="/submit"><label for="a">A</label><input id="a" name="a" value="x"><button>Go</button></form><script>setTimeout(function(){document.forms[0].submit()},50)</script>'),
    '/d1': page('D1', '<h1>D1</h1><a href="/d2">next</a>'),
    '/d2': page('D2', '<h1>D2</h1><a href="/d3">next</a>'),
    '/d3': page('D3', '<h1>D3</h1><a href="/d4">next</a>'),
    '/d4': page('D4', '<h1>D4</h1><p>end</p>'),
    '/sitemap-only': page('Sitemap only', '<h1>Sitemap only</h1><p>not linked</p>'),
  };
}

function listen(server) {
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}

async function startFixture() {
  const requests = [];
  const ext = http.createServer((req, res) => {
    requests.push({ server: 'ext', method: req.method, url: req.url });
    if (req.url === '/ok') { res.writeHead(200); res.end('ok'); } else { res.writeHead(404); res.end('nope'); }
  });
  const extPort = await listen(ext);
  const externalBase = `http://127.0.0.1:${extPort}`;
  const pages = buildPages(externalBase);
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    requests.push({ server: 'main', method: req.method, url });
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type }); res.end(body); };
    if (url === '/robots.txt') return send(200, 'text/plain', 'User-agent: *\nDisallow: /secret\n');
    if (url === '/sitemap.xml') return send(200, 'application/xml', `<urlset><url><loc>${base}/sitemap-only</loc></url></urlset>`);
    if (url === '/logo.svg') return send(200, 'image/svg+xml', SVG);
    if (url === '/api/broken.js') return send(500, 'text/plain', 'boom');
    if (url === '/files/doc.pdf') return send(200, 'application/pdf', '%PDF-1.4');
    if (url === '/slow') return setTimeout(() => send(200, 'text/html', pages['/slow']), 1500);
    if (pages[url]) return send(200, 'text/html', pages[url]);
    return send(404, 'text/plain', 'not found');
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  return {
    base, requests, externalBase,
    close: () => Promise.all([new Promise((r) => server.close(r)), new Promise((r) => ext.close(r))]).then(() => {}),
  };
}

module.exports = { startFixture };
