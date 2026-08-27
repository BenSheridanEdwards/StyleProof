import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertUniqueExpandedKeys,
  captureArtifactStem,
  defaultSelfCheck,
  expandSurfaceVariants,
  resolveBaseDir,
  resolveOutputDir,
  resolveDataResidue,
  resolvePopupCaptureOptions,
  resolveScreenshots,
  selfCheckErrorMessage,
} from '../dist/runner.js';
import { coverageGaps } from '../dist/coverage.js';
import { StateRecipeError } from '../dist/state-recipes.js';
import { mkTmp, rmTmp } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLAYWRIGHT_CLI = path.join(ROOT, 'node_modules/@playwright/test/cli.js');
const DIST_INDEX_URL = pathToFileURL(path.join(ROOT, 'dist/index.js')).href;

function listPlaywrightTests(specSource) {
  const root = mkTmp('styleproof-runner-list-');
  try {
    const spec = path.join(root, 'styleproof.spec.mjs');
    const config = path.join(root, 'playwright.config.mjs');
    fs.writeFileSync(spec, specSource, 'utf8');
    fs.writeFileSync(config, `export default { testDir: ${JSON.stringify(root)} };\n`, 'utf8');
    const result = spawnSync(
      process.execPath,
      [PLAYWRIGHT_CLI, 'test', '--list', '--pass-with-no-tests', '--config', config],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, STYLEMAP_DIR: '' },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  } finally {
    rmTmp(root);
  }
}

// selfCheck defaults ON when recording (no replayFrom) — where live nondeterminism
// surfaces — and OFF when replaying (deterministic by construction). The env var
// forces it on either way; an explicit `selfCheck` is handled by the destructuring,
// not here.
test('defaultSelfCheck: ON when recording (no replayFrom)', () => {
  assert.equal(defaultSelfCheck(undefined, undefined), true);
});

test('defaultSelfCheck: OFF when replaying (replayFrom set)', () => {
  assert.equal(defaultSelfCheck('__stylemaps__/base', undefined), false);
});

test('defaultSelfCheck: STYLEPROOF_SELFCHECK=1 forces it on even when replaying', () => {
  assert.equal(defaultSelfCheck('__stylemaps__/base', '1'), true);
});

// baseDir/screenshots env overrides — what lets CLIs and CI redirect capture
// into cache/fallback dirs without editing the spec.
test('resolveBaseDir: explicit option wins over env and default', () => {
  assert.equal(resolveBaseDir('custom', 'stylemaps'), 'custom');
});

test('resolveBaseDir: STYLEPROOF_BASEDIR used when no explicit option', () => {
  assert.equal(resolveBaseDir(undefined, 'stylemaps'), 'stylemaps');
});

test('resolveBaseDir: default __stylemaps__ when neither is set', () => {
  assert.equal(resolveBaseDir(undefined, undefined), '__stylemaps__');
});

test('resolveScreenshots: STYLEPROOF_SCREENSHOTS=0 disables; on by default', () => {
  assert.equal(resolveScreenshots(undefined, '0'), false);
  assert.equal(resolveScreenshots(undefined, undefined), true);
});

test('resolveScreenshots: an explicit value wins over the env', () => {
  assert.equal(resolveScreenshots(false, undefined), false);
  assert.equal(resolveScreenshots(true, '0'), true);
});

// v4 breaking change: an unset `dataResidue` now GATES — a silently-failing data endpoint
// captured the fallback branch as the certified state, so gating is the correct default.
// `'warn'` is the explicit opt-out; an explicit `'gate'` is a no-op passthrough.
test('resolveDataResidue: unset spec defaults to gate (v4)', () => {
  assert.equal(resolveDataResidue(undefined), 'gate');
});

test('resolveDataResidue: explicit warn is the opt-out; explicit gate passes through', () => {
  assert.equal(resolveDataResidue('warn'), 'warn');
  assert.equal(resolveDataResidue('gate'), 'gate');
});

test('resolvePopupCaptureOptions: off by default and opt-in when enabled', () => {
  assert.equal(resolvePopupCaptureOptions(undefined).enabled, false);
  assert.equal(resolvePopupCaptureOptions(true).enabled, true);
});

