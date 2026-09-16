import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CRITICAL_STATES_LEDGER,
  DATA_RESIDUE_LEDGER,
  INVENTORY_LEDGER,
  LEGACY_PAIRS_LEDGER,
  readLedger,
  reconcileLedger,
} from '../dist/ack-ledger.js';
import { mkTmp, rmTmp } from './helpers.mjs';

test('inventory and data-residue ledgers stay lenient: a missing requested file is {} and values are kept as written', () => {
  const root = mkTmp();
  try {
    const missing = path.join(root, 'nope.json');
    assert.deepEqual(readLedger(INVENTORY_LEDGER, missing), {});
    assert.deepEqual(readLedger(DATA_RESIDUE_LEDGER, undefined, undefined, { STYLEPROOF_DATA_RESIDUE: missing }), {});
    const file = path.join(root, 'acks.json');
    fs.writeFileSync(file, JSON.stringify({ 'nav:foo': true, 'home·/api/x': 'fixture pending' }));
    assert.deepEqual(readLedger(INVENTORY_LEDGER, file), { 'nav:foo': true, 'home·/api/x': 'fixture pending' });
  } finally {
    rmTmp(root);
  }
});

test('every ledger still rejects malformed JSON', () => {
  const root = mkTmp();
  try {
    const file = path.join(root, 'bad.json');
    fs.writeFileSync(file, '{not json');
    assert.throws(() => readLedger(INVENTORY_LEDGER, file), /not valid JSON/);
    assert.throws(() => readLedger(LEGACY_PAIRS_LEDGER, file), /not valid JSON/);
  } finally {
    rmTmp(root);
  }
});

test('strict ledgers fail closed on a missing requested file and a non-string reason', () => {
  const root = mkTmp();
  try {
    assert.throws(
      () => readLedger(LEGACY_PAIRS_LEDGER, path.join(root, 'nope.json')),
      /is required when the gate is requested/,
    );
    const file = path.join(root, 'legacy.json');
    fs.writeFileSync(file, JSON.stringify({ home: true }));
    assert.throws(() => readLedger(LEGACY_PAIRS_LEDGER, file), /must be a non-empty reason string/);
    fs.writeFileSync(file, JSON.stringify({ '../escape': 'why' }));
    assert.throws(() => readLedger(CRITICAL_STATES_LEDGER, file, () => 'ok'), /not a safe single path segment/);
  } finally {
    rmTmp(root);
  }
});

test('reconcileLedger splits observed keys and names stale entries', () => {
  const out = reconcileLedger(['a', 'b'], { a: 'why', c: 'stale' });
  assert.deepEqual(out, { acknowledged: ['a'], unacknowledged: ['b'], stale: ['c'] });
});
