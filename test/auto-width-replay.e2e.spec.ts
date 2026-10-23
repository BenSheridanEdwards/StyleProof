import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { defineCrawlCapture, defineStyleMapCapture } from '../dist/index.js';

// Issue #974: an auto-width surface records its detection load at the project viewport separately
// from its width captures. The head must replay that same load without shrinking the viewport,
// or it can miss a head-only JS-gated band and quietly hide a reviewable change.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-auto-width-replay-'));

const NAV_HTML = '<!doctype html><html><body><nav><a href="/widget">Widget</a></nav></body></html>';
// The data URL names the load's width, so a recording only answers a load at the width it was made
// at. Each scenario adds its own JS-gated band without changing the data request.
const WIDGET_HTML = `<!doctype html><html><head><style>
  .card { padding: 8px; color: rgb(10, 20, 30); }
  @media (min-width: 720px) { .card { padding: 24px; } }
</style></head><body><main id="app">loading</main>
<script>
  fetch('/api/widget?w=' + innerWidth)
    .then((r) => { if (!r.ok) throw new Error('status ' + r.status); return r.json(); })
    .then((d) => { document.getElementById('app').innerHTML = '<div id="loaded" class="card">' + d.label + '</div>'; });
</script></body></html>`;
const BASE_BAND_SCRIPT = `<script>
  const band1100 = '<style>@media (min-width: 1100px) { .card { margin: 4px; } }</style>';
  if (innerWidth >= 720) document.head.insertAdjacentHTML('beforeend', band1100);
</script>`;
const HEAD_BAND_SCRIPT = `<script>
  const band1100 = '<style>@media (min-width: 1100px) { .card { border: 1px solid rgb(1, 2, 3); } }</style>';
  if (innerWidth >= 1000) document.head.insertAdjacentHTML('beforeend', band1100);
</script>`;

/** One synthetic app per scenario: its ready marker renders from `/api/widget`, which answers 503 once `down`. */
async function widgetApp({ headOnly = false } = {}) {
  const app = { origin: '', down: false, headBand: false, liveHits: [] as string[] };
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/')) {
      app.liveHits.push(req.url);
      res.writeHead(app.down ? 503 : 200, { 'content-type': 'application/json' });
      res.end(app.down ? '{}' : JSON.stringify({ label: `Widget for ${req.url}` }));
      return;
    }
    res.setHeader('content-type', 'text/html');
    const band = headOnly ? (app.headBand ? HEAD_BAND_SCRIPT : '') : BASE_BAND_SCRIPT;
    res.end(req.url === '/' ? NAV_HTML : WIDGET_HTML.replace('</head>', `${band}</head>`));
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
  const noDetect = path.join(directory, `${name}-nodetect`);
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
    test('the base loses its detection recording', () => {
      app.liveHits = [];
      fs.cpSync(base, noDetect, { recursive: true });
      // Desktop Chrome's project viewport is 1280×720.
      fs.rmSync(path.join(noDetect, 'widget@auto-1280x720.har'));
    });
    test.describe('head: replaying a base with no detection recording', () =>
      capture(`${name}-nodetect-head`, noDetect));
    test('only detection calls the live backend, at the project viewport', () => {
      expect(mapsIn(`${name}-nodetect-head`)).toEqual(mapsIn(`${name}-base`));
      expect([...new Set(app.liveHits)]).toEqual(['/api/widget?w=1280']);
    });
  });

  const headBandApp = await widgetApp({ headOnly: true });
  const headBandBase = path.join(directory, `${name}-head-band-base`);
  test.describe.serial(`auto-width ${name}: a head-only JS-gated band above the base's widest width`, () => {
    test.use({ baseURL: headBandApp.origin });
    test.describe('base: backend up, recording without the head-only band', () => capture(`${name}-head-band-base`));
    test('the head adds a band gated above the widest base capture', () => {
      headBandApp.headBand = true;
      headBandApp.liveHits = [];
    });
    test.describe('head: replaying the base with the new band', () => capture(`${name}-head-band-head`, headBandBase));
    test('the head captures its new band without live detection requests', () => {
      // Review finding #1: detecting at the widest base HAR (720px) misses the head-only 1100px band.
      expect(mapsIn(`${name}-head-band-base`)).toEqual(['widget@360.json.gz', 'widget@720.json.gz']);
      expect(mapsIn(`${name}-head-band-head`)).toEqual([
        'widget@1100.json.gz',
        'widget@360.json.gz',
        'widget@720.json.gz',
      ]);
      expect([...new Set(headBandApp.liveHits)]).toEqual(['/api/widget?w=1100']);
    });
  });
}
