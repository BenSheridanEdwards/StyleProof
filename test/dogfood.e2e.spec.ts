import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captureStyleMap,
  defineStyleMapCapture,
  diffStyleMaps,
  detectViewportWidths,
  generateStyleMapReport,
  loadStyleMap,
} from '../dist/index.js';

// Dogfood: StyleProof runs on its OWN example page (example/demo/index.html) in CI —
// proving the capture → detect → diff pipeline end to end on a real, multi-element
// page, not just the unit fixtures. The demo is deterministic (no web fonts, no
// animation, only query-driven JS for pinned live states), so these never flake.
const here = path.dirname(fileURLToPath(import.meta.url));
const DEMO = 'file://' + path.join(here, '..', 'example', 'demo', 'index.html');
const LIVE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-dogfood-live-'));
const LIVE_WIDTH = 900;
const POPUP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-dogfood-popup-'));
const POPUP_WIDTH = 720;

function liveUrl(state: 'loading' | 'loaded', tone: 'base' | 'head'): string {
  return `${DEMO}?state=${state}&tone=${tone}`;
}

function liveSurface(tone: 'base' | 'head') {
  return {
    key: 'demo-live',
    go: async () => {},
    widths: [LIVE_WIDTH],
    liveStates: [
      {
        key: 'loading',
        go: async (page) => {
          await page.goto(liveUrl('loading', tone), { waitUntil: 'load' });
        },
      },
      {
        key: 'loaded',
        go: async (page) => {
          await page.goto(liveUrl('loaded', tone), { waitUntil: 'load' });
        },
      },
    ],
  };
}

function popupSurface(tone: 'base' | 'head') {
  const detailsBackground = tone === 'base' ? 'rgb(255, 255, 255)' : 'rgb(219, 234, 254)';
  const menuBackground = tone === 'base' ? 'rgb(254, 249, 195)' : 'rgb(254, 226, 226)';
  const listboxBackground = tone === 'base' ? 'rgb(240, 253, 244)' : 'rgb(220, 252, 231)';
  const toastBackground = tone === 'base' ? 'rgb(255, 255, 255)' : 'rgb(254, 242, 242)';
  return {
    key: 'demo-popup',
    widths: [POPUP_WIDTH],
    popups: true,
    go: async (page) => {
      await page.setContent(`
        <style>
          body { margin: 0; font-family: system-ui, sans-serif; background: rgb(248, 250, 252); }
          main { min-height: 480px; display: grid; place-items: center; }
          .actions { display: flex; gap: 12px; }
          button { padding: 12px 18px; border-radius: 8px; border: 1px solid rgb(37, 99, 235); background: rgb(37, 99, 235); color: white; font-weight: 700; }
          [role="dialog"], [role="menu"], [role="listbox"], [data-hot-toast] { position: fixed; inset: 120px auto auto 50%; width: 320px; transform: translateX(-50%); padding: 24px; border: 2px solid rgb(30, 64, 175); background: rgb(255, 255, 255); box-shadow: 0 20px 45px rgba(15, 23, 42, 0.18); }
          [role="menu"] { inset-block-start: 170px; }
          [role="listbox"] { inset-block-start: 220px; }
          [data-hot-toast] { inset-block-start: 270px; }
          [hidden] { display: none; }
        </style>
        <main>
          <div class="actions">
            <button id="open-details" type="button">Open details</button>
            <button id="open-menu" type="button" aria-haspopup="menu">Open menu</button>
            <button id="open-listbox" type="button" aria-haspopup="listbox">Open listbox</button>
            <button id="open-toast" type="button">Show toast</button>
          </div>
          <section id="details" role="dialog" aria-modal="true" hidden>
            <h1 id="popup-title">Details</h1>
            <p id="popup-copy">Stable popup content.</p>
          </section>
          <nav id="menu" role="menu" hidden>
            <button role="menuitem" type="button">Merge now</button>
          </nav>
          <ul id="listbox" role="listbox" hidden>
            <li role="option" aria-selected="true">Reviewer queue</li>
          </ul>
          <div id="toast" class="hot-toast" data-hot-toast="visible" role="status" aria-live="polite" hidden>
            Hot toast saved
          </div>
        </main>
        <script>
          function show(id, background) {
            const popup = document.getElementById(id);
            popup.hidden = false;
            popup.dataset.state = 'open';
            popup.style.background = background;
          }
          document.getElementById('open-details').addEventListener('click', () => show('details', '${detailsBackground}'));
          document.getElementById('open-menu').addEventListener('click', () => show('menu', '${menuBackground}'));
          document.getElementById('open-listbox').addEventListener('click', () => show('listbox', '${listboxBackground}'));
          document.getElementById('open-toast').addEventListener('click', () => show('toast', '${toastBackground}'));
        </script>
      `);
    },
  };
}

