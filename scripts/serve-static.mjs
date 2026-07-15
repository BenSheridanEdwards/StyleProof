#!/usr/bin/env node
/**
 * Zero-dependency static file server for CI fixtures:
 *
 *   node scripts/serve-static.mjs <dir> <port>
 *
 * Used as the Playwright webServer for the store-dogfood workflow (serving
 * example/demo), so the round-trip capture needs no extra npm dependency and
 * no network install. Serves GET only, resolves strictly inside <dir>, maps
 * "/" to index.html. Not a production server — a test harness.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const [dirArgument, portArgument] = process.argv.slice(2);
if (!dirArgument || !portArgument) {
  console.error('usage: serve-static.mjs <dir> <port>');
  process.exit(2);
}
const root = path.resolve(dirArgument);
const port = Number(portArgument);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
};

http
  .createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep) && file !== root) {
      response.writeHead(403).end();
      return;
    }
    let body;
    try {
      body = fs.readFileSync(file);
    } catch {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    response.end(body);
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`serving ${root} at http://127.0.0.1:${port}`);
  });
