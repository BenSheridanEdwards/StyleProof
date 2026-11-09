/**
 * The visual-first report end to end, from real Chromium captures: a small shop page whose
 * pull request recolours the card titles, pads the cards and changes the buttons' hover and
 * focus colours. Checks the Markdown sections, clean crops, Change Reach rule names, and the
 * browser report's cards, Where maps, theme switch and phone layout.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { captureStyleMap, trackServedRules } from '../dist/index.js';
import { captureStateLayerScreenshots } from '../dist/capture.js';
import { writeCaptureManifest } from '../dist/map-store.js';
import { generateStyleMapReport } from '../dist/report.js';
import { mkTmp, rmTmp, writeCapture } from './helpers.mjs';

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"></head>
<body><header class="site">Shop</header><main><h1>Featured</h1><section class="grid">
<article class="card"><h2 class="card-title">Lamp</h2><p>A desk lamp.</p><button class="btn" type="button">Add to basket</button></article>
<article class="card"><h2 class="card-title">Chair</h2><p>An oak chair.</p><button class="btn" type="button">Add to basket</button></article>
<article class="card"><h2 class="card-title">Rug</h2><p>A wool rug.</p><button class="btn" type="button">Add to basket</button></article>
</section></main></body></html>`;

const css = (head: boolean) => `* { box-sizing: border-box; }
body { margin: 0; font-family: sans-serif; color: #222; background: #fff; }
header.site { background: #f2f2f2; padding: 12px 24px; }
main { padding: 24px; }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; align-items: start; }
.card { border: 1px solid #ccc; border-radius: 8px; padding: ${head ? 24 : 16}px; }
.card-title { margin: 0 0 8px; font-size: 20px; color: ${head ? 'rgb(150, 30, 60)' : 'rgb(30, 60, 120)'}; }
.btn { background: rgb(50, 50, 90); color: #fff; border: 0; border-radius: 3px; padding: 8px 14px; outline: 3px solid transparent; }
.btn:hover { background: ${head ? 'rgb(200, 40, 40)' : 'rgb(30, 70, 170)'}; }
.btn:focus-visible { outline-color: ${head ? 'rgb(0, 160, 80)' : 'rgb(250, 160, 0)'}; }`;

test('a shop pull request reads as three visual changes with clean crops and a themed browser report', async ({
  page,
}) => {
  const root = mkTmp('styleproof-visual-first-');
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    for (const side of ['base', 'head'] as const) {
      await page.unroute('http://shop.test/**');
      await page.route('http://shop.test/**', (route) =>
        route.request().url().endsWith('/styles.css')
          ? route.fulfill({ contentType: 'text/css', body: css(side === 'head') })
          : route.fulfill({ contentType: 'text/html', body: HTML }),
      );
      const servedRules = await trackServedRules(page);
      const options = { captureReach: true, servedRules };
      await page.goto('http://shop.test/', { waitUntil: 'load' });
      const map = await captureStyleMap(page, options).finally(() => servedRules.dispose());
      const dir = path.join(root, side);
      writeCapture(dir, 'shop@1280', map, await page.screenshot({ type: 'png', fullPage: true }));
      await captureStateLayerScreenshots(page, path.join(dir, 'shop@1280'), { captureReach: true });
      writeCaptureManifest({ dir, screenshots: true });
    }
    const outDir = path.join(root, 'report');
    const result = generateStyleMapReport({
      beforeDir: path.join(root, 'base'),
      afterDir: path.join(root, 'head'),
      outDir,
    });
    const md = fs.readFileSync(result.reportMdPath, 'utf8');

    expect(md).toContain('**3 changes to review** on `shop` at 1280px wide: 9 elements, 4 changed CSS rules.');
    expect([...md.matchAll(/^### (.+)$/gm)].map((m) => m[1])).toEqual([
      'Cards',
      'Card titles',
      'Add to basket buttons',
    ]);
    expect(md).toContain('All 3 card titles (Lamp, Chair, Rug) change text colour from dark indigo to dark red.');
    expect(md).toContain('`h2.card-title` · 3 elements restyled · changed rule `.card-title` in `/styles.css`');
    expect(md).toMatch(
      /`button\.btn` · 3 elements restyled · changed rules `\.btn:(focus-visible|hover)`, `\.btn:(focus-visible|hover)` in `\/styles\.css`/,
    );
    expect(md).toContain('**While hovered**');
    expect(md).toContain('**While focused**');
    expect(md).not.toMatch(/Product-state identity unproven|composite|annotated|magenta|What changed/);

    // Every before/after crop is an untouched rectangle of its capture.
    const report = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
    const titles = report.surfaces[0].regions.find((r: { paths: string[] }) => r.paths[0].endsWith('h2:nth-child(1)'));
    const full = PNG.sync.read(fs.readFileSync(path.join(root, 'head', 'shop@1280.png')));
    const crop = PNG.sync.read(fs.readFileSync(path.join(outDir, titles.images.after)));
    const origin = (() => {
      for (let y = 0; y <= full.height - crop.height; y++)
        for (let x = 0; x <= full.width - crop.width; x++) {
          let same = true;
          for (let cy = 0; same && cy < crop.height; cy += 7)
            for (let cx = 0; same && cx < crop.width; cx += 7) {
              const a = (cy * crop.width + cx) * 4;
              const b = ((y + cy) * full.width + x + cx) * 4;
              same =
                crop.data[a] === full.data[b] &&
                crop.data[a + 1] === full.data[b + 1] &&
                crop.data[a + 2] === full.data[b + 2];
            }
          if (same) return { x, y };
        }
      return null;
    })();
    expect(origin, 'the after crop is a rectangle of the head capture').not.toBeNull();

    // The browser report: cards, Where maps, folds closed, theme switch, phone layout.
    await page.goto(`file://${path.join(outDir, 'report.html')}`);
    await expect(page.locator('section.change')).toHaveCount(3);
    await expect(page.locator('section.change svg.map')).toHaveCount(3);
    await expect(page.locator('nav.toc a')).toHaveText(['Cards', 'Card titles', 'Add to basket buttons']);
    await expect(page.locator('details.more.css[open]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
    await page.setViewportSize({ width: 390, height: 800 });
    const [before, after] = await page.locator('#card-titles .pair figure').all();
    const [b, a] = [await before.boundingBox(), await after.boundingBox()];
    expect(a!.y).toBeGreaterThan(b!.y + b!.height - 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  } finally {
    rmTmp(root);
  }
});
