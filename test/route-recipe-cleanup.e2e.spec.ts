import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandSurfaceVariants } from '../dist/runner.js';
import { captureSurface, detectSurfaceWidths } from '../dist/runner/surface-capture.js';
import { resolveSettings } from '../dist/runner/settings.js';

const pattern = '**/flags.json';
const recipe = { action: 'route' as const, stateKey: 'flags-down', urlPattern: pattern, status: 503 };
const fixture = '<!doctype html><style>body { color: rgb(10, 20, 30); }</style><p>Ready</p>';

for (const mode of ['capture', 'detection', 'failure', 'reopen'] as const) {
  test(`route recipe cleanup: unconsumed mock cannot answer the next surface after ${mode}`, async ({ page }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-recipe-cleanup-'));
    await page.route('http://recipe.test/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: fixture }),
    );
    // Same pattern, different owner: cleanup must leave this consumer handler intact.
    await page.route(pattern, (route) => route.fulfill({ status: 202, body: 'real flags' }));
    const [, surface] = expandSurfaceVariants({
      key: 'about',
      go: async (target) => {
        await target.goto('http://recipe.test/about');
        if (mode === 'failure') throw new Error('navigation failed');
      },
      stateRecipes: [recipe],
    });
    const settings = resolveSettings({
      baseDir: dir,
      dir: 'maps',
      selfCheck: true,
      screenshots: false,
      captureStates: false,
      captureReach: false,
      freezeClock: false,
      replayFrom: path.join(dir, 'missing-har'),
    });
    fs.mkdirSync(settings.outDir, { recursive: true });
    try {
      if (mode === 'detection') await detectSurfaceWidths(page, surface, settings);
      else if (mode === 'reopen') {
        // Self-check and popup reopen both drive the same expanded go() repeatedly.
        for (let i = 0; i < 3; i++) await surface.go(page);
        const statuses = await page.evaluate(async () => [
          (await fetch('/flags.json')).status,
          (await fetch('/flags.json')).status,
        ]);
        expect(statuses).toEqual([503, 202]);
      } else {
        const capture = captureSurface(page, surface, 640, settings, { index: 1, total: 1 });
        if (mode === 'failure') await expect(capture).rejects.toThrow('navigation failed');
        else await capture;
      }
      const next = await page.evaluate(async () => {
        const response = await fetch('/flags.json');
        return { status: response.status, body: await response.text() };
      });
      expect(next).toEqual({ status: 202, body: 'real flags' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const mode of ['capture', 'detection'] as const) {
  test(`route recipe cleanup: failed cleanup still disposes trackers and finalizes the ${mode} HAR`, async ({
    page,
  }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-recipe-teardown-'));
    const events = ['request', 'requestfinished', 'requestfailed', 'response'] as const;
    const listeners = () => events.map((event) => page.listeners(event).length);
    const before = listeners();
    const surface = {
      key: 'closed',
      go: async () => {
        throw new Error('capture failed');
      },
      cleanup: async () => {
        throw new Error('route cleanup failed');
      },
    };
    const settings = resolveSettings({ baseDir: dir, dir: 'maps', captureReach: false, freezeClock: false });
    fs.mkdirSync(settings.outDir, { recursive: true });
    try {
      const run =
        mode === 'capture'
          ? captureSurface(page, surface, 640, settings, { index: 1, total: 1 })
          : detectSurfaceWidths(page, surface, settings);
      await expect(run).rejects.toThrow('route cleanup failed');
      expect(listeners()).toEqual(before);
      const har = fs.readdirSync(settings.outDir).find((name) => name.endsWith('.har'));
      expect(har).toBeTruthy();
      expect(JSON.parse(fs.readFileSync(path.join(settings.outDir, har!), 'utf8')).log.entries).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
