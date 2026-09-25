import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  copyReuseSurfaceArtifacts,
  decideSelectiveRemap,
  formatSelectiveRemapPlan,
  resolveSelectiveRemapOptIn,
  selectiveCaptureEnv,
  surfaceKeyFromArtifactName,
  surfaceMatchesOnlySet,
  tryComputeAffectedVerdict,
} from '../dist/selective-remap.js';
import { mkTmp, rmTmp } from './helpers.mjs';

const ALL = ['dashboard', 'home', 'pricing'];

// ── resolveSelectiveRemapOptIn ───────────────────────────────────────────────

test('resolveSelectiveRemapOptIn: default is OFF (fail-closed full remap)', () => {
  assert.equal(resolveSelectiveRemapOptIn({}, undefined), false);
  assert.equal(resolveSelectiveRemapOptIn({}, {}), false);
  assert.equal(resolveSelectiveRemapOptIn({}, { selectiveRemap: false }), false);
});

test('resolveSelectiveRemapOptIn: STYLEPROOF_SELECTIVE_REMAP=1 opts in', () => {
  assert.equal(resolveSelectiveRemapOptIn({ STYLEPROOF_SELECTIVE_REMAP: '1' }, undefined), true);
  assert.equal(resolveSelectiveRemapOptIn({ STYLEPROOF_SELECTIVE_REMAP: 'true' }, undefined), true);
});

test('resolveSelectiveRemapOptIn: STYLEPROOF_SELECTIVE_REMAP=0 forces OFF even when config opts in', () => {
  assert.equal(resolveSelectiveRemapOptIn({ STYLEPROOF_SELECTIVE_REMAP: '0' }, { selectiveRemap: true }), false);
  assert.equal(resolveSelectiveRemapOptIn({ STYLEPROOF_SELECTIVE_REMAP: 'false' }, { selectiveRemap: true }), false);
});

test('resolveSelectiveRemapOptIn: config affected.selectiveRemap opts in when env unset', () => {
  assert.equal(resolveSelectiveRemapOptIn({}, { selectiveRemap: true }), true);
});

// ── decideSelectiveRemap ─────────────────────────────────────────────────────

test('decideSelectiveRemap: opt-in OFF → full remap (default path unchanged)', () => {
  const plan = decideSelectiveRemap({
    optIn: false,
    basePresent: true,
    allSurfaces: ALL,
    verdict: new Set(['dashboard']),
  });
  assert.equal(plan.mode, 'full');
  assert.equal(plan.optIn, false);
  assert.deepEqual(plan.recapture, [...ALL].sort());
  assert.deepEqual(plan.reuse, []);
  assert.match(plan.reason, /opt-in off/i);
});

test('decideSelectiveRemap: opt-in + scoped + base present → selective', () => {
  const plan = decideSelectiveRemap({
    optIn: true,
    basePresent: true,
    allSurfaces: ALL,
    verdict: new Set(['dashboard']),
    baseSurfaceKeys: new Set(ALL),
  });
  assert.equal(plan.mode, 'selective');
  assert.equal(plan.optIn, true);
  assert.deepEqual(plan.recapture, ['dashboard']);
  assert.deepEqual(plan.reuse, ['home', 'pricing']);
  assert.equal(plan.reason, '');
});

test('decideSelectiveRemap: opt-in + missing base → full remap (never silent under-capture)', () => {
  const plan = decideSelectiveRemap({
    optIn: true,
    basePresent: false,
    allSurfaces: ALL,
    verdict: new Set(['dashboard']),
  });
  assert.equal(plan.mode, 'full');
  assert.match(plan.reason, /base/i);
});

test('decideSelectiveRemap: opt-in + unbounded verdict → full remap with reason', () => {
  const plan = decideSelectiveRemap({
    optIn: true,
    basePresent: true,
    allSurfaces: ALL,
    verdict: 'all',
    verdictReason: 'src/tokens.css could not be proven local',
    baseSurfaceKeys: new Set(ALL),
  });
  assert.equal(plan.mode, 'full');
  assert.match(plan.reason, /tokens\.css|unbounded|all/i);
});

