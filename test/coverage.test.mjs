import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageGaps, coverageKeys, translateExpected, auditCoverage } from '../dist/coverage.js';
import { expandSurfaceVariants } from '../dist/runner.js';

// ------------------------------------------------------- the happy path

test('coverageGaps: nothing missing when every expected key is captured', () => {
  const { uncovered, staleExclusions } = coverageGaps(['home', 'about'], ['home', 'about']);
  assert.deepEqual(uncovered, []);
  assert.deepEqual(staleExclusions, []);
});

// ------------------------------------------------------- the bug this exists to catch

test('coverageGaps: an expected route with no surface is flagged uncovered', () => {
  // The whole point: `pricing` is in the app's universe but nobody added a surface.
  const { uncovered } = coverageGaps(['home', 'about'], ['home', 'about', 'pricing']);
  assert.deepEqual(uncovered, ['pricing']);
});

test('coverageGaps: an explicitly excluded route is NOT flagged', () => {
  const { uncovered } = coverageGaps(['home'], ['home', 'pricing'], {
    pricing: 'not yet tuned',
  });
  assert.deepEqual(uncovered, []);
});

// ------------------------------------------------------- reverse drift (stale ledger)

test('coverageGaps: an exclude entry absent from expected is a stale exclusion', () => {
  // `signup` was renamed to `register`; its opt-out went stale.
  const { staleExclusions } = coverageGaps(['register'], ['register'], {
    signup: 'renamed to register',
  });
  assert.deepEqual(staleExclusions, ['signup']);
});

// ------------------------------------------------------- extra captured states are allowed

test('coverageGaps: a captured surface not in expected is allowed (multi-state route)', () => {
  // Teams can require only the route at first; extra captured states remain fine.
  const { uncovered, staleExclusions } = coverageGaps(['home', 'home-nav-open'], ['home']);
  assert.deepEqual(uncovered, []);
  assert.deepEqual(staleExclusions, []);
});

test('coverageGaps: expected state keys are enforceable', () => {
  const { uncovered } = coverageGaps(['home', 'home-dialog-open'], ['home', 'home-dialog-open', 'home-menu-open']);
  assert.deepEqual(uncovered, ['home-menu-open']);
});

// ------------------------------------------------------- mixed: some covered, some not

test('coverageGaps: reports only the genuinely uncovered, preserving expected order', () => {
  const { uncovered } = coverageGaps(['a', 'c'], ['a', 'b', 'c', 'd'], { d: 'excluded on purpose' });
  assert.deepEqual(uncovered, ['b']);
});

// ------------------------------------------------------- liveStates coverage (bug: base key dropped)
//
// A surface with `liveStates` is captured ONLY as its split expansions
// (`home-loading`, `home-loaded`) — `expandSurfaceVariants` drops the bare `home`.
// `expected` is still stated in base keys, so a naive literal comparison flags the
// fully-captured `home` as uncovered. `coverageKeys` (suite side) and
// `translateExpected` (gate side) close that split. These tests drive the real
// `expandSurfaceVariants` so the fixtures can't drift from the expansion rule.

const homeLive = expandSurfaceVariants({
  key: 'home',
  go: async () => {},
  liveStates: [
    { key: 'loading', go: async () => {} },
    { key: 'loaded', go: async () => {} },
  ],
});

test('expandSurfaceVariants: a liveStates surface drops the bare base key', () => {
  // Guards the premise: if this ever stops dropping `home`, the translation below is moot.
  assert.deepEqual(
    homeLive.map((s) => s.key),
    ['home-loading', 'home-loaded'],
  );
  assert.equal(
    homeLive.every((s) => s.metadata?.surfaceKey === 'home'),
    true,
  );
});

// -- suite guard (coverageKeys): captured expansions satisfy the declared base key --

test('coverageKeys: a liveStates split satisfies its declared base key (suite guard)', () => {
  // Without the fix this reported uncovered:['home'] on a fully-captured app.
  const { uncovered } = coverageGaps(coverageKeys(homeLive), ['home']);
  assert.deepEqual(uncovered, []);
});

test('coverageKeys: an unrelated lookalike suffix does NOT satisfy an uncaptured base', () => {
  // `home-banner` is a plain surface (its own surfaceKey), not a `home` expansion,
  // so it must not paper over a genuinely missing `home`. This is the precision
  // guarantee: translation follows real metadata, not a `startsWith` heuristic.
  const banner = expandSurfaceVariants({ key: 'home-banner', go: async () => {} });
  const { uncovered } = coverageGaps(coverageKeys(banner), ['home']);
  assert.deepEqual(uncovered, ['home']);
});

