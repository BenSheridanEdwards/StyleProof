import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assessDeterminismOracle,
  defineStyleMapCapture,
  diffStyleMaps,
  hashDeterminismMap,
  loadStyleMap,
  parseStateRecipes,
} from '../dist/index.js';

/**
 * #391 capture integration: Surface.stateRecipes expand into independent
 * styleproof captures with variantKind 'state-recipe' and exact safe provenance.
 * Sticky CSS mirrors real interaction (same fixture pattern as state-recipes.e2e).
 *
 * Determinism is proven by five independent capture dirs (fresh contexts), not
 * in-test selfCheck: full captureStyleMap (forced-state layer + hover-sink) can
 * disagree with sticky mouseenter fixtures on a second pass of the same page.
 * The five-run canonical hash oracle is the promotion gate required by #400.
 */

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-state-recipe-capture-'));
const WIDTH = 900;

const FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; font-family: system-ui, sans-serif; color: rgb(17, 24, 39); }
  .card { padding: 16px; background: rgb(243, 244, 246); border: 2px solid transparent; width: 200px; }
  body.card-hovered .card { background: rgb(219, 234, 254); border-color: rgb(37, 99, 235); }
  .tip { display: none; padding: 8px 12px; background: rgb(15, 118, 110); color: white; width: 200px; }
  body.card-hovered .tip { display: block; }
  input {
    display: block; margin: 16px; padding: 8px 12px; width: 220px; box-sizing: border-box;
    border: 2px solid rgb(209, 213, 219); outline: none;
    background: rgb(255, 255, 255);
  }
  body.email-focused input#email {
    border-color: rgb(124, 58, 237);
    background: rgb(245, 243, 255);
    box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.35);
  }
  [role="listbox"] {
    display: none; margin: 16px; padding: 8px; width: 180px; height: 72px; box-sizing: border-box;
    background: rgb(254, 243, 199); border: 2px solid rgb(217, 119, 6);
  }
  body.list-open [role="listbox"] { display: block; color: rgb(146, 64, 14); }
  body.menu-clicked #menu { background: rgb(254, 226, 226); border: 2px solid rgb(220, 38, 38); }
  button { margin: 16px; width: 120px; height: 36px; }
</style></head><body>
  <div class="card" id="card" aria-label="Plan card" tabindex="0">Plan card</div>
  <p class="tip" id="tip">Hover tip</p>
  <label>Email <input id="email" aria-label="Email" /></label>
  <button id="menu" aria-label="Open menu" aria-haspopup="listbox">Menu</button>
  <ul role="listbox" id="list" aria-label="Plan options">
    <li role="option">Free</li>
    <li role="option">Pro</li>
  </ul>
  <script>
    const card = document.getElementById('card');
    card.addEventListener('mouseenter', () => document.body.classList.add('card-hovered'));
    const email = document.getElementById('email');
    email.addEventListener('focus', () => document.body.classList.add('email-focused'));
    const menu = document.getElementById('menu');
    menu.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'Enter') {
        document.body.classList.add('list-open');
      }
    });
    menu.addEventListener('click', () => {
      document.body.classList.add('menu-clicked');
      document.body.classList.add('list-open');
    });
  </script>
</body></html>`;

const recipes = parseStateRecipes([
  { action: 'hover', selector: '#card', label: 'Plan card' },
  { action: 'focus', selector: '#email', label: 'Email' },
  { action: 'press', selector: '#menu', key: 'ArrowDown', label: 'Open menu' },
  { action: 'click', selector: '#menu', label: 'Open menu' },
]);

function recipeSurface() {
  return {
    key: 'demo',
    widths: [WIDTH] as number[],
    go: async (page: import('@playwright/test').Page) => {
      await page.setContent(FIXTURE_HTML, { waitUntil: 'load' });
    },
    stateRecipes: recipes,
  };
}

const CAPTURE_DIRS = ['maps-1', 'maps-2', 'maps-3', 'maps-4', 'maps-5'] as const;

for (const dir of CAPTURE_DIRS) {
  test.describe(`state-recipe surface capture ${dir}`, () => {
    defineStyleMapCapture({
      parallel: false,
      surfaces: [recipeSurface()],
      dir,
      baseDir: ROOT,
      screenshots: false,
      // Cross-directory canonical hashes are the determinism oracle.
      selfCheck: false,
    });
  });
}

test.afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function mapPath(dir: string, key: string): string {
  return path.join(ROOT, dir, `${key}@${WIDTH}.json.gz`);
}

const EXPECTED = [
  {
    key: 'demo-hover-plan-card',
    provenance: {
      stateKey: 'hover-plan-card',
      action: 'hover' as const,
      selector: '#card',
      label: 'Plan card',
    },
  },
  {
    key: 'demo-focus-email',
    provenance: {
      stateKey: 'focus-email',
      action: 'focus' as const,
      selector: '#email',
      label: 'Email',
    },
  },
  {
    key: 'demo-press-open-menu-arrowdown',
    provenance: {
      stateKey: 'press-open-menu-arrowdown',
      action: 'press' as const,
      selector: '#menu',
      key: 'ArrowDown',
      label: 'Open menu',
    },
  },
  {
    key: 'demo-click-open-menu',
    provenance: {
      stateKey: 'click-open-menu',
      action: 'click' as const,
      selector: '#menu',
      label: 'Open menu',
    },
  },
];

test('state-recipe capture: maps carry variantKind and exact safe provenance', () => {
  const base = loadStyleMap(mapPath(CAPTURE_DIRS[0], 'demo'));
  expect(base.metadata).toEqual({ surfaceKey: 'demo' });

  for (const exp of EXPECTED) {
    const map = loadStyleMap(mapPath(CAPTURE_DIRS[0], exp.key));
    expect(map.metadata).toEqual({
      surfaceKey: 'demo',
      variantKey: exp.provenance.stateKey,
      variantKind: 'state-recipe',
      stateRecipe: exp.provenance,
    });
    const drift = diffStyleMaps(base, map);
    expect(drift.length, `${exp.key} should differ from baseline`).toBeGreaterThan(0);
  }
});

test('state-recipe capture: five fresh-context runs have identical ordered keys and canonical map hashes', () => {
  const surfaceKeys = ['demo', ...EXPECTED.map((entry) => entry.key)];
  const stateKeys = surfaceKeys.map((key) => `${key}@${WIDTH}`);
  const runs = CAPTURE_DIRS.map((dir) => {
    const mapHashes = Object.fromEntries(
      surfaceKeys.map((key) => [`${key}@${WIDTH}`, hashDeterminismMap(loadStyleMap(mapPath(dir, key)))]),
    );
    return { stateKeys, mapHashes };
  });

  const verdict = assessDeterminismOracle(runs);
  test.info().annotations.push({
    type: 'determinism-oracle',
    description: JSON.stringify(verdict),
  });

  expect(verdict).toEqual({
    status: 'deterministic',
    requiredRuns: 5,
    observedRuns: 5,
    matchingRuns: 5,
    stateKeys,
    mapHashes: runs[0].mapHashes,
  });
});
