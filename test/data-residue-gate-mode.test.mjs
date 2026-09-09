/**
 * Data residue gate mode tests (#520 gap 6).
 *
 * StyleProof supports two data-residue modes:
 * - `gate` (default): unacknowledged failing data endpoints block the diff
 * - `warn`: residue is recorded and warned but never blocks
 *
 * This test ensures both modes behave correctly and the distinction is
 * fully exercised.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditResidue, auditRunResidue, residueKey, unionResidue } from '../dist/data-residue.js';

const entry = (surface, endpoint, reason = 'net::ERR_CONNECTION_REFUSED') => ({
  key: residueKey(surface, endpoint),
  surface,
  endpoint,
  reason,
});

const mapWith = (...entries) => ({ dataResidue: entries });

test('auditRunResidue with gate mode: unacknowledged residue is armed (blocks)', () => {
  const head = [mapWith(entry('dashboard', '/api/probe'))];
  const acknowledged = {};

  const result = auditRunResidue(head, acknowledged, true);

  assert.equal(result.armed, true, 'gate mode should be armed');
  assert.equal(result.unacknowledged.length, 1, 'should have 1 unacknowledged');
  assert.equal(result.unacknowledged[0].key, 'dashboard·/api/probe');
});

test('auditRunResidue with warn mode: unacknowledged residue is not armed (warns only)', () => {
  const head = [mapWith(entry('dashboard', '/api/probe'))];
  const acknowledged = {};

  const result = auditRunResidue(head, acknowledged, false);

  assert.equal(result.armed, false, 'warn mode should not be armed');
  assert.equal(result.unacknowledged.length, 1, 'should still report unacknowledged');
  assert.equal(result.unacknowledged[0].key, 'dashboard·/api/probe');
});

test('auditRunResidue: acknowledged residue does not block in either mode', () => {
  const head = [mapWith(entry('dashboard', '/api/probe'))];
  const acknowledged = { 'dashboard·/api/probe': 'Known staging endpoint' };

  const gateResult = auditRunResidue(head, acknowledged, true);
  const warnResult = auditRunResidue(head, acknowledged, false);

  assert.equal(gateResult.unacknowledged.length, 0);
  assert.equal(warnResult.unacknowledged.length, 0);
  assert.deepEqual(gateResult.residue.length, 1);
  assert.deepEqual(warnResult.residue.length, 1);
});

test('auditRunResidue with gate mode: multiple unacknowledged endpoints', () => {
  const head = [
    mapWith(entry('dashboard', '/api/users'), entry('dashboard', '/api/settings'), entry('profile', '/api/avatar')),
  ];
  const acknowledged = {};

  const result = auditRunResidue(head, acknowledged, true);

  assert.equal(result.armed, true);
  assert.equal(result.unacknowledged.length, 3);
  assert.deepEqual(result.unacknowledged.map((r) => r.key).sort(), [
    'dashboard·/api/settings',
    'dashboard·/api/users',
    'profile·/api/avatar',
  ]);
});

test('auditRunResidue: partial acknowledgment leaves remainder unacknowledged', () => {
  const head = [mapWith(entry('dashboard', '/api/users'), entry('dashboard', '/api/settings'))];
  const acknowledged = { 'dashboard·/api/users': 'Expected to fail in test' };

  const gateResult = auditRunResidue(head, acknowledged, true);

  assert.equal(gateResult.armed, true, 'should still be armed with remaining unacknowledged');
  assert.equal(gateResult.unacknowledged.length, 1);
  assert.equal(gateResult.unacknowledged[0].key, 'dashboard·/api/settings');
});

test('auditResidue: stale acknowledgments are detected in both modes', () => {
  const head = [mapWith()];
  const acknowledged = { 'dashboard·/api/probe': 'Was failing but now fixed' };

  const result = auditResidue(head, acknowledged);

  assert.deepEqual(result.residue, []);
  assert.deepEqual(result.staleAcknowledgements, ['dashboard·/api/probe']);
});

test('auditRunResidue: clean capture (no residue) is not armed regardless of mode', () => {
  const head = [mapWith()];
  const acknowledged = {};

  const gateResult = auditRunResidue(head, acknowledged, true);
  const warnResult = auditRunResidue(head, acknowledged, false);

  assert.deepEqual(gateResult.residue, []);
  assert.deepEqual(gateResult.unacknowledged, []);
  assert.deepEqual(warnResult.residue, []);
  assert.deepEqual(warnResult.unacknowledged, []);
});

test('auditRunResidue: HTTP error codes are treated as residue', () => {
  const head = [mapWith(entry('api-page', '/api/data', 'HTTP 503'))];
  const acknowledged = {};

  const gateResult = auditRunResidue(head, acknowledged, true);

  assert.equal(gateResult.armed, true);
  assert.equal(gateResult.unacknowledged[0].reason, 'HTTP 503');
});

test('unionResidue: deduplicates same failure across multiple widths', () => {
  const maps = [
    mapWith(entry('dashboard', '/api/probe')),
    mapWith(entry('dashboard', '/api/probe')),
    mapWith(entry('dashboard', '/api/probe')),
  ];

  const union = unionResidue(maps);

  assert.equal(union.length, 1);
  assert.equal(union[0].key, 'dashboard·/api/probe');
});

test('unionResidue: preserves distinct endpoints', () => {
  const maps = [mapWith(entry('page-a', '/api/one')), mapWith(entry('page-b', '/api/two'))];

  const union = unionResidue(maps);

  assert.equal(union.length, 2);
  const keys = union.map((r) => r.key).sort();
  assert.deepEqual(keys, ['page-a·/api/one', 'page-b·/api/two']);
});

test('residueKey: escapes Markdown-significant characters', () => {
  const key = residueKey('dashboard', '/api/items[]');

  assert.ok(!key.includes('['), 'should escape brackets');
  assert.ok(!key.includes(']'), 'should escape brackets');
  assert.match(key, /^dashboard·/);
});

test('gate vs warn mode: gate blocks when unacknowledged, warn does not', () => {
  const head = [mapWith(entry('critical', '/api/essential'))];
  const noAcks = {};

  const gateResult = auditRunResidue(head, noAcks, true);
  const warnResult = auditRunResidue(head, noAcks, false);

  assert.equal(gateResult.armed, true, 'gate mode blocks');
  assert.equal(warnResult.armed, false, 'warn mode does not block');

  assert.equal(gateResult.unacknowledged.length, 1);
  assert.equal(warnResult.unacknowledged.length, 1);
});

test('gate mode with full acknowledgment does not block', () => {
  const head = [mapWith(entry('surface-a', '/api/x'), entry('surface-b', '/api/y'))];
  const fullAcks = {
    'surface-a·/api/x': 'Known issue',
    'surface-b·/api/y': 'Expected behavior',
  };

  const result = auditRunResidue(head, fullAcks, true);

  assert.equal(result.armed, true, 'armed flag comes from the mode, not the residue state');
  assert.equal(result.unacknowledged.length, 0, 'no unacknowledged when fully acknowledged');
  assert.equal(result.residue.length, 2, 'residue still recorded');
});
