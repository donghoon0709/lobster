import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '../../../dist');
const port = Number(process.env.PORT || 4173);

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
]);

const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
    if (pathname === '/') {
      res.writeHead(302, { location: '/apps/lobster-studio/' });
      res.end();
      return;
    }

    if (pathname === '/apps/lobster-studio') {
      res.writeHead(302, { location: '/apps/lobster-studio/' });
      res.end();
      return;
    }

    const relativePath = pathname === '/apps/lobster-studio/'
      ? '/apps/lobster-studio/index.html'
      : pathname;
    const filePath = path.join(root, relativePath);
    const body = await readFile(filePath);
    const contentType = contentTypes.get(path.extname(filePath)) || 'application/octet-stream';
    res.writeHead(200, { 'content-type': contentType });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

server.listen(port, () => {
  process.stdout.write(`Lobster Studio preview: http://127.0.0.1:${port}\n`);
});
