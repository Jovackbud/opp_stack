const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.env.PORT || 4173);
const root = path.join(__dirname, 'public');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch (err) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.resolve(root, '.' + rel);
  const relative = path.relative(root, filePath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    console.warn('OppTrack preview blocked path traversal:', urlPath);
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, body) => {
    if (err) {
      console.warn('OppTrack preview missing file:', urlPath);
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'text/plain' });
    res.end(body);
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`OppTrack preview: http://127.0.0.1:${port}`);
});
