import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { defineStyleMapCapture, loadStyleMap } from '../dist/index.js';

// Issue #872: a relative `replayUrl` is resolved by Playwright's routes against the project
// `baseURL`, so the residue watcher must resolve it the same way or a failing endpoint passes silently.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-relative-replay-url-'));

const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/api/')) {
    res.statusCode = 503;
    res.end('unavailable');
    return;
  }
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><html><body><main id="view">loading</main>
    <script>
      fetch('/api/users')
        .then((r) => { if (!r.ok) throw new Error('bad status'); })
        .catch(() => { document.getElementById('view').textContent = 'fallback'; });
    </script></body></html>`);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.afterAll(() => {
  server.close();
});

const captureHome = (dir: string): void =>
  defineStyleMapCapture({
    dir,
    baseDir: directory,
    screenshots: false,
    selfCheck: false,
    parallel: false,
    replayUrl: '/api/**',
    surfaces: [
      {
        key: 'home',
        widths: [720],
        go: async (page) => {
          await page.goto('/');
          await expect(page.locator('#view')).toHaveText('fallback');
        },
      },
    ],
  });

test.describe('use.baseURL', () => {
  test.use({ baseURL: origin });
  captureHome('base-url');
});

test.describe('contextOptions.baseURL', () => {
  test.use({ contextOptions: { baseURL: origin } });
  captureHome('context-options');
});

for (const dir of ['base-url', 'context-options']) {
  test(`a relative replayUrl names the failing endpoint as residue on the captured map (${dir})`, () => {
    const map = loadStyleMap(path.join(directory, dir, 'home@720.json.gz'));
    expect(map.dataResidue?.map((entry) => [entry.key, entry.reason])).toEqual([['home·/api/users', 'HTTP 503']]);
  });
}
