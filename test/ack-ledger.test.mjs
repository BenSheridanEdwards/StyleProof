import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CRITICAL_STATES_LEDGER,
  DATA_RESIDUE_LEDGER,
  INVENTORY_LEDGER,
  LEGACY_PAIRS_LEDGER,
  ledgerArmed,
  readLedger,
  reconcileLedger,
  resolveLedgerPath,
} from '../dist/ack-ledger.js';
import { mkTmp, rmTmp } from './helpers.mjs';

test('inventory and data-residue ledgers stay lenient: a missing requested file is {} and values are kept as written', () => {
  const root = mkTmp();
  try {
    const missing = path.join(root, 'nope.json');
    assert.deepEqual(readLedger(INVENTORY_LEDGER, missing), {});
    assert.deepEqual(readLedger(DATA_RESIDUE_LEDGER, undefined, undefined, { STYLEPROOF_DATA_RESIDUE: missing }), {});
    const file = path.join(root, 'acks.json');
    const written = {
      'nav:foo': true,
      'home·/api/x': 'fixture pending',
      'nav:padded': '  spaced reason  ',
      'nav:count': 2,
      'nav:meta': { owner: 'qa' },
    };
    fs.writeFileSync(file, JSON.stringify(written));
    assert.deepEqual(readLedger(INVENTORY_LEDGER, file), {
      'nav:foo': true,
      'home·/api/x': 'fixture pending',
      'nav:padded': '  spaced reason  ',
      'nav:count': 2,
      'nav:meta': { owner: 'qa' },
    });
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
    fs.writeFileSync(file, '');
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
    assert.throws(
      () =>
        readLedger(LEGACY_PAIRS_LEDGER, undefined, undefined, {
          STYLEPROOF_PRODUCT_STATE: path.join(root, 'nope.json'),
        }),
      /is required when the gate is requested/,
    );
    const file = path.join(root, 'legacy.json');
    fs.writeFileSync(file, JSON.stringify({ home: true }));
    assert.throws(() => readLedger(LEGACY_PAIRS_LEDGER, file), /must be a non-empty reason string/);
    fs.writeFileSync(file, JSON.stringify({ home: 1 }));
    assert.throws(() => readLedger(LEGACY_PAIRS_LEDGER, file), /must be a non-empty reason string/);
    fs.writeFileSync(file, JSON.stringify({ '../escape': 'why' }));
    assert.throws(() => readLedger(CRITICAL_STATES_LEDGER, file, () => 'ok'), /not a safe single path segment/);
  } finally {
    rmTmp(root);
  }
});

test('reconcileLedger splits observed keys and names stale entries', () => {
  const out = reconcileLedger(['a', 'b'], { a: 'why', c: 'stale', d: 'stale too' });
  assert.deepEqual(out, { acknowledged: ['a'], unacknowledged: ['b'], stale: ['c', 'd'] });
  // A custom matcher decides which ledger key acknowledges an observed key, and a key it matched is not stale.
  const widthless = reconcileLedger(['home@1280', 'nav@375'], { home: 'why', gone: 'stale' }, (ledgerKey, observed) =>
    observed.startsWith(`${ledgerKey}@`),
  );
  assert.deepEqual(widthless, { acknowledged: ['home@1280'], unacknowledged: ['nav@375'], stale: ['gone'] });
});

test('reconcileLedger never names a ledger key stale while it matches an observed key, in any key order', () => {
  const overlapping = (ledgerKey, observed) => observed === ledgerKey || observed.startsWith(`${ledgerKey}@`);
  for (const ledger of [
    { home: 'why', 'home@1280': 'why', gone: 'stale' },
    { 'home@1280': 'why', home: 'why', gone: 'stale' },
  ]) {
    assert.deepEqual(
      reconcileLedger(['home@1280'], ledger, overlapping),
      { acknowledged: ['home@1280'], unacknowledged: [], stale: ['gone'] },
      `ledger order: ${Object.keys(ledger).join(', ')}`,
    );
  }
});

test('an empty env value drops a config path but a default file in cwd still arms the gate', () => {
  const root = mkTmp();
  const previous = process.cwd();
  try {
    process.chdir(root);
    const obligation = { owner: 'qa', reason: 'checkout must certify' };
    for (const [spec, parse] of [
      [CRITICAL_STATES_LEDGER, (_spec, value) => value],
      [LEGACY_PAIRS_LEDGER, undefined],
    ]) {
      const env = { [spec.env]: '' };
      fs.writeFileSync('configured.json', JSON.stringify({ configured: parse ? obligation : 'why' }));
      const resolved = resolveLedgerPath(spec, undefined, 'configured.json', env);
      assert.equal(resolved, undefined, `${spec.env}="" must ignore the config path`);
      assert.equal(ledgerArmed(spec, resolved, env), false, `${spec.env}="" with no default file is unarmed`);

      fs.writeFileSync(spec.file, JSON.stringify({ home: parse ? obligation : 'legacy shell' }));
      assert.equal(ledgerArmed(spec, resolved, env), true, `${spec.env}="" must not unarm ${spec.file}`);
      assert.deepEqual(Object.keys(readLedger(spec, resolved, parse, env)), ['home']);
    }
  } finally {
    process.chdir(previous);
    rmTmp(root);
  }
});

for (const spec of [INVENTORY_LEDGER, DATA_RESIDUE_LEDGER, LEGACY_PAIRS_LEDGER, CRITICAL_STATES_LEDGER]) {
  test(`${spec.label} preserves __proto__ as an own ledger entry`, () => {
    const root = mkTmp();
    try {
      const file = path.join(root, 'acks.json');
      const written = { ['__proto__']: '  declared reason  ', constructor: 'another reason' };
      fs.writeFileSync(file, JSON.stringify(written));
      const ledger = readLedger(spec, file);
      assert.equal(Object.hasOwn(ledger, '__proto__'), true);
      assert.equal(ledger.__proto__, spec.lenient ? '  declared reason  ' : 'declared reason');
      assert.equal(ledger.constructor, 'another reason');
      assert.equal(Object.getPrototypeOf(ledger), Object.prototype);
      assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(ledger))), ['__proto__', 'constructor']);
    } finally {
      rmTmp(root);
    }
  });
}

test('lenient ledgers preserve object-valued __proto__ entries without changing the result prototype', () => {
  const root = mkTmp();
  try {
    const file = path.join(root, 'acks.json');
    const written = { ['__proto__']: { owner: 'qa', reason: 'fixture pending' } };
    fs.writeFileSync(file, JSON.stringify(written));
    for (const spec of [INVENTORY_LEDGER, DATA_RESIDUE_LEDGER]) {
      const ledger = readLedger(spec, file);
      assert.deepEqual(ledger, written);
      assert.equal(Object.getPrototypeOf(ledger), Object.prototype);
      assert.equal(ledger.owner, undefined);
    }
  } finally {
    rmTmp(root);
  }
});