test('resolvePopupCaptureOptions: default overlays include semantic popups and toasts', () => {
  const overlays = resolvePopupCaptureOptions(true).overlays;
  for (const selector of [
    '[role="dialog"]',
    '[aria-modal="true"]',
    '[role="menu"]',
    '[role="listbox"]',
    '[data-hot-toast]',
    '[role="status"]',
  ]) {
    assert.match(overlays, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('resolvePopupCaptureOptions: clamps numeric options', () => {
  assert.deepEqual(
    {
      enabled: resolvePopupCaptureOptions({ max: 2.7, timeoutMs: -5 }).enabled,
      max: resolvePopupCaptureOptions({ max: 2.7, timeoutMs: -5 }).max,
      timeoutMs: resolvePopupCaptureOptions({ max: 2.7, timeoutMs: -5 }).timeoutMs,
    },
    { enabled: true, max: 2, timeoutMs: 0 },
  );
});

test('expandSurfaceVariants: keeps the base capture and adds declared variants', async () => {
  const calls = [];
  const surfaces = expandSurfaceVariants({
    key: 'dashboard',
    go: async () => calls.push('surface'),
    ignore: ['.ticker'],
    widths: [1440, 768],
    height: 900,
    variants: [
      {
        key: 'dialog-open',
        setup: async () => calls.push('setup-dialog'),
        go: async () => calls.push('go-dialog'),
        ignore: ['.modal-clock'],
        widths: [1440],
      },
      { key: 'menu-open', go: async () => calls.push('go-menu') },
    ],
  });

  assert.deepEqual(
    surfaces.map((s) => s.key),
    ['dashboard', 'dashboard-dialog-open', 'dashboard-menu-open'],
  );
  assert.deepEqual(surfaces[0].metadata, { surfaceKey: 'dashboard' });
  assert.deepEqual(surfaces[1].widths, [1440]);
  assert.deepEqual(surfaces[2].widths, [1440, 768]);
  assert.equal(surfaces[1].height, 900);
  assert.deepEqual(surfaces[1].ignore, ['.ticker', '.modal-clock']);

  await surfaces[1].go({});
  assert.deepEqual(calls, ['setup-dialog', 'surface', 'go-dialog']);
});

test('assertUniqueExpandedKeys: passes when every expanded key is distinct', () => {
  const surfaces = [
    { key: 'a', metadata: { surfaceKey: 'a' } },
    { key: 'a-b', metadata: { surfaceKey: 'a', variantKey: 'b' } },
    { key: 'a-c', metadata: { surfaceKey: 'a', variantKey: 'c' } },
  ];
  assert.doesNotThrow(() => assertUniqueExpandedKeys(surfaces));
});

// Capture keys name map files under the output directory. Uniqueness alone is
// not enough: path traversal and drive-relative forms must fail closed (#421).
test('assertUniqueExpandedKeys: rejects traversal and path-separator keys before any map write', () => {
  for (const key of ['../escaped', '..\\escaped', 'foo/bar', 'foo\\bar', 'C:..\\outside', '/abs', 'a\0b']) {
    assert.throws(
      () => assertUniqueExpandedKeys([{ key, metadata: { surfaceKey: key } }]),
      (err) => {
        assert.match(err.message, /capture key/);
        assert.match(err.message, /safe|path|traversal|separator|single path segment|NUL/i);
        return true;
      },
      key,
    );
  }
});

test('captureArtifactStem keeps map paths inside the output directory', () => {
  const out = path.resolve('/tmp/styleproof-out');
  assert.equal(captureArtifactStem(out, 'home', 1280), path.join(out, 'home@1280'));
  assert.throws(() => captureArtifactStem(out, '../escaped', 800), /capture key/);
  const bad = path.resolve(out, '../escaped@800');
  assert.notEqual(path.dirname(bad), out);
});

test('assertUniqueExpandedKeys: throws naming BOTH origins on an ambiguous "-" join collision', () => {
  // surface `a` + variant `b-c`  and  surface `a-b` + variant `c`  both expand to `a-b-c`;
  // the second would silently overwrite the first's map file. Fail loud instead.
  const surfaces = [
    { key: 'a-b-c', metadata: { surfaceKey: 'a', variantKey: 'b-c' } },
    { key: 'a-b-c', metadata: { surfaceKey: 'a-b', variantKey: 'c' } },
  ];
  assert.throws(
    () => assertUniqueExpandedKeys(surfaces),
    (err) => {
      assert.match(err.message, /capture key 'a-b-c'/);
      assert.match(err.message, /surface 'a' variant 'b-c'/);
      assert.match(err.message, /surface 'a-b' variant 'c'/);
      return true;
    },
  );
});

test('assertUniqueExpandedKeys: real expansion of a collision-prone spec throws', () => {
  // Dogfood through expandSurfaceVariants: two surfaces whose base+variant keys alias.
  const expanded = [
    ...expandSurfaceVariants({ key: 'a', go: async () => {}, variants: [{ key: 'b-c', go: async () => {} }] }),
    ...expandSurfaceVariants({ key: 'a-b', go: async () => {}, variants: [{ key: 'c', go: async () => {} }] }),
  ];
  assert.throws(() => assertUniqueExpandedKeys(expanded), /capture key 'a-b-c'/);
});

test('expandSurfaceVariants: liveStates carry live-state metadata', () => {
  const states = expandSurfaceVariants({
    key: 'dashboard',
    go: async () => {},
    widths: [1440],
    liveStates: [{ key: 'loading' }, { key: 'loaded' }],
  });

  assert.deepEqual(
    states.map((s) => s.key),
    ['dashboard-loading', 'dashboard-loaded'],
  );
  assert.deepEqual(states[1].metadata, {
    surfaceKey: 'dashboard',
    variantKey: 'loaded',
    variantKind: 'live-state',
  });
});

test('expandSurfaceVariants: stateRecipes keep base, sort by key, and attach provenance', async () => {
  const calls = [];
  const surfaces = expandSurfaceVariants({
    key: 'pricing',
    go: async () => calls.push('surface'),
    widths: [900],
    // Intentionally unsorted input — parseStateRecipes sorts by derived key.
    stateRecipes: [
      { action: 'click', selector: '#menu', label: 'Open menu' },
      { action: 'hover', selector: '#card', label: 'Plan card' },
      { action: 'focus', selector: '#email', label: 'Email' },
      { action: 'press', selector: '#menu', key: 'ArrowDown', label: 'Open menu' },
    ],
  });

  assert.deepEqual(
    surfaces.map((s) => s.key),
    [
      'pricing',
      'pricing-click-open-menu',
      'pricing-focus-email',
      'pricing-hover-plan-card',
      'pricing-press-open-menu-arrowdown',
    ],
  );
  assert.deepEqual(surfaces[0].metadata, { surfaceKey: 'pricing' });
  assert.deepEqual(surfaces[3].metadata, {
    surfaceKey: 'pricing',
    variantKey: 'hover-plan-card',
    variantKind: 'state-recipe',
    stateRecipe: {
      stateKey: 'hover-plan-card',
      action: 'hover',
      selector: '#card',
    },
  });
  assert.deepEqual(surfaces[4].metadata?.stateRecipe, {
    stateKey: 'press-open-menu-arrowdown',
    action: 'press',
    selector: '#menu',
    key: 'ArrowDown',
  });
  assert.equal(JSON.stringify(surfaces.map((surface) => surface.metadata)).includes('Plan card'), false);
  assert.equal(JSON.stringify(surfaces.map((surface) => surface.metadata)).includes('Open menu'), false);

  // Recipe execution is parent go then apply — no setup choreography.
  const fakePage = {
    locator() {
      return {
        first() {
          return {
            async hover() {
              calls.push('hover');
            },
            async focus() {
              calls.push('focus');
            },
            async click() {
              calls.push('click');
            },
            async evaluate() {
              return 'Plan card';
            },
          };
        },
      };
    },
    keyboard: {
      async press(k) {
        calls.push(`press:${k}`);
      },
    },
    async waitForTimeout() {},
    async evaluate() {
      return 1;
    },
  };
  await surfaces[3].go(fakePage);
  assert.deepEqual(calls, ['surface', 'hover']);
});

test('expandSurfaceVariants: route recipes park the pointer before parent navigation', async () => {
  const calls = [];
  const surfaces = expandSurfaceVariants({
    key: 'plans',
    go: async () => calls.push('navigate'),
    stateRecipes: [{ action: 'route', stateKey: 'network-error', urlPattern: '**/api/plans', status: 503 }],
  });
  const fakePage = {
    async route() {
      calls.push('mock');
    },
    mouse: {
      async move() {
        calls.push('park');
      },
    },
  };

  await surfaces[1].go(fakePage);
  assert.deepEqual(calls, ['mock', 'park', 'navigate']);
});

test('expandSurfaceVariants: transient observation is wired at runtime without persisting its selector', () => {
  const surfaces = expandSurfaceVariants({
    key: 'alerts',
    go: async () => {},
    stateRecipes: [
      {
        action: 'click',
        selector: '#notify',
        stateKey: 'toast-visible',
        observeSelector: '#private-runtime-toast',
        observeMs: 250,
      },
    ],
  });
  const transient = surfaces[1];
  assert.deepEqual(transient.requiredVisibleState, {
    selector: '#private-runtime-toast',
    stateKey: 'toast-visible',
  });
  assert.deepEqual(transient.metadata?.stateRecipe, {
    stateKey: 'toast-visible',
    action: 'click',
    selector: '#notify',
    observationMs: 250,
  });
  assert.equal(JSON.stringify(transient.metadata).includes('#private-runtime-toast'), false);
});

test('expandSurfaceVariants: absent stateRecipes preserves variants/liveStates exactly', () => {
  const withVariants = expandSurfaceVariants({
    key: 'dashboard',
    go: async () => {},
    variants: [{ key: 'menu-open' }],
  });
  assert.deepEqual(
    withVariants.map((s) => ({ key: s.key, kind: s.metadata?.variantKind })),
    [
      { key: 'dashboard', kind: undefined },
      { key: 'dashboard-menu-open', kind: 'variant' },
    ],
  );

  const withLive = expandSurfaceVariants({
    key: 'home',
    go: async () => {},
    liveStates: [{ key: 'loading' }, { key: 'loaded' }],
  });
  assert.deepEqual(
    withLive.map((s) => s.key),
    ['home-loading', 'home-loaded'],
  );
});

test('expandSurfaceVariants: liveStates + stateRecipes drop base and keep both expansions', () => {
  const surfaces = expandSurfaceVariants({
    key: 'home',
    go: async () => {},
    liveStates: [{ key: 'loaded' }],
    stateRecipes: [{ action: 'hover', selector: '#card', label: 'Plan card' }],
  });
  assert.deepEqual(
    surfaces.map((s) => ({ key: s.key, kind: s.metadata?.variantKind })),
    [
      { key: 'home-loaded', kind: 'live-state' },
      { key: 'home-hover-plan-card', kind: 'state-recipe' },
    ],
  );
});

test('expandSurfaceVariants: invalid/unsafe declared recipes fail before browser registration', () => {
  assert.throws(
    () =>
      expandSurfaceVariants({
        key: 'dash',
        go: async () => {},
        stateRecipes: [{ action: 'hover', selector: 'input[value="secret-token-xyz"]' }],
      }),
    (err) => {
      assert.equal(err.name, 'StateRecipeError');
      assert.equal(String(err.message).includes('secret-token-xyz'), false);
      assert.match(err.message, /privacy policy|selector/i);
      return true;
    },
  );

  assert.throws(
    () =>
      expandSurfaceVariants({
        key: 'dash',
        go: async () => {},
        stateRecipes: [{ action: 'click', selector: '#btn', label: 'Delete account' }],
      }),
    (err) => {
      assert.equal(err instanceof StateRecipeError || err.name === 'StateRecipeError', true);
      assert.match(err.message, /refusing unsafe state recipe/i);
      assert.equal(String(err.message).includes('secret'), false);
      return true;
    },
  );
});

test('assertUniqueExpandedKeys: recipe collides with variant/liveState with named origins', () => {
  const expanded = [
    ...expandSurfaceVariants({
      key: 'dash',
      go: async () => {},
      variants: [{ key: 'hover-plan-card' }],
      stateRecipes: [{ action: 'hover', selector: '#card', label: 'Plan card' }],
    }),
  ];
  // base + variant hover-plan-card + recipe hover-plan-card → collision on dash-hover-plan-card
  assert.throws(
    () => assertUniqueExpandedKeys(expanded),
    (err) => {
      assert.match(err.message, /capture key 'dash-hover-plan-card'/);
      assert.match(err.message, /surface 'dash' variant 'hover-plan-card'/);
      assert.match(err.message, /surface 'dash' state-recipe 'hover-plan-card'/);
      // Origins name kind without leaking selectors or declared labels.
      assert.equal(err.message.includes('#card'), false);
      assert.equal(err.message.includes('Plan card'), false);
      return true;
    },
  );
});

test('coverageKeys: state-recipe expansions satisfy declared base key', () => {
  const surfaces = expandSurfaceVariants({
    key: 'pricing',
    go: async () => {},
    stateRecipes: [{ action: 'hover', selector: '#card', label: 'Plan card' }],
  });
  // Base retained, so coverage is satisfied either way.
  assert.deepEqual(
    coverageGaps(
      surfaces.map((s) => s.key),
      ['pricing', 'pricing-hover-plan-card'],
    ).uncovered,
    [],
  );
});

test('expanded variant keys can satisfy the coverage guard', () => {
  const surfaces = expandSurfaceVariants({
    key: 'dashboard',
    go: async () => {},
    variants: [{ key: 'dialog-open' }, { key: 'menu-open' }],
  }).map((s) => s.key);

  assert.deepEqual(coverageGaps(surfaces, ['dashboard-dialog-open', 'dashboard-menu-open']).uncovered, []);
  assert.deepEqual(coverageGaps(surfaces, ['dashboard-dialog-open', 'dashboard-tooltip-open']).uncovered, [
    'dashboard-tooltip-open',
  ]);
});

test('defineStyleMapCapture: unset dir registers no inert capture tests', () => {
  const out = listPlaywrightTests(`
    import { defineStyleMapCapture } from ${JSON.stringify(DIST_INDEX_URL)};
    defineStyleMapCapture({
      surfaces: [
        { key: 'home', widths: [375, 1024], go: async () => {} },
        { key: 'pricing', go: async () => {} },
      ],
      dir: undefined,
    });
  `);

  assert.match(out, /Total: 0 tests/);
  assert.doesNotMatch(out, /styleproof capture/);
  assert.doesNotMatch(out, /set STYLEMAP_DIR/);
});

test('defineStyleMapCapture: unset dir still keeps the static coverage guard', () => {
  const out = listPlaywrightTests(`
    import { defineStyleMapCapture } from ${JSON.stringify(DIST_INDEX_URL)};
    defineStyleMapCapture({
      surfaces: [{ key: 'home', widths: [1024], go: async () => {} }],
      expected: ['home'],
      dir: undefined,
    });
  `);

  assert.match(out, /styleproof coverage/);
  assert.match(out, /every expected surface is captured or explicitly excluded/);
  assert.match(out, /Total: 1 test/);
  assert.doesNotMatch(out, /styleproof capture/);
});

test('selfCheckErrorMessage: explains volatile root layout drift as a variant problem', () => {
  const message = selfCheckErrorMessage(
    'dashboard-live',
    [
      {
        kind: 'style',
        path: 'html',
        cls: '',
        pseudo: null,
        props: [{ prop: 'block-size', before: '800px', after: '1268px' }],
      },
    ],
    ['body > main:nth-child(1) > div:nth-child(1)'],
    [
      {
        path: 'body > main:nth-child(1) > div:nth-child(1)',
        tag: 'div',
        cls: 'status',
        reason: 'role=status',
        role: 'status',
      },
    ],
  );

  assert.match(message, /Volatile regions were detected/);
  assert.match(message, /`liveStates`/);
  assert.match(message, /Auto-detected live-state candidate/);
  assert.match(message, /div.status \(role=status\)/);
  assert.match(message, /First: html block-size: 800px → 1268px/);
});

// An absolute STYLEMAP_DIR must be respected as-is — burying it under baseDir
// (.styleproof/maps/private/tmp/…) strands the maps where no consumer looks.
test('resolveOutputDir: absolute dir is respected, relative nests under baseDir', () => {
  assert.equal(resolveOutputDir('.styleproof/maps', '/abs/target'), '/abs/target');
  assert.equal(resolveOutputDir('.styleproof/maps', 'current'), path.join('.styleproof/maps', 'current'));
});
