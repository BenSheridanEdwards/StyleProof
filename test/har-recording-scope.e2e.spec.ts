import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { defineCrawlCapture, loadStyleMap } from '../dist/index.js';

import { captureSurface } from '../dist/runner/surface-capture.js';
import { resolveSettings } from '../dist/runner/settings.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-har-scope-'));

test.afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

const PAGE = (name: string) => `<!doctype html><html><body><nav><a href="/alpha">a</a> <a href="/beta">b</a></nav>
<main id="app">loading</main><script>
  fetch('/api/${name}?w=' + innerWidth).then((r) => r.json())
    .then((d) => { document.getElementById('app').innerHTML = '<div id="loaded">' + d.label + '</div>'; });
</script></body></html>`;

let popupLabel = 'recorded';

const server = http.createServer((req, res) => {
  if (req.url === '/popup') {
    res.end(
      `<!doctype html><button aria-haspopup="dialog" onclick="fetch('/api/popup').then(r => r.json()).then(d => { document.querySelector('dialog').textContent = d.label; document.querySelector('dialog').showModal(); })">Open</button><dialog></dialog>`,
    );

    return;
  }

  if (req.url?.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ label: req.url === '/api/popup' ? popupLabel : `data ${req.url}` }));

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
  test('popup replay renders the recorded response and records its request in the surface HAR', async ({ page }) => {
    const surface = { key: 'popup', popups: true, go: () => page.goto(`${origin}/popup`).then(() => {}) };

    for (const dir of ['record', 'replay']) {
      popupLabel = dir;

      const settings = resolveSettings({
        ...shared,
        dir,
        replayFrom: dir === 'replay' ? path.join(directory, 'record') : undefined,
      });

      await captureSurface(page, surface, 800, settings, { index: 1, total: 1 });
    }

    expect(urlsIn(path.join(directory, 'record', 'popup@800.har'))).toContain('/api/popup');
    const map = loadStyleMap(path.join(directory, 'replay', 'popup-popup-01@800.json.gz'));
    expect(Object.values(map.elements).some((element) => element.text === 'record')).toBe(true);
  });
  // SAFETY: the fixture supplies the crawl settings consumed by defineCrawlCapture.
  test.describe('crawl', () =>
    defineCrawlCapture({
      ...shared,
      dir: 'crawl',
      from: origin + '/',
      match: /\/(alpha|beta)$/,
      settle,
      widths: [800],
    } as never));
  test('each crawled surface HAR holds only its own load', () => {
    for (const key of ['alpha', 'beta']) {
      expect(urlsIn(path.join(directory, 'crawl', `${key}@800.har`))).toEqual([`/api/${key}?w=800`]);
    }
  });
});
