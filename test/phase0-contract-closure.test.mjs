import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessPhase0Contract, parsePhase0Contract, Phase0ContractError } from '../dist/phase0-contract.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/phase0-contract');
const SRC_SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const EVIDENCE_DIGEST = 'e'.repeat(64);
const FOREIGN_DIGEST = 'f'.repeat(64);
const SECRET = 'https://fixture.invalid/proxy-secret';
const SAFE_THROW_MESSAGES = new Set(['styleproof: phase 0 contract bytes are unreadable']);
const CLOSED_REASONS = new Set([
  'document-absent',
  'document-invalid',
  'unknown-field',
  'unknown-enum',
  'duplicate-json-key',
  'duplicate-id',
  'invalid-id',
  'invalid-digest',
  'contradiction-blocks-obligation',
  'connector-not-run',
  'connector-failed',
  'connector-unsupported',
  'connector-partial',
  'closure-partial',
  'closure-unasserted',
  'empty-universe-unproven',
  'empty-universe-conflict',
  'partial-enumerated',
  'illegal-cardinality',
  'dangling-endpoint',
  'identity-cycle',
  'integrity-mismatch',
  'legacy-unproven',
  'environment-unproven',
  'missing-required-domain',
  'duplicate-domain',
  'unmatched-source-run',
  'producer-mismatch',
  'unauthorized-mode',
  'scope-mismatch',
  'missing-join',
  'extra-join',
  'duplicate-join',
  'fact-count-mismatch',
  'comparability-mismatch',
]);
const HOSTILE_INVALID_RECEIPT = {
  certifies: false,
  presence: 'present-invalid',
  status: 'invalid',
  axes: {
    integrity: 'invalid',
    envelopes: 'unproven',
    authority: 'unproven',
    execution: 'unproven',
    identity: 'unproven',
    comparability: 'unproven',
    completeness: 'unproven',
    provenance: 'unproven',
  },
  reasons: ['document-invalid'],
  counts: {
    assertions: 0,
    contradictions: 0,
    sourceRuns: 0,
    obligations: 0,
    blockedObligations: 0,
    relations: 0,
  },
};

function validDoc() {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, 'valid-enumerated.json'), 'utf8'));
}

function firstJoin(doc) {
  return Array.isArray(doc.integrity) ? doc.integrity[0] : doc.integrity;
}

function assertClosedReasons(receipt) {
  assert.deepEqual(receipt.reasons, [...new Set(receipt.reasons)].sort());
  for (const reason of receipt.reasons) {
    assert.equal(CLOSED_REASONS.has(reason), true, reason);
  }
}

function assertHostileArrayReceipt(fn) {
  let receipt;
  assert.doesNotThrow(() => {
    receipt = fn();
  });
  assert.deepEqual(receipt, HOSTILE_INVALID_RECEIPT);
  assert.equal(CLOSED_REASONS.has(receipt.reasons[0]), true);
  assert.equal(JSON.stringify(receipt), JSON.stringify(HOSTILE_INVALID_RECEIPT));
}

function secretError() {
  const error = new Error(SECRET);
  return error;
}

function secretPhase0Error() {
  const error = new Phase0ContractError();
  error.message = SECRET;
  return error;
}

function lengthTrap(thrower) {
  return new Proxy([], {
    get(target, property, receiver) {
      if (property === 'length') throw thrower();
      return Reflect.get(target, property, receiver);
    },
  });
}

function iteratorTrap(thrower) {
  return new Proxy([], {
    get(target, property, receiver) {
      if (property === Symbol.iterator) throw thrower();
      return Reflect.get(target, property, receiver);
    },
  });
}

function accessorIndexArray(thrower) {
  const items = [];
  Object.defineProperty(items, '0', {
    configurable: true,
    enumerable: true,
    get() {
      throw thrower();
    },
  });
  items.length = 1;
  return items;
}

function descriptorTrap(thrower) {
  return new Proxy([], {
    getOwnPropertyDescriptor() {
      throw thrower();
    },
  });
}

test('JSON bytes of the valid enumerated control still certify', () => {
  const receipt = parsePhase0Contract(fs.readFileSync(path.join(FIXTURES, 'valid-enumerated.json'), 'utf8'));
  assert.equal(receipt.certifies, true);
  assert.equal(receipt.presence, 'present');
  assert.deepEqual(receipt.reasons, []);
});

test('array length trap returns present-invalid and never throws', () => {
  assertHostileArrayReceipt(() =>
    assessPhase0Contract({ version: '0.1', documentId: 'doc-1', assertions: lengthTrap(secretError) }),
  );
});