// -- gate (translateExpected): the ledger travels pre-translated to the captured keys --

test('translateExpected: rewrites a base key to its captured liveState splits (gate, complete)', () => {
  const ledgerExpected = translateExpected(['home'], homeLive);
  assert.deepEqual(new Set(ledgerExpected), new Set(['home-loading', 'home-loaded']));
  // The gate reads expanded map filenames and compares literally against the ledger.
  const verdict = auditCoverage(['home-loading', 'home-loaded'], {
    version: 1,
    expected: ledgerExpected,
    exclude: {},
  });
  assert.equal(verdict.basis, 'complete');
  assert.deepEqual(verdict.uncovered, []);
});

test('translateExpected: a missing split still fails the gate (incomplete)', () => {
  const ledgerExpected = translateExpected(['home'], homeLive);
  const verdict = auditCoverage(['home-loading'], { version: 1, expected: ledgerExpected, exclude: {} });
  assert.equal(verdict.basis, 'incomplete');
  assert.deepEqual(verdict.uncovered, ['home-loaded']);
});

test('translateExpected: an uncaptured base key is kept verbatim so the gate flags it', () => {
  // `pricing` has no capture at all (no expansions), so it must survive translation
  // unchanged and be reported by the gate.
  const ledgerExpected = translateExpected(['home', 'pricing'], homeLive);
  assert.deepEqual(new Set(ledgerExpected), new Set(['home-loading', 'home-loaded', 'pricing']));
  const verdict = auditCoverage(['home-loading', 'home-loaded'], {
    version: 1,
    expected: ledgerExpected,
    exclude: {},
  });
  assert.equal(verdict.basis, 'incomplete');
  assert.deepEqual(verdict.uncovered, ['pricing']);
});

test('translateExpected: a plain (non-live) surface passes through unchanged', () => {
  // No liveStates → `expandSurfaceVariants` keeps the base key, so translation is identity.
  const about = expandSurfaceVariants({ key: 'about', go: async () => {} });
  assert.deepEqual(translateExpected(['about'], about), ['about']);
});

test('translateExpected / coverageKeys: stateRecipes expansions map back to base', () => {
  const recipeSurfaces = expandSurfaceVariants({
    key: 'pricing',
    go: async () => {},
    stateRecipes: [
      { action: 'hover', selector: '#card', label: 'Plan card' },
      { action: 'focus', selector: '#email', label: 'Email' },
    ],
  });
  // Base retained for recipes, so declared base stays captured directly.
  assert.ok(recipeSurfaces.some((s) => s.key === 'pricing'));
  const { uncovered } = coverageGaps(coverageKeys(recipeSurfaces), ['pricing']);
  assert.deepEqual(uncovered, []);
  // Explicit expanded keys also satisfy.
  assert.deepEqual(
    coverageGaps(coverageKeys(recipeSurfaces), ['pricing-hover-plan-card', 'pricing-focus-email']).uncovered,
    [],
  );
});

// --- Tests for #599: coverage manifest loading ---

import fs from 'node:fs';
import path from 'node:path';
import { loadCoverageManifest, mergeCoverageConfig } from '../dist/coverage.js';
import { mkTmp, rmTmp } from './helpers.mjs';

