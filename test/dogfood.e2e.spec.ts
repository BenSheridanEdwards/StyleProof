import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureStyleMap, diffStyleMaps, detectViewportWidths } from '../dist/index.js';

// Dogfood: StyleProof runs on its OWN example page (example/demo/index.html) in CI —
// proving the capture → detect → diff pipeline end to end on a real, multi-element
// page, not just the unit fixtures. The demo is deterministic (no web fonts, no
// animation, no JS), so these never flake.
const here = path.dirname(fileURLToPath(import.meta.url));
const DEMO = 'file://' + path.join(here, '..', 'example', 'demo', 'index.html');

test('dogfood: detects the demo real @media breakpoints (auto widths)', async ({ page }) => {
  await page.goto(DEMO, { waitUntil: 'load' });
  // The demo declares exactly @media (min-width: 600px) and (min-width: 900px) →
  // one viewport per band, base band represented by 360.
  expect(await detectViewportWidths(page)).toEqual([360, 600, 900]);
});

test('dogfood: StyleProof certifies its own demo unchanged (deterministic capture)', async ({ page }) => {
  await page.goto(DEMO, { waitUntil: 'load' });
  const a = await captureStyleMap(page);
  await page.goto(DEMO, { waitUntil: 'load' });
  const b = await captureStyleMap(page);
  expect(diffStyleMaps(a, b), 'two captures of the demo are identical').toEqual([]);
});

test('dogfood: StyleProof catches a real restyle of the demo', async ({ page }) => {
  await page.goto(DEMO, { waitUntil: 'load' });
  const before = await captureStyleMap(page);
  await page.goto(DEMO, { waitUntil: 'load' });
  await page.addStyleTag({ content: '.btn { background: rgb(220, 38, 38); }' }); // recolour the CTA
  const after = await captureStyleMap(page);
  const recolour = diffStyleMaps(before, after).find(
    (f) => f.kind === 'style' && f.props.some((p) => p.prop === 'background-color'),
  );
  expect(recolour, 'the CTA background change is caught').toBeTruthy();
});
