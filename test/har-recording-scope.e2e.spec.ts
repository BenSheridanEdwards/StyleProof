import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { defineCrawlCapture, defineStyleMapCapture } from '../dist/index.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-har-scope-'));

test.afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

const PAGE = (name: string) => `<!doctype html><html><body><nav><a href="/alpha">a</a> <a href="/beta">b</a></nav>
<main id="app">loading</main><script>
  fetch('/api/${name}?w=' + innerWidth).then((r) => r.json())
    .then((d) => { document.getElementById('app').innerHTML = '<div id="loaded">' + d.label + '</div>'; });
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ label: `data ${req.url}` }));

    return;
  }

  res.setHeader('content-type', 'text/html');
  res.end(req.url === '/beta' ? PAGE('beta') : req.url === '/alpha' ? PAGE('alpha') : PAGE('index'));
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

test.afterAll(() => server.close());
// SAFETY: a listening TCP server has an AddressInfo address.

const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const settle = (page: import('@playwright/test').Page) => page.locator('#loaded').waitFor({ timeout: 5_000 });
const shared = { baseDir: directory, screenshots: false, selfCheck: false, parallel: false };
// SAFETY: these files are HAR recordings whose entries contain request URLs.

const urlsIn = (file: string): string[] =>
  (JSON.parse(fs.readFileSync(file, 'utf8')).log.entries as Array<{ request: { url: string } }>).map(
    (e) => new URL(e.request.url).pathname + new URL(e.request.url).search,
  );

test.describe.serial('#1138 HAR scope', () => {
  test.use({ baseURL: origin });
  test.describe('widths', () =>
    defineStyleMapCapture({
      ...shared,
      dir: 'widths',
      surfaces: [
        {
          key: 'alpha',
          widths: [360, 800],
          go: async (page) => {
            await page.goto('/alpha');
            await settle(page);
          },
        },
      ],
    }));
  // SAFETY: the fixture supplies the crawl settings consumed by defineCrawlCapture.
  test.describe('crawl', () =>
    defineCrawlCapture({
      ...shared,
      dir: 'crawl',
      from: '/',
      match: /\/(alpha|beta)$/,
      settle,
      widths: [800],
    } as never));
  test('each width HAR holds only its own load', () => {
    expect(urlsIn(path.join(directory, 'widths', 'alpha@360.har'))).toEqual(['/api/alpha?w=360']);
    expect(urlsIn(path.join(directory, 'widths', 'alpha@800.har'))).toEqual(['/api/alpha?w=800']);
  });
  test('each crawled surface HAR holds only its own load', () => {
    const hars = fs
      .readdirSync(path.join(directory, 'crawl'))
      .filter((f) => f.endsWith('.har'))
      .sort();

    for (const har of hars) {
      const own = har.split('@')[0];

      for (const url of urlsIn(path.join(directory, 'crawl', har)))
        expect(`${har}: ${url}`).toContain(`${har}: /api/${own}`);
    }

    expect(hars.length).toBeGreaterThan(1);
  });
});
