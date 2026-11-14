import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { deriveReachGuards } from '../dist/reach-guard.js';
const corpus = JSON.parse(fs.readFileSync('bench/reach-corpus.json'));
const receipt = JSON.parse(fs.readFileSync('bench/reach-corpus.results.json'));
const rows = (id, scenario = 'declared', parser = ts) => {
  const result = receipt.cases.find((c) => c.id === id).scenarios[scenario];
  return deriveReachGuards(
    result.evidence.filter((u) => u.status !== 'reached'),
    { ...receipt.remediation, scenarios: { [scenario]: corpus.scenarios[scenario] } },
    parser,
  );
};
test('reach guards name the guarding condition for every unreached corpus case', () => {
  let checkedPairs = 0;
  for (const c of corpus.cases)
    for (const [scenario, expected] of Object.entries(c.expect)) {
      if (!expected.remedy) continue;
      const actual = rows(c.id, scenario);
      assert.deepEqual(
        actual.map((r) => [r.key, r.guardingCondition, r.enclosingSurfaces, r.guard.armRanOn ?? null]),
        expected.remedy,
      );
      assert.ok(actual.some((r) => r.guardingCondition));
      checkedPairs++;
    }
  assert.equal(checkedPairs, 27);
});
test('reach guards follow a never-run component to its guarded call site', () => {
  const row = rows('fault-rule')[0];
  assert.equal(row.guardingCondition, 'app.jsx:88 probe.fault');
  assert.deepEqual(row.guard.path, ['app.jsx:51', 'app.jsx:88']);
  assert.equal(row.enclosing.function, 'App');
  assert.deepEqual(row.enclosingSurfaces, ['home']);
  assert.deepEqual(row.guard.armRanOn, []);
  assert.deepEqual(rows('branch-class', 'complete')[0].guard.armRanOn, ['fault']);
});
test('reach guards name a false arm, a catch, and a media query', () => {
  assert.equal(rows('ternary-arm')[0].guardingCondition, "app.jsx:62 !(status === 'ok')");
  assert.equal(rows('ternary-arm')[0].enclosing.function, 'Badge');
  assert.equal(rows('module-constant', 'complete')[0].guardingCondition, "app.jsx:85 !(probe.status === 'ok')");
  assert.deepEqual(rows('module-constant', 'complete')[0].guard.armRanOn, ['status-bad']);
  assert.equal(rows('error-handler')[0].guardingCondition, 'app.jsx:92 catch (err)');
  assert.equal(rows('dark-mode')[0].guardingCondition, '@media (prefers-color-scheme: dark)');
  assert.equal(rows('wide-media')[0].guardingCondition, '@media (min-width: 1440px)');
  assert.equal(rows('keyframes', 'complete')[0].guardingCondition, 'blind-channel @keyframes pulse via .badge');
});
test('reach guards report no guard for an unguarded use instead of inventing one', () => {
  const actual = rows('same-token-collision');
  const row = actual.find((r) => r.key === 'app.jsx:10');
  assert.equal(row.guardingCondition, null);
  assert.equal(row.guard.kind, 'none');
  assert.match(row.guard.reason, /app\.jsx:83/);
  assert.equal(actual.find((r) => r.key === 'app.jsx:11').guardingCondition, 'app.jsx:88 probe.fault');
});
test('reach guards stay unmeasured without a parser', () => {
  assert.equal(rows('dark-mode', 'declared', null)[0].guardingCondition, '@media (prefers-color-scheme: dark)');
  const row = rows('fault-rule', 'declared', null)[0];
  assert.equal(row.guard.kind, 'unmeasured');
  assert.equal(row.guardingCondition, null);
  assert.match(row.guard.reason, /typescript/);
});
test('reach corpus receipt evidence matches the fixture', () => {
  assert.equal(receipt.remediation.sources.base['app.jsx'], fs.readFileSync('bench/fixtures/reach/app.jsx', 'utf8'));
  for (const side of Object.values(receipt.remediation.execution))
    for (const surface of Object.values(side)) assert.ok(surface['app.jsx'].executed.length);
});

test('reach guards follow a component style prop to its guarded use', () => {
  const row = rows('same-line-class-style')[0];
  assert.equal(row.guardingCondition, 'app.jsx:70 probe.fault');
  assert.ok(row.guard.path.includes('app.jsx:74'));
});
