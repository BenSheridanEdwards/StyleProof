import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { defineStyleMapCapture, loadStyleMap } from '../dist/index.js';
import { NAV_OBSERVER_FN, NAV_OBSERVER_SNIPPET } from '../dist/runner/browser.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-injected-scripts-'));

const server = http.createServer((request, response) => {
  if (request.url === '/app.js') {
    response.setHeader('content-type', 'application/javascript');
    response.end('document.body.dataset.ready = "yes";');

    return;
  }

  response.setHeader('content-type', 'text/html');
  response.end(`<!doctype html><html><head><link rel="stylesheet" href="data:text/css,body{color:black}"></head><body>
    <main style="--tone: black">Ready</main><script src="/app.js"></script>
    ${request.url === '/inline' ? '<script>eval(\'document.body.dataset.inline = "yes";\')</script>' : ''}
    </body></html>`);
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

// SAFETY: listen(0, '127.0.0.1') has completed, so the address is a TCP AddressInfo.
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test.afterAll(() => server.close());

// Exercise the crawl's binding/init script too, while using the declarative surface runner.
test.beforeEach(async ({ page }) => {
  await page.exposeFunction(NAV_OBSERVER_FN, () => {});
  await page.addInitScript(NAV_OBSERVER_SNIPPET);
});

async function settle(page: Page): Promise<void> {
  await page.addStyleTag({ content: 'main { opacity: 1 !important; }' });
  const height = await page.evaluate(() => document.body.scrollHeight);
  await page.evaluate((y) => window.scrollTo(0, y), height);
  await page.evaluate(() => window.scrollTo(0, 0));
}

for (const key of ['external', 'inline']) {
  test.describe(key, () => {
    test.describe.configure({ mode: 'serial' });
    defineStyleMapCapture({
      dir: 'maps',
      baseDir: directory,
      screenshots: false,
      selfCheck: true,
      parallel: false,
      captureReach: true,
      captureScriptReach: true,
      surfaces: [
        {
          key,
          widths: [720],
          go: async (page: Page) => {
            await page.goto(`${origin}/${key}`);
            await settle(page);
          },
        },
      ],
    });
    test(`injected sources are excluded and app evidence survives: ${key}`, () => {
      const reach = loadStyleMap(path.join(directory, 'maps', `${key}@720.json.gz`)).scriptReach;
      expect(reach?.status, JSON.stringify(reach)).toBe('measured');
      const external = { url: `${origin}/app.js`, status: 'unmeasured', reason: 'source map absent' };

      if (key === 'external') expect(reach?.scripts).toEqual([external]);
      else {
        expect(reach?.scripts).toContainEqual(external);
        // The inline script's eval has no URL; the inline caller retains the document URL.
        expect(reach?.scripts.filter((script) => script.url === '<anonymous>')).toEqual([
          { url: '<anonymous>', status: 'unmeasured', reason: 'unsupported script URL' },
        ]);
        expect(reach?.scripts).toHaveLength(3);
      }

      process.stdout.write(`${key} script evidence: ${JSON.stringify(reach)}\n`);
    });
  });
}