test('array length trap throwing Phase0ContractError with a secret does not leak', () => {
  assertHostileArrayReceipt(() =>
    assessPhase0Contract({
      version: '0.1',
      documentId: 'doc-1',
      assertions: lengthTrap(secretPhase0Error),
    }),
  );
});

test('array iterator trap returns present-invalid and never throws', () => {
  assertHostileArrayReceipt(() =>
    assessPhase0Contract({ version: '0.1', documentId: 'doc-1', assertions: iteratorTrap(secretError) }),
  );
});

test('array iterator trap throwing Phase0ContractError with a secret does not leak', () => {
  assertHostileArrayReceipt(() =>
    assessPhase0Contract({
      version: '0.1',
      documentId: 'doc-1',
      assertions: iteratorTrap(secretPhase0Error),
    }),
  );
});

test('accessor index array returns present-invalid and never throws', () => {
  assertHostileArrayReceipt(() =>
    assessPhase0Contract({
      version: '0.1',
      documentId: 'doc-1',
      assertions: accessorIndexArray(secretError),
    }),
  );
});

test('accessor index throwing Phase0ContractError with a secret does not leak', () => {
  assertHostileArrayReceipt(() =>
    assessPhase0Contract({
      version: '0.1',
      documentId: 'doc-1',
      assertions: accessorIndexArray(secretPhase0Error),
    }),
  );
});

test('revoked array proxy returns present-invalid and never throws', () => {
  const { proxy, revoke } = Proxy.revocable([], {});
  revoke();
  assertHostileArrayReceipt(() => assessPhase0Contract({ version: '0.1', documentId: 'doc-1', assertions: proxy }));
});

test('array descriptor trap returns present-invalid and never throws', () => {
  assertHostileArrayReceipt(() =>
    assessPhase0Contract({
      version: '0.1',
      documentId: 'doc-1',
      assertions: descriptorTrap(secretError),
    }),
  );
});

test('array descriptor trap throwing Phase0ContractError with a secret does not leak', () => {
  assertHostileArrayReceipt(() =>
    assessPhase0Contract({
      version: '0.1',
      documentId: 'doc-1',
      assertions: descriptorTrap(secretPhase0Error),
    }),
  );
});

test('assertion validity SHA must equal the producing run SHA', () => {
  const doc = validDoc();
  doc.identities.push({
    id: 'snap-src-2',
    layer: 'source-snapshot',
    sourceSha: OTHER_SHA,
  });
  doc.assertions[0].validity = 'snap-src-2';
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('integrity-mismatch'));
  assertClosedReasons(receipt);
});

test('distinct source-snapshot identities cannot share sourceSha', () => {
  const doc = validDoc();
  doc.identities.push({
    id: 'snap-src-dup',
    layer: 'source-snapshot',
    sourceSha: SRC_SHA,
  });
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('duplicate-id') || receipt.reasons.includes('integrity-mismatch'));
  assertClosedReasons(receipt);
});

test('join.run cannot be a coverage-ledger run', () => {
  const doc = validDoc();
  firstJoin(doc).run = 'run-coverage-ledger';
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('integrity-mismatch'));
  assertClosedReasons(receipt);
});

test('join.run cannot be a determinism run', () => {
  const doc = validDoc();
  firstJoin(doc).run = 'run-determinism';
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('integrity-mismatch'));
  assertClosedReasons(receipt);
});

test('join.run cannot be a source-binding run', () => {
  const doc = validDoc();
  firstJoin(doc).run = 'run-source-binding';
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('integrity-mismatch'));
  assertClosedReasons(receipt);
});

test('join.run cannot be a product-state run', () => {
  const doc = validDoc();
  firstJoin(doc).run = 'run-product-state';
  firstJoin(doc).producer = 'checkout-app';
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('integrity-mismatch'));
  assertClosedReasons(receipt);
});

test('join.run may be an evidence-store run', () => {
  const doc = validDoc();
  firstJoin(doc).run = 'run-evidence-store';
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, true);
  assert.deepEqual(receipt.reasons, []);
});

test('empty comparability with a required checkout obligation cannot certify', () => {
  const doc = validDoc();
  doc.comparability = [];
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('comparability-mismatch'));
  assertClosedReasons(receipt);
});

test('matching required surface cannot be covered by a not-required receipt', () => {
  for (const reason of ['missing-before', 'missing-after']) {
    const doc = validDoc();
    doc.comparability = [
      {
        surface: 'checkout',
        status: 'not-required',
        required: false,
        reason,
      },
    ];
    const receipt = assessPhase0Contract(doc);
    assert.equal(receipt.certifies, false, reason);
    assert.equal(receipt.axes.comparability, 'invalid', reason);
    assert.ok(receipt.reasons.includes('comparability-mismatch'), reason);
    assertClosedReasons(receipt);
  }
});