test.describe('dogfood live-state base capture', () => {
  defineStyleMapCapture({
    parallel: false, // this file's own tests read the maps in file order
    surfaces: [liveSurface('base')],
    dir: 'dogfood-base',
    baseDir: LIVE_ROOT,
    screenshots: true,
    selfCheck: true,
  });
});

test.describe('dogfood live-state head capture', () => {
  defineStyleMapCapture({
    parallel: false, // this file's own tests read the maps in file order
    surfaces: [liveSurface('head')],
    dir: 'dogfood-head',
    baseDir: LIVE_ROOT,
    screenshots: true,
    selfCheck: true,
  });
});

test.describe('dogfood popup base capture', () => {
  defineStyleMapCapture({
    parallel: false, // this file's own tests read the maps in file order
    surfaces: [popupSurface('base')],
    dir: 'popup-base',
    baseDir: POPUP_ROOT,
    screenshots: true,
    selfCheck: true,
  });
});

test.describe('dogfood popup head capture', () => {
  defineStyleMapCapture({
    parallel: false, // this file's own tests read the maps in file order
    surfaces: [popupSurface('head')],
    dir: 'popup-head',
    baseDir: POPUP_ROOT,
    screenshots: true,
    selfCheck: true,
  });
});

test.afterAll(() => {
  fs.rmSync(LIVE_ROOT, { recursive: true, force: true });
  fs.rmSync(POPUP_ROOT, { recursive: true, force: true });
});

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

test('dogfood: liveStates split the demo and report only loaded-to-loaded restyle', () => {
  const beforeDir = path.join(LIVE_ROOT, 'dogfood-base');
  const afterDir = path.join(LIVE_ROOT, 'dogfood-head');
  const outDir = path.join(LIVE_ROOT, 'report');
  const loadingSurface = `demo-live-loading@${LIVE_WIDTH}`;
  const loadedSurface = `demo-live-loaded@${LIVE_WIDTH}`;

  const loadingBefore = loadStyleMap(path.join(beforeDir, `${loadingSurface}.json.gz`));
  const loadingAfter = loadStyleMap(path.join(afterDir, `${loadingSurface}.json.gz`));
  const loadedBefore = loadStyleMap(path.join(beforeDir, `${loadedSurface}.json.gz`));
  const loadedAfter = loadStyleMap(path.join(afterDir, `${loadedSurface}.json.gz`));

  expect(loadingBefore.metadata).toEqual({
    surfaceKey: 'demo-live',
    variantKey: 'loading',
    variantKind: 'live-state',
  });
  expect(loadedBefore.metadata).toEqual({
    surfaceKey: 'demo-live',
    variantKey: 'loaded',
    variantKind: 'live-state',
  });
  expect(loadingBefore.liveCandidates).toContainEqual(
    expect.objectContaining({
      tag: 'section',
      cls: 'status-card loading',
      role: 'status',
      ariaLive: 'polite',
      ariaBusy: 'true',
    }),
  );
  expect(loadingAfter.liveCandidates).toContainEqual(
    expect.objectContaining({
      tag: 'section',
      cls: 'status-card loading',
      role: 'status',
      ariaLive: 'polite',
      ariaBusy: 'true',
    }),
  );
  expect(diffStyleMaps(loadingBefore, loadingAfter), 'loading compares to loading with no diff').toEqual([]);

  const loadedDiff = diffStyleMaps(loadedBefore, loadedAfter);
  expect(
    loadedDiff.some((finding) => finding.kind === 'style' && finding.props.some((p) => p.prop === 'background-color')),
    'loaded compares to loaded and catches the deliberate status-card restyle',
  ).toBe(true);

  const report = generateStyleMapReport({ beforeDir, afterDir, outDir });
  expect(report.changedSurfaces).toBe(1);
  expect(report.totalFindings).toBeGreaterThan(0);

  const md = fs.readFileSync(report.reportMdPath, 'utf8');
  expect(md).toContain('demo-live-loaded @ 900 · live state `loaded`');
  expect(md).not.toContain('demo-live-loading @ 900');
  expect(md).toContain('background');
});

