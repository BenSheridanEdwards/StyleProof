/**
 * Headline copy: lead with distinct/reviewable count, not property tally (#770).
 * FLEET #67-shaped: many computed-style diffs under one change group must not
 * bold-lead with "14 … across 1 distinct".
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { reportHeadline } from '../dist/report/headline.js';

function baseInput(overrides = {}) {
  return {
    changeGroups: [],
    missing: [],
    shown: { dom: 0, style: 0, state: 0 },
    changedScope: { bases: 0, variants: 0 },
    volatileCount: 0,
    liveCandidateLabels: [],
    contentCount: 0,
    contentEvaluated: true,
    reportConsistency: { ok: true, reason: 'aligned' },
    baseline: { surfaceFailures: [], failures: [], undeclaredOnBase: [] },
    confidenceBlocked: false,
    comparisonBlocked: false,
    ...overrides,
  };
}

/** Minimal ChangeGroup stub — headline only reads `.length` of the array. */
function stubGroup() {
  return { surfaces: ['home@900'], rep: { sd: {}, findings: [] }, findings: [] };
}

test('#770: multi-diff headline leads with distinct count, not property tally', () => {
  const lines = reportHeadline(
    baseInput({
      changeGroups: [stubGroup()],
      shown: { dom: 0, style: 14, state: 0 },
      changedScope: { bases: 1, variants: 1 },
    }),
  );
  const joined = lines.join('\n');

  // Verdict still names the one reviewable style group.
  assert.match(joined, /\*\*1 change needs review\*\*/);

  // Lead number is the distinct/reviewable count — not the 14 property tally.
  assert.match(
    joined,
    /\*\*1 distinct change\*\* \(14 computed-style difference\(s\)\) in 1 changed surface base with an existing baseline\./,
  );
  // Old Opening-inflating order must not return.
  assert.doesNotMatch(joined, /\*\*14 computed-style difference\(s\)\*\* across 1 distinct/);
});

test('#770: mixed DOM/style/state still lead with distinct count', () => {
  const lines = reportHeadline(
    baseInput({
      changeGroups: [stubGroup(), stubGroup()],
      shown: { dom: 3, style: 5, state: 2 },
      changedScope: { bases: 2, variants: 2 },
    }),
  );
  const joined = lines.join('\n');
  assert.match(joined, /\*\*2 changes need review\*\*/);
  assert.match(
    joined,
    /\*\*2 distinct changes\*\* \(3 DOM change\(s\) · 5 computed-style difference\(s\) · 2 state-delta difference\(s\)\) in 2 changed surface bases with an existing baseline\./,
  );
  assert.doesNotMatch(joined, /\*\*3 DOM change\(s\)/);
});

test('#770: new surface + one style group keeps verdict as reviewable sum', () => {
  const lines = reportHeadline(
    baseInput({
      changeGroups: [stubGroup()],
      missing: [{ sd: { surface: 'pricing@900', missing: 'before' }, findings: [] }],
      shown: { dom: 0, style: 14, state: 0 },
      changedScope: { bases: 1, variants: 1 },
    }),
  );
  const joined = lines.join('\n');
  // 1 new + 1 style group = 2 reviewable (matches FLEET #67 verdict).
  assert.match(joined, /\*\*2 changes need review\*\*/);
  assert.match(joined, /🆕 \*\*1 new surface\(s\)\*\*/);
  assert.match(joined, /\*\*1 distinct change\*\* \(14 computed-style difference\(s\)\)/);
});
