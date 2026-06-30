import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageGaps } from '../dist/coverage.js';

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
