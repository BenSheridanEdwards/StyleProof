/**
 * Headline copy: lead with the number of changes to review (one per change section),
 * never a property tally (#770), followed by the scope.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { reportHeadline } from '../dist/report/headline.js';

function baseInput(overrides = {}) {
  return {
    changeGroups: [],
    missing: [],
    sectionCount: 0,
    scope: '',
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

test('#770: the headline leads with the change count and scope, never a property tally', () => {
  const lines = reportHeadline(
    baseInput({
      changeGroups: [stubGroup()],
      sectionCount: 3,
      scope: ' on `index` at 1280px wide: 9 elements, 4 changed CSS rules.',
    }),
  );
  const joined = lines.join('\n');
  assert.equal(lines[0], '**3 changes to review** on `index` at 1280px wide: 9 elements, 4 changed CSS rules.');
  assert.doesNotMatch(joined, /computed-style difference|distinct change|What changed/);
});

test('#770: one change reads singular', () => {
  const lines = reportHeadline(
    baseInput({ changeGroups: [stubGroup()], sectionCount: 1, scope: ' on `home` at 900px wide: 1 element.' }),
  );
  assert.equal(lines[0], '**1 change to review** on `home` at 900px wide: 1 element.');
});

test('#770: new surface + one style change keeps the verdict as the reviewable sum', () => {
  const lines = reportHeadline(
    baseInput({
      changeGroups: [stubGroup()],
      missing: [{ sd: { surface: 'pricing@900', missing: 'before' }, findings: [] }],
      sectionCount: 1,
      scope: ' on `home` at 900px wide: 1 element.',
    }),
  );
  const joined = lines.join('\n');
  // 1 new + 1 style change = 2 reviewable (matches dogfood verdict shape).
  assert.match(joined, /^\*\*2 changes to review\*\* on `home` at 900px wide: 1 element\.$/m);
  assert.match(joined, /🆕 \*\*1 new surface\(s\)\*\*/);
});

test('elevated structure headline counts visible and navigable-chrome elevations together', () => {
  const md = reportHeadline(
    baseInput({ elevatedVisibleStructure: 1, elevatedNavigableChromeAdds: 1, elevatedStructureDom: 2 }),
  ).join('\n');
  assert.match(md, /\*\*2 visible element additions\/removals need review\*\*/);
  assert.match(md, /🧱 \*\*2 visible element addition\(s\)\/removal\(s\)\*\* need review/, 'the note agrees');
});
