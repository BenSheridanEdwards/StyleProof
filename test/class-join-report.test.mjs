import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessReachMaps, reachSectionLines, reachStripLines, reachSummaryLine } from '../dist/report/reach.js';
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
test('J3 is listed in human and JSON reporting, warn-only at both levels', () => {
  for (const level of ['warn', 'gate']) {
    const reach = assess(level);
    assert.equal(reach.classes.length, 2);
    assert.equal(reach.classCounts.unknown, 2);
    assert.equal(reach.classCounts.reached, 0);
    assert.equal(reach.blocking, 0);
    assert.equal(reach.complete, false);
    assert.ok(!reach.gaps.some((gap) => gap.join === 'J3'));
    const md = [...reachStripLines(reach), ...reachSectionLines(reach)].join('\n');
    assert.match(md, /J3.*warn-only/);
    assert.match(md, /class token; delta not tied to this occurrence/);
    assert.doesNotMatch(md, /class-list deltas are not recorded|and class-list deltas\./);
    assert.match(reachSummaryLine(reach), /J3:.*2 unknown/);
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
