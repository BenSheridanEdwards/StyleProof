import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditReach, reachKey, readReachAckFile } from '../dist/reach-ledger.js';

test('an acknowledged unreached range clears the reach audit gate', () => {
  const key = reachKey('src/example.ts', 'return 1;');
  assert.equal(auditReach([key], {}).passed, false);
  const audit = auditReach([key], { [key]: 'Non-visual calculation' });
  assert.equal(audit.passed, true);
  assert.deepEqual(audit.unacknowledged, []);
});

test('a changed range leaves a stale acknowledgement and fails', () => {
  const old = reachKey('src/example.ts', 'return 1;');
  const current = reachKey('src/example.ts', 'return 2;');
  const audit = auditReach([current], { [old]: 'Non-visual calculation' });
  assert.equal(audit.passed, false);
  assert.deepEqual(audit.staleAcknowledgements, [old]);
  assert.deepEqual(audit.unacknowledged, [current]);
  assert.equal(auditReach([], { [old]: 'Removed range' }).passed, false);
});

test('range identities include the file and exact range bytes', () => {
  assert.notEqual(reachKey('a.ts', 'x'), reachKey('b.ts', 'x'));
  assert.notEqual(reachKey('a.ts', 'x'), reachKey('a.ts', 'x\n'));
});

test('reach ledger validates keys and reasons through the shared reader', () => {
  const env = {};
  assert.deepEqual(readReachAckFile(undefined, env), {});
});
