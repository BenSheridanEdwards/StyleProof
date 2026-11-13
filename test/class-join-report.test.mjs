import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessReachMaps, reachHeadlineLines, reachSectionLines, reachSummaryLine } from '../dist/report/reach.js';
import { changedScriptRanges } from '../dist/script-join-git.js';
import { reserveScriptNotice, budgetScriptReach, jsonBytes } from '../dist/report/script-units.js';
const map = (cls) => ({
  defaults: {},
  states: {},
  elements: { body: { tag: 'body', cls, style: {} } },
  reach: { version: 2, scope: 'compared', sheets: ['app.css'], rules: [{ key: '.old.new', hash: 'same', sheet: 0 }] },
});
const changes = changedScriptRanges(
  '@@ -1 +1 @@\n-const C = "old";\n+const C = "new";\n',
  { base: 'const C = "old";', head: 'const C = "new";' },
  'app.tsx',
);
const assess = (level = 'warn', now = 'new') => {
  const base = map('old'),
    head = map(now);
  return assessReachMaps([base], [head], level, { changes, gaps: [] }, [{ base, head }]);
};
test('J3 is listed in JSON reporting only, warn-only at both levels (QA3-01)', () => {
  for (const level of ['warn', 'gate']) {
    const reach = assess(level);
    assert.equal(reach.classes.length, 2);
    assert.equal(reach.classCounts.unknown, 2);
    assert.equal(reach.classCounts.reached, 0);
    assert.equal(reach.blocking, 0);
    assert.equal(reach.complete, false);
    assert.ok(!reach.gaps.some((gap) => gap.join === 'J3'));
    // Warn-only J3 detail is machine output: report.md shows none of it at either level.
    const md = [...reachHeadlineLines(reach), ...reachSectionLines(reach), reachSummaryLine(reach)].join('\n');
    assert.doesNotMatch(md, /J3|token present on a captured element/);
    assert.ok(
      reach.classes.every((unit) => /token present on a captured element; not tied to this occurrence/.test(unit.why)),
    );
    assert.doesNotMatch(JSON.stringify(reach), /classSource|const C/);
  }
});
test('J3 detail and gaps use leftover JSON bytes, keeping full status counts', () => {
  const original = assess();
  original.classes = Array.from({ length: 400 }, (_, i) => ({ ...original.classes[0], sourceKey: `src/${i}.tsx` }));
  original.classCounts.unknown = 400;
  const reserved = reserveScriptNotice(original);
  assert.deepEqual(reserved.classes, []);
  const result = budgetScriptReach(original, reserved, 1200);
  assert.ok(result.reach.classes.length < 400);
  assert.equal(result.reach.classCounts.unknown, 400);
  assert.ok(result.reach.gaps.some((g) => g.join === 'J3' && /truncated/.test(g.reason)));
  assert.ok(jsonBytes(result.reach) <= jsonBytes(reserved) + 1200);
  const full = budgetScriptReach(original, reserved, 1_000_000).reach;
  assert.ok(jsonBytes(full) - jsonBytes(reserved) <= 64_000);
});

test('missing J3 inputs keep class-list deltas explicitly not checked', () => {
  const reach = assessReachMaps([map('old')], [map('new')], 'warn');
  assert.ok(reach.gaps.some((gap) => gap.join === 'J3' && /source ranges unavailable/.test(gap.reason)));
  // The gap is machine output (report.json `reach.gaps`), never Markdown. (QA3-01)
  assert.doesNotMatch([...reachHeadlineLines(reach), ...reachSectionLines(reach)].join('\n'), /J3|Class-list/);
});

test('omitted J3 detail cannot retain a complete flag', () => {
  const original = { ...assess(), complete: true, scripts: [], gaps: [] };
  original.classes = Array.from({ length: 400 }, () => original.classes[0]);
  const result = budgetScriptReach(original, reserveScriptNotice(original), 200);
  assert.equal(result.reach.complete, false);
});

test('J3 gap records share the leftover budget and preserve their real count', () => {
  const original = assess();
  original.gaps = Array.from({ length: 300 }, (_, i) => ({
    join: 'J3',
    kind: 'class-list',
    status: 'unmeasured',
    reason: `${i}: ${'missing vocabulary '.repeat(100)}`,
    remedy: 'recapture both revisions',
  }));
  original.classGapCount = 300;
  const reserved = reserveScriptNotice(original);
  const result = budgetScriptReach(original, reserved, 900).reach;
  assert.equal(result.classGapCount, 300);
  assert.ok(result.gaps.some((gap) => /300 gap\(s\) omitted/.test(gap.reason)));
  assert.ok(jsonBytes(result) <= jsonBytes(reserved) + 900);
});
