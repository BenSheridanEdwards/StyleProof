/**
 * report.html is opened by reviewers in a real browser, and in the fork capture/report
 * split the captured values come from an untrusted job. This drives the real report
 * generator with hostile CSS values and map metadata, then loads report.html in
 * Chromium and asserts nothing the maps carried ran or became markup.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { generateStyleMapReport } from '../dist/report.js';
import { makeMap, pairFixture, rmTmp, solidPng } from './helpers.mjs';

const PAYLOAD = '<img src=x onerror="window.__styleproofInjected=1">';

const hostileMap = (fontFamily: string, variantKey: string) => ({
  ...makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
      'body > p:nth-child(1)': {
        tag: 'p',
        rect: [100, 100, 400, 40],
        style: { 'font-family': fontFamily, color: 'rgb(0, 0, 0)' },
      },
    },
  }),
  metadata: { variantKind: 'popup', variantKey },
});

// A backtick forces a double-backtick code fence; `<!-->` is a complete empty HTML
// comment, so anything after it would be live markup if the fence broke.
const HOSTILE_FONT = `"\`<!-->${PAYLOAD}-->"`;

const CASES = [
  { name: 'a CSS value that breaks out of its code fence', font: HOSTILE_FONT, variantKey: 'menu', shown: '<!-->' },
  { name: 'a variant key on a screenshot caption line', font: 'sans-serif', variantKey: PAYLOAD, shown: PAYLOAD },
];

for (const c of CASES) {
  test(`report.html renders ${c.name} as inert text`, async ({ page }) => {
    const { beforeDir, afterDir, outDir, root } = pairFixture({
      surface: 'home@1280',
      before: hostileMap('serif', c.variantKey),
      after: hostileMap(c.font, c.variantKey),
      beforePng: solidPng(1280, 800),
      afterPng: solidPng(1280, 800, [180, 180, 180]),
    });
    try {
      const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
      const htmlPath = path.join(outDir, 'report.html');
      expect(fs.existsSync(htmlPath)).toBe(true);
      expect(result.changedSurfaces).toBe(1);

      const dialogs: string[] = [];
      page.on('dialog', (dialog) => {
        dialogs.push(dialog.message());
        void dialog.dismiss();
      });
      await page.goto('file://' + htmlPath, { waitUntil: 'load' });

      expect(await page.evaluate(() => (window as { __styleproofInjected?: number }).__styleproofInjected)).toBe(
        undefined,
      );
      expect(dialogs).toEqual([]);
      expect(await page.locator('img[src="x"]').count()).toBe(0);
      // The payload is still shown to the reviewer — as text, not dropped.
      const text = await page.locator('main').innerText();
      expect(text).toContain(c.shown);
    } finally {
      rmTmp(root);
    }
  });
}
