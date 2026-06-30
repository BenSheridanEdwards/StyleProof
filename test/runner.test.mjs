import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultSelfCheck,
  expandSurfaceVariants,
  resolveBaseDir,
  resolvePopupCaptureOptions,
  resolveScreenshots,
  selfCheckErrorMessage,
} from '../dist/runner.js';
import { coverageGaps } from '../dist/coverage.js';

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