test('decideSelectiveRemap: opt-in + null verdict (missing graph/surfaces) → full remap', () => {
  const plan = decideSelectiveRemap({
    optIn: true,
    basePresent: true,
    allSurfaces: ALL,
    verdict: null,
    verdictReason: 'affected.graph missing or unreadable',
  });
  assert.equal(plan.mode, 'full');
  assert.match(plan.reason, /graph|unreadable|unavailable|missing/i);
});

test('decideSelectiveRemap: opt-in + empty surfaces map → full remap', () => {
  const plan = decideSelectiveRemap({
    optIn: true,
    basePresent: true,
    allSurfaces: [],
    verdict: new Set(),
  });
  assert.equal(plan.mode, 'full');
  assert.match(plan.reason, /surface/i);
});

test('decideSelectiveRemap: opt-in + scoped but base missing a reuse map → full remap', () => {
  const plan = decideSelectiveRemap({
    optIn: true,
    basePresent: true,
    allSurfaces: ALL,
    verdict: new Set(['dashboard']),
    // base has dashboard (recapture) but not home — cannot reuse home safely
    baseSurfaceKeys: new Set(['dashboard', 'pricing']),
  });
  assert.equal(plan.mode, 'full');
  assert.match(plan.reason, /base|reuse|home/i);
});

test('decideSelectiveRemap: empty scoped verdict (nothing affected) reuses all from base', () => {
  const plan = decideSelectiveRemap({
    optIn: true,
    basePresent: true,
    allSurfaces: ALL,
    verdict: new Set(),
    baseSurfaceKeys: new Set(ALL),
  });
  assert.equal(plan.mode, 'selective');
  assert.deepEqual(plan.recapture, []);
  assert.deepEqual(plan.reuse, [...ALL].sort());
});

// ── formatSelectiveRemapPlan ─────────────────────────────────────────────────

test('formatSelectiveRemapPlan: OFF logs selective OFF, counts, and reason', () => {
  const lines = formatSelectiveRemapPlan({
    mode: 'full',
    optIn: false,
    recapture: ALL,
    reuse: [],
    reason: 'opt-in off',
  });
  assert.match(lines, /selective remap: OFF/i);
  assert.match(lines, /re-capture all 3/);
  assert.match(lines, /opt-in off/i);
});

test('formatSelectiveRemapPlan: ON logs recapture and reuse counts', () => {
  const lines = formatSelectiveRemapPlan({
    mode: 'selective',
    optIn: true,
    recapture: ['dashboard'],
    reuse: ['home', 'pricing'],
    reason: '',
  });
  assert.match(lines, /selective remap: ON/i);
  assert.match(lines, /re-capture 1/);
  assert.match(lines, /reuse 2/);
});

test('formatSelectiveRemapPlan: fail-closed full with opt-in ON still says OFF and names reason', () => {
  const lines = formatSelectiveRemapPlan({
    mode: 'full',
    optIn: true,
    recapture: ALL,
    reuse: [],
    reason: 'unbounded affected verdict — src/tokens.css',
  });
  assert.match(lines, /selective remap: OFF/i);
  assert.match(lines, /tokens\.css|unbounded/i);
});

// ── surface key helpers ──────────────────────────────────────────────────────

test('surfaceKeyFromArtifactName: strips @width and extensions', () => {
  assert.equal(surfaceKeyFromArtifactName('home@1280.json.gz'), 'home');
  assert.equal(surfaceKeyFromArtifactName('dashboard-loading@768.png'), 'dashboard-loading');
  assert.equal(surfaceKeyFromArtifactName('pricing@1024.hover.png'), 'pricing');
});

