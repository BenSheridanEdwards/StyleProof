import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { defineCrawlCapture, defineStyleMapCapture } from '../dist/index.js';

// Issue #974: an auto-width surface loads once to read its @media bands before any capture pins
// its inputs. Under replay that load must replay the base's recording too, or a head run with the
// backend down fails on auto-width surfaces only (and, with it up, quietly calls the live backend).
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-auto-width-replay-'));

const NAV_HTML = '<!doctype html><html><body><nav><a href="/widget">Widget</a></nav></body></html>';
// The data URL names the load's width, so a recording only answers a load at the width it was made
// at. A JS breakpoint mounts the CSS that opens the 1100px band only on a load at 720px or wider.
const WIDGET_HTML = `<!doctype html><html><head><style>
  .card { padding: 8px; color: rgb(10, 20, 30); }
  @media (min-width: 720px) { .card { padding: 24px; } }
</style></head><body><main id="app">loading</main>
<script>
  const band1100 = '<style>@media (min-width: 1100px) { .card { margin: 4px; } }</style>';
  if (innerWidth >= 720) document.head.insertAdjacentHTML('beforeend', band1100);
  fetch('/api/widget?w=' + innerWidth)
    .then((r) => { if (!r.ok) throw new Error('status ' + r.status); return r.json(); })
    .then((d) => { document.getElementById('app').innerHTML = '<div id="loaded" class="card">' + d.label + '</div>'; });
</script></body></html>`;

/** One synthetic app per scenario: its ready marker renders from `/api/widget`, which answers 503 once `down`. */
async function widgetApp() {
  const app = { origin: '', down: false, liveHits: [] as string[] };
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/')) {
      app.liveHits.push(req.url);
      res.writeHead(app.down ? 503 : 200, { 'content-type': 'application/json' });
      res.end(app.down ? '{}' : JSON.stringify({ label: `Widget for ${req.url}` }));
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/' ? NAV_HTML : WIDGET_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  test.afterAll(() => {
    server.close();
  });
  app.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return app;
}

const settle = (page: Page): Promise<void> => page.locator('#loaded').waitFor({ timeout: 5_000 });
const shared = { baseDir: directory, screenshots: false, selfCheck: false, parallel: false };
const scenarios: Record<string, (dir: string, replayFrom?: string) => void> = {
  surface: (dir, replayFrom) =>
    defineStyleMapCapture({
      ...shared,
      dir,
      replayFrom,
      surfaces: [
        {
          key: 'widget',
          go: async (page) => {
            await page.goto('/widget');
            await settle(page);
          },
        },
      ],
    }),
  crawl: (dir, replayFrom) => defineCrawlCapture({ ...shared, dir, replayFrom, from: '/', match: '/widget', settle }),
};

const mapsIn = (dir: string): string[] =>
  fs
    .readdirSync(path.join(directory, dir))
    .filter((f) => f.endsWith('.json.gz'))
    .sort();

for (const [name, capture] of Object.entries(scenarios)) {
  const app = await widgetApp();
  const base = path.join(directory, `${name}-base`);
  const partial = path.join(directory, `${name}-partial`);
  test.describe.serial(`auto-width ${name}`, () => {
    test.use({ baseURL: app.origin });
    test.describe('base: backend up, recording', () => capture(`${name}-base`));
    test('the backend goes down', () => {
      app.down = true;
      app.liveHits = [];
    });
    test.describe('head: backend down, replaying the base', () => capture(`${name}-head`, base));
    test('the head captures every detected band from the base recording and never calls the live backend', () => {
      expect(mapsIn(`${name}-base`)).toEqual(['widget@1100.json.gz', 'widget@360.json.gz', 'widget@720.json.gz']);
      expect(mapsIn(`${name}-head`)).toEqual(mapsIn(`${name}-base`));
      expect(app.liveHits).toEqual([]);
    });
    test('the backend comes back up, and the base loses its 360px recording', () => {
      app.down = false;
      app.liveHits = [];
      fs.cpSync(base, partial, { recursive: true });
      fs.rmSync(path.join(partial, 'widget@360.har'));
    });
    test.describe('head: replaying a base with no 360px recording', () => capture(`${name}-partial-head`, partial));
    test('only the width with no recording calls the live backend', () => {
      expect(mapsIn(`${name}-partial-head`)).toEqual(mapsIn(`${name}-base`));
      expect([...new Set(app.liveHits)]).toEqual(['/api/widget?w=360']);
    });
  });
}
