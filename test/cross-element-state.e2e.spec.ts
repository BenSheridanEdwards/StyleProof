import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { captureStateLayerScreenshots, captureStyleMap, diffStyleMaps } from '../dist/index.js';

const PROOF_DIR = path.resolve('.styleproof', 'fresh-fix');

function fixture(panelHover: string, shellFocus: string, statusActive: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; background: rgb(255, 255, 255); }
    .shell { margin: 32px; padding: 16px; border: 4px solid rgb(80, 80, 80); }
    button { padding: 12px 18px; background: rgb(20, 20, 20); color: white; border: 0; }
    .panel { margin-top: 12px; padding: 16px; background: rgb(255, 0, 0); }
    .status { margin-top: 12px; color: rgb(80, 80, 80); }
    button:hover + .panel { background: ${panelHover}; }
    .shell:has(button:focus) { border-color: ${shellFocus}; }
    .shell:has(button:active) .status { color: ${statusActive}; }
  </style></head><body>
    <main class="shell"><button type="button">Inspect</button><section class="panel">Panel</section><p class="status">Status</p></main>
  </body></html>`;
}

async function loadFixture(page: Page, html: string) {
  await page.setContent(html, { waitUntil: 'load' });
  return captureStyleMap(page, { stabilize: false });
}

test('captures forced states that restyle siblings and :has ancestors', async ({ page }) => {
  const before = fixture('rgb(0, 0, 255)', 'rgb(0, 0, 255)', 'rgb(0, 0, 255)');
  const after = fixture('rgb(0, 128, 0)', 'rgb(128, 0, 128)', 'rgb(255, 128, 0)');

  await page.setContent(before, { waitUntil: 'load' });
  await page.locator('button').hover();
  expect(await page.locator('.panel').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(0, 0, 255)');

  const beforeMap = await loadFixture(page, before);
  const afterMap = await loadFixture(page, after);
  const buttonPath = Object.entries(afterMap.elements).find(([, element]) => element.tag === 'button')?.[0];
  const panelPath = Object.entries(afterMap.elements).find(([, element]) => element.cls === 'panel')?.[0];
  const shellPath = Object.entries(afterMap.elements).find(([, element]) => element.cls === 'shell')?.[0];
  const statusPath = Object.entries(afterMap.elements).find(([, element]) => element.cls === 'status')?.[0];
  expect(buttonPath).toBeTruthy();
  expect(panelPath).toBeTruthy();
  expect(shellPath).toBeTruthy();
  expect(statusPath).toBeTruthy();

  expect(afterMap.states[buttonPath!]?.hover[panelPath!]?.['background-color']).toBe('rgb(0, 128, 0)');
  expect(afterMap.states[buttonPath!]?.focus[shellPath!]?.['border-top-color']).toBe('rgb(128, 0, 128)');
  expect(afterMap.states[buttonPath!]?.active[statusPath!]?.color).toBe('rgb(255, 128, 0)');

  const findings = diffStyleMaps(beforeMap, afterMap).filter((finding) => finding.kind === 'state');
  expect(findings.map((finding) => finding.state).sort()).toEqual(['active', 'focus', 'hover']);
  const replayMap = await loadFixture(page, after);
  expect(diffStyleMaps(afterMap, replayMap), 'recapturing the same cross-element states is a no-op').toEqual([]);

  fs.mkdirSync(PROOF_DIR, { recursive: true });
  await page.setContent(after, { waitUntil: 'load' });
  const written = await captureStateLayerScreenshots(page, path.join(PROOF_DIR, 'cross-element'));
  expect(written).toHaveLength(3);
});

test('detached interactive controls mark the forced-state layer incomplete', async ({ page }) => {
  const html = `<!doctype html><html><body>
    <button class="detached">detach</button>
    <script>
      const target = document.querySelector('.detached');
      new MutationObserver(() => {
        if (target.hasAttribute('data-styleproof-state-id')) target.remove();
      }).observe(target, { attributes: true });
    </script>
  </body></html>`;
  await page.setContent(html, { waitUntil: 'load' });
  const map = await captureStyleMap(page, { stabilize: false });
  expect(map.statesSkipped).toBe(true);
});

test('bounds document-wide forced-state work on a moderate multi-control page', async ({ page }) => {
  const controls = Array.from(
    { length: 24 },
    (_, index) => `<article><button>Control ${index}</button><div class="panel">Panel ${index}</div></article>`,
  ).join('');
  const content = Array.from({ length: 216 }, (_, index) => `<div>Content ${index}</div>`).join('');
  const html = `<!doctype html><html><head><style>
    button:hover + .panel { color: rgb(0, 128, 0); }
  </style></head><body>${controls}${content}</body></html>`;
  await page.setContent(html, { waitUntil: 'load' });

  const started = performance.now();
  const map = await captureStyleMap(page, { stabilize: false });
  const elapsedMs = performance.now() - started;
  const crossElementHoverTargets = Object.values(map.states).filter((states) =>
    Object.values(states.hover ?? {}).some((delta) => delta.color === 'rgb(0, 128, 0)'),
  ).length;

  // eslint-disable-next-line no-console
  console.log(
    `cross-element-state benchmark: controls=24 elements=290 elapsedMs=${elapsedMs.toFixed(1)} captured=${crossElementHoverTargets}`,
  );
  expect(map.statesSkipped).toBeFalsy();
  expect(crossElementHoverTargets).toBe(24);
  expect(elapsedMs, 'moderate bounded scan completes inside the E2E performance budget').toBeLessThan(60_000);
});

test('flags a target-first scan that reaches the document element bound', async ({ page }) => {
  const content = Array.from({ length: 2_050 }, (_, index) => `<div>Content ${index}</div>`).join('');
  const html = `<!doctype html><html><head><style>
    button:hover { color: rgb(0, 128, 0); }
  </style></head><body><button>Control</button>${content}</body></html>`;
  await page.setContent(html, { waitUntil: 'load' });

  const map = await captureStyleMap(page, { stabilize: false });
  const buttonPath = Object.entries(map.elements).find(([, element]) => element.tag === 'button')?.[0];
  expect(buttonPath).toBeTruthy();
  expect(map.states[buttonPath!]?.hover[buttonPath!]?.color, 'the target remains first inside the bound').toBe(
    'rgb(0, 128, 0)',
  );
  expect(map.statesSkipped, 'the omitted document remainder fails closed').toBe(true);
});