test('surfaceMatchesOnlySet: exact key and variant prefix match', () => {
  const only = new Set(['dashboard', 'home']);
  assert.equal(surfaceMatchesOnlySet('dashboard', only), true);
  assert.equal(surfaceMatchesOnlySet('dashboard-loading', only), true);
  assert.equal(surfaceMatchesOnlySet('home', only), true);
  assert.equal(surfaceMatchesOnlySet('pricing', only), false);
  assert.equal(surfaceMatchesOnlySet('hom', only), false);
});

// ── copyReuseSurfaceArtifacts ────────────────────────────────────────────────

test('copyReuseSurfaceArtifacts: copies reuse maps and skips recapture keys', () => {
  const root = mkTmp();
  try {
    const base = path.join(root, 'base');
    const head = path.join(root, 'head');
    fs.mkdirSync(base);
    fs.mkdirSync(head);
    fs.writeFileSync(path.join(base, 'home@1280.json.gz'), 'home-bytes');
    fs.writeFileSync(path.join(base, 'pricing@1280.json.gz'), 'pricing-bytes');
    fs.writeFileSync(path.join(base, 'dashboard@1280.json.gz'), 'dashboard-bytes');
    fs.writeFileSync(path.join(base, 'home@1280.png'), 'home-png');
    fs.writeFileSync(path.join(base, 'manifest.json'), 'not-a-map'); // reserved-ish name without @

    const result = copyReuseSurfaceArtifacts({
      fromDir: base,
      toDir: head,
      reuseKeys: ['home', 'pricing'],
    });
    assert.equal(result.copied, 3); // home json + png + pricing json
    assert.equal(fs.readFileSync(path.join(head, 'home@1280.json.gz'), 'utf8'), 'home-bytes');
    assert.equal(fs.readFileSync(path.join(head, 'pricing@1280.json.gz'), 'utf8'), 'pricing-bytes');
    assert.equal(fs.existsSync(path.join(head, 'dashboard@1280.json.gz')), false);
    assert.equal(fs.existsSync(path.join(head, 'manifest.json')), false);
  } finally {
    rmTmp(root);
  }
});

test('selectiveCaptureEnv: full mode yields no capture env overrides', () => {
  assert.deepEqual(
    selectiveCaptureEnv({ mode: 'full', optIn: false, recapture: ALL, reuse: [], reason: 'opt-in off' }, '/tmp/base'),
    {},
  );
});

test('selectiveCaptureEnv: selective mode sets ONLY_SURFACES and REUSE_FROM', () => {
  assert.deepEqual(
    selectiveCaptureEnv(
      { mode: 'selective', optIn: true, recapture: ['dashboard'], reuse: ['home', 'pricing'], reason: '' },
      '/maps/base',
    ),
    { STYLEPROOF_ONLY_SURFACES: 'dashboard', STYLEPROOF_REUSE_FROM: '/maps/base' },
  );
});

test('selectiveCaptureEnv: empty recapture still sets ONLY_SURFACES to empty string', () => {
  assert.deepEqual(
    selectiveCaptureEnv({ mode: 'selective', optIn: true, recapture: [], reuse: ALL, reason: '' }, '/maps/base'),
    { STYLEPROOF_ONLY_SURFACES: '', STYLEPROOF_REUSE_FROM: '/maps/base' },
  );
});

test('tryComputeAffectedVerdict: missing surfaces/graph fails closed with null verdict', () => {
  const root = mkTmp();
  try {
    const missingSurfaces = tryComputeAffectedVerdict({
      root,
      baseSha: 'a',
      headSha: 'b',
      affected: { graph: 'dc.json' },
      configDir: root,
    });
    assert.equal(missingSurfaces.verdict, null);
    assert.match(missingSurfaces.reason, /surfaces/i);

    const missingGraph = tryComputeAffectedVerdict({
      root,
      baseSha: 'a',
      headSha: 'b',
      affected: { surfaces: { home: 'src/Home.tsx' } },
      configDir: root,
    });
    assert.equal(missingGraph.verdict, null);
    assert.match(missingGraph.reason, /graph/i);
  } finally {
    rmTmp(root);
  }
});
