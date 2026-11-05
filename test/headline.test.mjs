/**
 * Headline copy: lead with distinct/reviewable count, not property tally (#770).
 * Multi-property restyle under one change group must not bold-lead with
 * "14 … across 1 distinct".
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { reportHeadline } from '../dist/report/headline.js';

function baseInput(overrides = {}) {
  return {
    changeGroups: [],
    distinctChangeCount: (overrides.changeGroups?.length ?? 0) + (overrides.missing?.length ?? 0),
    missing: [],
    shown: { dom: 0, style: 0, state: 0 },
    changedScope: { bases: 0, variants: 0 },
    whatChanged: [],
    volatileCount: 0,
    liveCandidateLabels: [],
    contentCount: 0,
    elevatedStructureDom: 0,
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
    /^\*\*1 change needs review\*\* · 1 distinct change on 1 surface \(14 computed-style differences\)$/m,
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
    /^\*\*2 changes need review\*\* · 2 distinct changes on 2 surfaces \(3 DOM changes · 5 computed-style differences · 2 state-delta differences\)$/m,
  );
  assert.doesNotMatch(joined, /\*\*3 DOM change\(s\)/);
});

test('#770: new surface + one style group keeps verdict as reviewable sum', () => {
  const lines = reportHeadline(
    baseInput({
      changeGroups: [stubGroup()],
      missing: [{ sd: { surface: 'pricing@900', missing: 'before' }, findings: [] }],
      shown: { dom: 0, style: 14, state: 0 },
      changedScope: { bases: 2, variants: 2 },
    }),
  );
  const joined = lines.join('\n');
  // 1 new + 1 style group = 2 reviewable (matches dogfood verdict shape).
  assert.match(joined, /\*\*2 changes need review\*\*/);
  assert.match(joined, /🆕 \*\*1 new surface\(s\)\*\*/);
  assert.match(
    joined,
    /^\*\*2 changes need review\*\* · 2 distinct changes on 2 surfaces \(14 computed-style differences\)$/m,
  );
});

test('elevated structure headline counts visible and navigable-chrome elevations together', () => {
  const md = reportHeadline(
    baseInput({ elevatedVisibleStructure: 1, elevatedNavigableChromeAdds: 1, elevatedStructureDom: 2 }),
  ).join('\n');
  assert.match(md, /\*\*2 visible element additions\/removals need review\*\*/);
  assert.match(md, /🧱 \*\*2 visible element addition\(s\)\/removal\(s\)\*\* need review/, 'the note agrees');
});

for (const [name, overrides, expected] of [
  [
    'new surface without a baseline',
    { missing: [{ sd: { surface: 'new@900', missing: 'before' } }] },
    /^\*\*1 change needs review\*\*$/,
  ],
  [
    'removed surface',
    { missing: [{ sd: { surface: 'old@900', missing: 'after' } }] },
    /^\*\*1 change needs review\*\*$/,
  ],
  ['zero diff', {}, /^✓ No reviewable computed-style changes/],
  ['content not evaluated', { contentEvaluated: false }, /Content\/structure was not evaluated/],
  ['advisory content', { contentCount: 2 }, /2 advisory content\/structure change/],
  ['blocked scope', { confidenceBlocked: true }, /^Computed-style scope only:/],
  ['head volatility', { headOnlyVolatile: [{ surface: 'home@900', path: 'body' }] }, /^✗ Not certified/],
  ['base volatility', { baseOnlyVolatile: [{ surface: 'home@900', path: 'body' }] }, /^⚠ Review required/],
  ['reach-only failure', { reachBlocking: 1 }, /^✗ \*\*Reach gate\*\*/],
  ['live freeze failure', { liveTextFreezeViolated: true }, /^✗ Live\/age freeze violated/],
]) {
  test(`one-line headline remains truthful for ${name}`, () => {
    const lines = reportHeadline(baseInput(overrides));
    assert.match(lines[0], expected);
    assert.doesNotMatch(lines[0], /\n/);
    assert.equal(lines.filter((line) => line.includes('distinct change')).length, 0);
  });
}

test('partial baseline keeps the combined count above the named repair receipt', () => {
  const receipt = { key: 'checkout@900', reason: 'capture-failed', sha: 'a'.repeat(40) };
  const lines = reportHeadline(
    baseInput({
      changeGroups: [stubGroup()],
      missing: [{ sd: { surface: 'checkout@900', missing: 'before' } }],
      shown: { dom: 0, style: 1, state: 0 },
      changedScope: { bases: 2, variants: 3 },
      baseline: {
        surfaceFailures: [{ key: 'checkout@900', surface: 'checkout@900' }],
        failures: [receipt],
        undeclaredOnBase: [],
      },
    }),
  );
  assert.equal(
    lines[0],
    '**2 changes need review** · 2 distinct changes on 2 surfaces (3 variants, 1 computed-style difference)',
  );
  assert.match(lines.join('\n'), /baseline capture failure/);
  assert.match(lines.join('\n'), /checkout/);
});

test('the headline counts uncapped sentences rather than signature groups', () => {
  const [headline] = reportHeadline(
    baseInput({
      changeGroups: [stubGroup()],
      distinctChangeCount: 12,
      shown: { dom: 0, style: 12, state: 0 },
      changedScope: { bases: 1, variants: 2 },
    }),
  );
  assert.equal(
    headline,
    '**12 changes need review** · 12 distinct changes on 1 surface (2 variants, 12 computed-style differences)',
  );
});