test('foreign pricing-only comparability cannot cover required checkout', () => {
  const doc = validDoc();
  doc.comparability = [
    {
      surface: 'pricing',
      status: 'not-required',
      required: false,
      reason: 'missing-before',
    },
  ];
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('comparability-mismatch'));
  assertClosedReasons(receipt);
});

test('checkout plus foreign comparability cannot certify', () => {
  const doc = validDoc();
  doc.comparability = [
    doc.comparability[0],
    {
      surface: 'pricing',
      status: 'not-required',
      required: false,
      reason: 'missing-before',
    },
  ];
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('comparability-mismatch'));
  assertClosedReasons(receipt);
});

test('no required obligations forbids comparability receipts', () => {
  const doc = validDoc();
  doc.obligations[0].required = false;
  doc.obligations[0].outcome = 'unproven';
  doc.integrity = [];
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('comparability-mismatch'));
  assertClosedReasons(receipt);
});

test('dropping evidence identity and its digest while the join remains cannot certify', () => {
  const doc = validDoc();
  doc.identities = doc.identities.filter((entry) => entry.layer !== 'evidence');
  firstJoin(doc).artifactDigests = firstJoin(doc).artifactDigests.filter((digest) => digest !== EVIDENCE_DIGEST);
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('integrity-mismatch') || receipt.reasons.includes('invalid-id'));
  assertClosedReasons(receipt);
});

test('foreign evidence identity and digest cannot certify', () => {
  const doc = validDoc();
  doc.identities.push({
    id: 'evidence-foreign',
    layer: 'evidence',
    evidenceDigest: FOREIGN_DIGEST,
  });
  firstJoin(doc).artifactDigests.push(FOREIGN_DIGEST);
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('integrity-mismatch') || receipt.reasons.includes('invalid-id'));
  assertClosedReasons(receipt);
});

test('integrity evidence digest without an evidence identity cannot certify', () => {
  const doc = validDoc();
  doc.identities = doc.identities.filter((entry) => entry.layer !== 'evidence');
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('integrity-mismatch') || receipt.reasons.includes('invalid-id'));
  assertClosedReasons(receipt);
});

test('incomparable explicit-state-mismatch returns comparability-mismatch', () => {
  const doc = validDoc();
  doc.comparability = [
    {
      surface: 'checkout',
      status: 'incomparable',
      required: true,
      reason: 'explicit-state-mismatch',
    },
  ];
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('comparability-mismatch'));
  assert.notEqual(receipt.reasons.length, 0);
  assertClosedReasons(receipt);
});

test('invalid comparability combinations return comparability-mismatch', () => {
  const cases = [
    { status: 'comparable', required: true, reason: 'explicit-state-mismatch' },
    { status: 'comparable', required: true, reason: 'missing-before' },
    { status: 'incomparable', required: true, reason: 'explicit-state-match' },
    { status: 'incomparable', required: true, reason: 'state-identity-missing' },
    { status: 'not-required', required: false, reason: 'explicit-state-match' },
    { status: 'unproven', required: true, reason: 'explicit-state-match' },
  ];
  for (const entry of cases) {
    const doc = validDoc();
    doc.comparability = [{ surface: 'checkout', ...entry }];
    const receipt = assessPhase0Contract(doc);
    assert.equal(receipt.certifies, false, JSON.stringify(entry));
    assert.ok(receipt.reasons.includes('comparability-mismatch'), JSON.stringify(entry));
    assert.notEqual(receipt.reasons.length, 0, JSON.stringify(entry));
    assertClosedReasons(receipt);
  }
});

test('Uint8Array larger than 16 MiB throws before decode', () => {
  const original = TextDecoder.prototype.decode;
  let decoded = false;
  TextDecoder.prototype.decode = function decodeOversize(...args) {
    decoded = true;
    return original.apply(this, args);
  };
  try {
    const bytes = new Uint8Array(16 * 1024 * 1024 + 1);
    assert.throws(() => parsePhase0Contract(bytes), Phase0ContractError);
    assert.equal(decoded, false);
    try {
      parsePhase0Contract(bytes);
    } catch (error) {
      assert.equal(error instanceof Phase0ContractError, true);
      assert.equal(SAFE_THROW_MESSAGES.has(error.message), true);
    }
  } finally {
    TextDecoder.prototype.decode = original;
  }
});
