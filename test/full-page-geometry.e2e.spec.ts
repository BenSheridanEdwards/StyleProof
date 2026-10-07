import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureStyleMap } from '../dist/index.js';
import { captureSurfaceScreenshots } from '../dist/capture.js';
import { isVisibleCapturedElement } from '../dist/visible-structure-gate.js';
import { PNG } from 'pngjs';

// A marker visible in the driven inner scroller is below the viewport in the
// expanded screenshot. Screenshot coordinates must not decide viewport visibility.
test('full-page rect alignment preserves driven-state visible element gating', async ({ page }) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-rect-visibility-'));
  const file = path.join(output, 'fixture.html');
  fs.writeFileSync(
    file,
    `<!doctype html><html><head><style>
    html, body { margin: 0; height: 100%; overflow: hidden; }
    .shell { height: 800px; overflow: hidden; }
    .scroller { height: 100%; overflow: auto; }
    .band { height: 400px; }
    .marker { background: rgb(255, 0, 128); }
  </style></head><body><div class="shell"><div class="scroller">
    <div class="band"></div><div class="band"></div>
    <div class="band marker"></div><div class="band"></div><div class="band"></div>
  </div></div></body></html>`,
  );
  try {
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto('file://' + file);
    await page.locator('.scroller').evaluate((el) => {
      el.scrollTop = 600;
    });
    const map = await captureStyleMap(page, { stabilize: false, captureStates: false });
    const entry = Object.values(map.elements).find((e) => e.cls === 'band marker');
    expect(entry, 'marker was captured').toBeTruthy();
    expect(isVisibleCapturedElement(entry!, map), 'on-screen marker remains reviewable').toBe(true);
    expect(entry!.rect, 'layout and gating retain the driven-state box').toEqual([0, 200, 800, 400]);
    expect(entry!.screenshotRect, 'report crops use the expanded screenshot box').toEqual([0, 800, 800, 400]);
    await captureSurfaceScreenshots(page, path.join(output, 'board'));
    const png = PNG.sync.read(fs.readFileSync(path.join(output, 'board.png')));
    const pixel = (1000 * png.width + 400) * 4;
    expect([...png.data.subarray(pixel, pixel + 3)]).toEqual([255, 0, 128]);
    expect(await page.locator('.scroller').evaluate((el) => el.scrollTop)).toBe(600);
    await page.locator('.scroller').evaluate((el) => {
      el.scrollTop = 0;
    });
    const offscreen = await captureStyleMap(page, { stabilize: false, captureStates: false });
    const offscreenEntry = Object.values(offscreen.elements).find((e) => e.cls === 'band marker');
    expect(isVisibleCapturedElement(offscreenEntry!, offscreen), 'below-fold marker stays advisory').toBe(false);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

// Expanding and restoring for rects must not alter the live captured surface.
test('full-page rect alignment restores inline CSS priorities before later capture reads', async ({ page }) => {
  await page.setContent(`<!doctype html><html><head><style>
    .scroller { height: 300px !important; overflow: auto; }
  </style></head><body><div class="scroller" style="height:200px!important;overflow-x:hidden!important">
    <div style="height:1000px;width:2000px">content</div>
  </div></body></html>`);
  const before = await page.locator('.scroller').evaluate((el) => ({
    height: getComputedStyle(el).height,
    priority: (el as HTMLElement).style.getPropertyPriority('height'),
    overflowX: (el as HTMLElement).style.getPropertyValue('overflow-x'),
    overflowPriority: (el as HTMLElement).style.getPropertyPriority('overflow-x'),
  }));
  const options = { stabilize: false as const, captureStates: false as const };
  const first = await captureStyleMap(page, options);
  expect(
    await page.locator('.scroller').evaluate((el) => ({
      height: getComputedStyle(el).height,
      priority: (el as HTMLElement).style.getPropertyPriority('height'),
      overflowX: (el as HTMLElement).style.getPropertyValue('overflow-x'),
      overflowPriority: (el as HTMLElement).style.getPropertyPriority('overflow-x'),
    })),
    'capture preserves inline values and priorities',
  ).toEqual(before);
  const second = await captureStyleMap(page, options);
  expect(second, 'a repeated capture has the same geometry and computed styles').toEqual(first);
});
