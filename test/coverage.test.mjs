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