function expectOverlay(
  map: ReturnType<typeof loadStyleMap>,
  predicate: (overlay: NonNullable<ReturnType<typeof loadStyleMap>['overlays']>[number]) => boolean,
  label: string,
) {
  expect(map.overlays?.some(predicate), label).toBe(true);
}

test('dogfood: popups capture semantic dialog, dropdown, listbox and toast states', () => {
  const beforeDir = path.join(POPUP_ROOT, 'popup-base');
  const afterDir = path.join(POPUP_ROOT, 'popup-head');
  const outDir = path.join(POPUP_ROOT, 'report');
  const detailsSurfaceKey = `demo-popup-popup-01@${POPUP_WIDTH}`;
  const menuSurfaceKey = `demo-popup-popup-02@${POPUP_WIDTH}`;
  const listboxSurfaceKey = `demo-popup-popup-03@${POPUP_WIDTH}`;
  const toastSurfaceKey = `demo-popup-popup-04@${POPUP_WIDTH}`;

  const detailsBefore = loadStyleMap(path.join(beforeDir, `${detailsSurfaceKey}.json.gz`));
  const detailsAfter = loadStyleMap(path.join(afterDir, `${detailsSurfaceKey}.json.gz`));
  const menuBefore = loadStyleMap(path.join(beforeDir, `${menuSurfaceKey}.json.gz`));
  const menuAfter = loadStyleMap(path.join(afterDir, `${menuSurfaceKey}.json.gz`));
  const listboxBefore = loadStyleMap(path.join(beforeDir, `${listboxSurfaceKey}.json.gz`));
  const listboxAfter = loadStyleMap(path.join(afterDir, `${listboxSurfaceKey}.json.gz`));
  const toastBefore = loadStyleMap(path.join(beforeDir, `${toastSurfaceKey}.json.gz`));
  const toastAfter = loadStyleMap(path.join(afterDir, `${toastSurfaceKey}.json.gz`));

  expect(detailsBefore.metadata).toEqual({
    surfaceKey: 'demo-popup',
    variantKey: 'popup-01',
    variantKind: 'popup',
  });
  expect(menuBefore.metadata).toEqual({
    surfaceKey: 'demo-popup',
    variantKey: 'popup-02',
    variantKind: 'popup',
  });
  expect(listboxBefore.metadata?.variantKey).toBe('popup-03');
  expect(toastBefore.metadata?.variantKey).toBe('popup-04');
  expectOverlay(
    detailsBefore,
    (overlay) => overlay.role === 'dialog' && overlay.ariaModal === 'true',
    'role="dialog" + aria-modal popup is captured',
  );
  expectOverlay(menuBefore, (overlay) => overlay.role === 'menu', 'role="menu" dropdown is captured');
  expectOverlay(listboxBefore, (overlay) => overlay.role === 'listbox', 'role="listbox" dropdown is captured');
  expectOverlay(
    toastBefore,
    (overlay) =>
      overlay.role === 'status' &&
      overlay.reason.includes('data-hot-toast') &&
      (overlay.text ?? '').includes('Hot toast saved'),
    'hot-toast status text is captured',
  );

  const changedBackground = (before: typeof detailsBefore, after: typeof detailsAfter) =>
    diffStyleMaps(before, after).some(
      (finding) => finding.kind === 'style' && finding.props.some((p) => p.prop === 'background-color'),
    );
  expect(changedBackground(detailsBefore, detailsAfter), 'the click-open dialog background change is caught').toBe(
    true,
  );
  expect(changedBackground(menuBefore, menuAfter), 'the menu dropdown background change is caught').toBe(true);
  expect(changedBackground(listboxBefore, listboxAfter), 'the listbox dropdown background change is caught').toBe(true);
  expect(changedBackground(toastBefore, toastAfter), 'the hot-toast background change is caught').toBe(true);

  const report = generateStyleMapReport({ beforeDir, afterDir, outDir });
  expect(report.changedSurfaces).toBe(4);
  const md = fs.readFileSync(report.reportMdPath, 'utf8');
  expect(md).toContain('demo-popup-popup-01 @ 720 · popup `popup-01`');
  expect(md).toContain('demo-popup-popup-02 @ 720 · popup `popup-02`');
  expect(md).toContain('demo-popup-popup-03 @ 720 · popup `popup-03`');
  expect(md).toContain('demo-popup-popup-04 @ 720 · popup `popup-04`');
});