test('loadCoverageManifest: loads valid version 1 manifest', () => {
  const dir = mkTmp('styleproof-manifest-');
  try {
    const manifestPath = path.join(dir, 'surfaces.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, surfaces: ['home', 'dashboard', 'settings'] }));
    const surfaces = loadCoverageManifest(manifestPath);
    assert.deepEqual(surfaces, ['home', 'dashboard', 'settings']);
  } finally {
    rmTmp(dir);
  }
});

test('loadCoverageManifest: fails LOUD on missing manifest file', () => {
  assert.throws(() => loadCoverageManifest('/nonexistent/path/manifest.json'), /cannot read coverage manifest/i);
});

test('loadCoverageManifest: fails LOUD on invalid JSON', () => {
  const dir = mkTmp('styleproof-manifest-');
  try {
    const manifestPath = path.join(dir, 'bad.json');
    fs.writeFileSync(manifestPath, '{ not json');
    assert.throws(() => loadCoverageManifest(manifestPath), /invalid JSON/i);
  } finally {
    rmTmp(dir);
  }
});

test('loadCoverageManifest: fails LOUD on wrong version', () => {
  const dir = mkTmp('styleproof-manifest-');
  try {
    const manifestPath = path.join(dir, 'v2.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ version: 2, surfaces: ['home'] }));
    assert.throws(() => loadCoverageManifest(manifestPath), /unsupported manifest version/i);
  } finally {
    rmTmp(dir);
  }
});

test('loadCoverageManifest: fails LOUD on missing version field', () => {
  const dir = mkTmp('styleproof-manifest-');
  try {
    const manifestPath = path.join(dir, 'noversion.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ surfaces: ['home'] }));
    assert.throws(() => loadCoverageManifest(manifestPath), /missing.*version/i);
  } finally {
    rmTmp(dir);
  }
});

test('loadCoverageManifest: fails LOUD on non-array surfaces', () => {
  const dir = mkTmp('styleproof-manifest-');
  try {
    const manifestPath = path.join(dir, 'badsurf.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, surfaces: 'home' }));
    assert.throws(() => loadCoverageManifest(manifestPath), /surfaces.*array/i);
  } finally {
    rmTmp(dir);
  }
});

test('loadCoverageManifest: fails LOUD on non-string surface entries', () => {
  const dir = mkTmp('styleproof-manifest-');
  try {
    const manifestPath = path.join(dir, 'badentry.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, surfaces: ['home', 42] }));
    assert.throws(() => loadCoverageManifest(manifestPath), /surface entries must be strings/i);
  } finally {
    rmTmp(dir);
  }
});

test('mergeCoverageConfig: manifest-only config sets expected from manifest', () => {
  const dir = mkTmp('styleproof-manifest-');
  try {
    const manifestPath = path.join(dir, 'surfaces.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, surfaces: ['home', 'about'] }));
    const result = mergeCoverageConfig({ manifest: manifestPath }, undefined, {}, dir);
    assert.deepEqual(result.expected, ['home', 'about']);
    assert.deepEqual(result.exclude, {});
  } finally {
    rmTmp(dir);
  }
});

test('mergeCoverageConfig: programmatic expected merges with manifest (union)', () => {
  const dir = mkTmp('styleproof-manifest-');
  try {
    const manifestPath = path.join(dir, 'surfaces.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, surfaces: ['home', 'about'] }));
    const result = mergeCoverageConfig({ manifest: manifestPath }, ['home', 'dashboard'], {}, dir);
    // Union: manifest + programmatic, deduped
    assert.deepEqual(new Set(result.expected), new Set(['home', 'about', 'dashboard']));
  } finally {
    rmTmp(dir);
  }
});

test('mergeCoverageConfig: config exclude merges with programmatic exclude (config wins)', () => {
  const dir = mkTmp('styleproof-manifest-');
  try {
    const manifestPath = path.join(dir, 'surfaces.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, surfaces: ['home'] }));
    const result = mergeCoverageConfig(
      { manifest: manifestPath, exclude: { admin: 'config reason' } },
      undefined,
      { admin: 'programmatic reason', other: 'other reason' },
      dir,
    );
    // Config exclude wins over programmatic for same key
    assert.equal(result.exclude.admin, 'config reason');
    assert.equal(result.exclude.other, 'other reason');
  } finally {
    rmTmp(dir);
  }
});

test('mergeCoverageConfig: strict mode passes through', () => {
  const dir = mkTmp('styleproof-manifest-');
  try {
    const manifestPath = path.join(dir, 'surfaces.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, surfaces: ['home'] }));
    const result = mergeCoverageConfig({ manifest: manifestPath, strict: true }, undefined, {}, dir);
    assert.equal(result.strict, true);
  } finally {
    rmTmp(dir);
  }
});

test('mergeCoverageConfig: no config returns programmatic values unchanged', () => {
  const result = mergeCoverageConfig(undefined, ['home', 'about'], { admin: 'reason' }, '/tmp');
  assert.deepEqual(result.expected, ['home', 'about']);
  assert.deepEqual(result.exclude, { admin: 'reason' });
  assert.equal(result.strict, false);
});

test('auditCoverage: strict mode with uncovered surfaces is incomplete', () => {
  const ledger = { version: 1, expected: ['home', 'about'], exclude: {} };
  const verdict = auditCoverage(['home'], ledger);
  assert.equal(verdict.basis, 'incomplete');
  assert.deepEqual(verdict.uncovered, ['about']);
});
