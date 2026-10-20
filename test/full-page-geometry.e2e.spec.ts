import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { captureStyleMap } from '../dist/index.js';
import { captureSurfaceScreenshots, saveStyleMap } from '../dist/capture.js';
import { isVisibleCapturedElement } from '../dist/visible-structure-gate.js';
import { hasExposedChangedEntry } from '../dist/report/shared.js';
import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('horizontally scrolled grid keeps an on-screen addition reviewable after expansion (F1)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.setContent(`<!doctype html><html><head><style>
    body{margin:0}.grid{height:300px;width:1280px;overflow:auto}
    .inner{position:relative;width:4000px;height:1000px}
    .mark{position:absolute;left:1600px;top:50px;width:200px;height:80px}
  </style></head><body><div class="grid"><div class="inner"><div class="mark"></div></div></div></body></html>`);
  await page.locator('.grid').evaluate((el) => {
    el.scrollLeft = 1500;
  });
  const map = await captureStyleMap(page, { stabilize: false, captureStates: false });
  const mark = Object.values(map.elements).find((e) => e.cls === 'mark');
  expect(mark).toBeTruthy();
  expect(mark!.rect).toEqual([100, 50, 200, 80]);
  expect(mark!.screenshotRect).toEqual([1600, 50, 200, 80]);
  expect(isVisibleCapturedElement(mark!, map), 'the driven box preserves reviewability').toBe(true);
  expect(await page.locator('.grid').evaluate((el) => el.scrollLeft)).toBe(1500);
});

// The gate also checks the expanded screenshot: below-fold content requires review
// even when the driven inner scroller clips it (extends the 7.5.1 gate rule).
test('full-page rect alignment gates below-fold content while preserving driven layout boxes', async ({ page }) => {
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
    expect(entry!.rect, 'layout comparisons retain the driven-state box').toEqual([0, 200, 800, 400]);
    expect(entry!.screenshotRect, 'report crops use the expanded screenshot box').toEqual([0, 800, 800, 400]);
    const [topPath, top] = Object.entries(map.elements).find(([, e]) => e.cls === 'band')!;
    expect([top.rect, top.screenshotRect]).toEqual([
      [0, -600, 800, 400],
      [0, 0, 800, 400],
    ]);
    expect(hasExposedChangedEntry(map, map, [topPath]), 'scrolled-out band still anchors a report crop').toBe(true);
    await captureSurfaceScreenshots(page, path.join(output, 'board'));
    const png = PNG.sync.read(fs.readFileSync(path.join(output, 'board.png')));
    expect(map.viewport!.screenshotHeight, 'recorded expanded height matches the screenshot').toBe(png.height);
    const pixel = (1000 * png.width + 400) * 4;
    expect([...png.data.subarray(pixel, pixel + 3)]).toEqual([255, 0, 128]);
    expect(await page.locator('.scroller').evaluate((el) => el.scrollTop)).toBe(600);
    await page.locator('.scroller').evaluate((el) => {
      el.scrollTop = 0;
    });
    const offscreen = await captureStyleMap(page, { stabilize: false, captureStates: false });
    const offscreenEntry = Object.values(offscreen.elements).find((e) => e.cls === 'band marker');
    expect(
      isVisibleCapturedElement(offscreenEntry!, offscreen),
      'below-fold marker in screenshot requires review',
    ).toBe(true);
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
  expect(await page.locator('body').getAttribute('style')).toBeNull();
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
  expect(await page.locator('body').getAttribute('style'), 'restore removes the added body style attribute').toBeNull();
  const second = await captureStyleMap(page, options);
  expect(second, 'a repeated capture has the same geometry and computed styles').toEqual(first);
});

for (const mode of ['standards', 'quirks']) {
  for (const scroller of ['body', 'main']) {
    test(`${mode} ${scroller} scroller: expanded below-fold banner requires review in diff and report`, async ({
      page,
    }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-nested-structure-'));
      try {
        await page.setViewportSize({ width: 1280, height: 720 });
        for (const present of [false, true]) {
          const content = `<div class="content">${present ? '<div class="banner"></div>' : ''}</div>`;
          await page.setContent(`${mode === 'standards' ? '<!doctype html>' : ''}<html><head><style>
            html,body{margin:0;height:100%}html{overflow:hidden}
            body{overflow:${scroller === 'body' ? 'auto' : 'hidden'}}
            main{height:100%;overflow:auto}.content{position:relative;height:3000px}
            .banner{position:absolute;left:0;top:2000px;width:1280px;height:80px;background:rgb(255,0,128)}
          </style></head><body>${scroller === 'main' ? `<main>${content}</main>` : content}</body></html>`);
          expect(await page.evaluate(() => document.compatMode)).toBe(
            mode === 'standards' ? 'CSS1Compat' : 'BackCompat',
          );
          const bodyStyle = await page.locator('body').getAttribute('style');
          const map = await captureStyleMap(page, { stabilize: false });
          expect(await page.locator('body').getAttribute('style')).toBe(bodyStyle);
          expect(map.viewport!.documentHeight, 'driven document does not expose the scroller content').toBe(720);
          expect(map.viewport!.screenshotHeight).toBe(3000);
          const dir = path.join(root, present ? 'head' : 'base');
          saveStyleMap(path.join(dir, 'nested@1280.json.gz'), map);
          await captureSurfaceScreenshots(page, path.join(dir, 'nested@1280'));
          expect(await page.locator('body').getAttribute('style')).toBe(bodyStyle);
          const png = PNG.sync.read(fs.readFileSync(path.join(dir, 'nested@1280.png')));
          expect(png.height).toBe(map.viewport!.screenshotHeight);
          const pixel = (2040 * png.width + 640) * 4;
          expect([...png.data.subarray(pixel, pixel + 3)]).toEqual(present ? [255, 0, 128] : [255, 255, 255]);
          fs.writeFileSync(
            path.join(dir, 'styleproof-manifest.json'),
            JSON.stringify({
              version: 1,
              packageVersion: 'test',
              sha: (present ? 'b' : 'a').repeat(40),
              dirty: false,
              spec: 'e2e/styleproof.spec.ts',
              specHash: '0'.repeat(64),
              platform: process.platform,
              arch: process.arch,
              nodeMajor: process.versions.node.split('.')[0],
              screenshots: true,
              har: false,
              compatibilityKey: '0'.repeat(16),
              createdAt: '2026-01-01T00:00:00.000Z',
            }),
          );
        }
        const json = path.join(root, 'diff.json');
        const out = path.join(root, 'report');
        for (const [bin, args, receipt] of [
          ['styleproof-diff', ['--allow-unasserted', '--json', json], json],
          ['styleproof-report', ['--out', out], path.join(out, 'report.json')],
        ] as const) {
          // Diagnostic diff mode permits these bundles without a coverage/determinism ledger.
          // The unchanged control proves exit 1 is caused by the banner finding.
          for (const [after, expected] of [
            ['base', 0],
            ['head', 1],
          ] as const) {
            const sourceArgs = [
              '--expected-before-sha',
              'a'.repeat(40),
              '--expected-after-sha',
              (expected ? 'b' : 'a').repeat(40),
            ];
            const result = spawnSync(
              process.execPath,
              [
                path.join(ROOT, 'bin', `${bin}.mjs`),
                path.join(root, 'base'),
                path.join(root, after),
                ...args,
                ...sourceArgs,
              ],
              { cwd: root, encoding: 'utf8', timeout: 30_000 },
            );
            expect(result.status, `${bin} ${after}: ${result.stderr || result.stdout}`).toBe(expected);
            expect(JSON.parse(fs.readFileSync(receipt, 'utf8')).reviewableCounts.dom).toBe(expected);
          }
        }
        for (const style of ['display:none', 'visibility:hidden', 'opacity:0', 'width:0', 'height:0']) {
          await page.locator('.banner').evaluate((el, value) => el.setAttribute('style', value), style);
          const map = await captureStyleMap(page, { stabilize: false });
          const banner = Object.values(map.elements).find((e) => e.cls === 'banner');
          expect(banner, 'hidden additions are still captured').toBeTruthy();
          expect(isVisibleCapturedElement(banner!, map), `${style} stays advisory inside the scroller`).toBe(false);
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
