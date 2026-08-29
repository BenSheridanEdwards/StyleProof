import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessPhase0Contract } from '../dist/phase0-contract.js';
import { digestPhase0Contract, serializePhase0Contract } from '../dist/index.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/phase0-contract');
const SRC_SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const DIGEST = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const EXTRA_DIGEST = 'ab'.repeat(32);

function validDoc() {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, 'valid-enumerated.json'), 'utf8'));
}

function firstJoin(doc) {
  return Array.isArray(doc.integrity) ? doc.integrity[0] : doc.integrity;
}

function productStateIdentity(id, revision = 'rev-1') {
  return { id, layer: 'product-state', revision };
}

function snapshotIdentity(id, sourceSha) {
  return { id, layer: 'source-snapshot', sourceSha };
}

function assertionIdentity(id) {
  return { id, layer: 'assertion', assertionId: id };
}

function evidenceIdentity(id, evidenceDigest) {
  return { id, layer: 'evidence', evidenceDigest };
}

function bindControlIdentities(doc) {
  const evidenceDigest = doc.assertions?.[0]?.sourceDigest ?? DIGEST;
  doc.identities = [
    productStateIdentity('state-checkout'),
    snapshotIdentity('snap-src-1', SRC_SHA),
    assertionIdentity('assert-checkout-ready'),
    evidenceIdentity('evidence-checkout', evidenceDigest),
  ];
  if (doc.assertions?.[0]) doc.assertions[0].validity = 'snap-src-1';
  if (doc.obligations?.[0]) doc.obligations[0].sourceSnapshot = 'snap-src-1';
  return doc;
}

test('source-snapshot identity missing sourceSha cannot certify', () => {
  const doc = validDoc();
  const snap = doc.identities.find((entry) => entry.layer === 'source-snapshot');
  delete snap.sourceSha;
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.equal(receipt.axes.identity === 'valid', false);
});

test('product-state identity missing revision cannot certify', () => {
  const doc = validDoc();
  const state = doc.identities.find((entry) => entry.layer === 'product-state');
  delete state.revision;
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
});

test('assertion identity missing assertionId cannot certify', () => {
  const doc = validDoc();
  const identity = doc.identities.find((entry) => entry.layer === 'assertion');
  delete identity.assertionId;
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
});

test('evidence identity missing evidenceDigest cannot certify', () => {
  const doc = validDoc();
  const identity = doc.identities.find((entry) => entry.layer === 'evidence');
  delete identity.evidenceDigest;
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
});

test('wrong field on a product-state identity fails closed as unknown-field', () => {
  const doc = bindControlIdentities(validDoc());
  doc.identities[0].sourceSha = SRC_SHA;
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('unknown-field'));
  assert.equal(JSON.stringify(receipt).includes(SRC_SHA), false);
});

test('obligation sourceSnapshot cannot embed a raw SHA', () => {
  const doc = bindControlIdentities(validDoc());
  doc.obligations[0].sourceSnapshot = SRC_SHA;
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('invalid-id') || receipt.reasons.includes('integrity-mismatch'));
});

test('assertion validity must reference a known source-snapshot identity', () => {
  const doc = bindControlIdentities(validDoc());
  doc.assertions[0].validity = 'snap-1';
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('invalid-id'));
  assert.equal(JSON.stringify(receipt).includes('snap-1'), false);
});

test('source run SHA must equal the referenced source-snapshot SHA', () => {
  const doc = bindControlIdentities(validDoc());
  const snap = doc.identities.find((entry) => entry.layer === 'source-snapshot');
  snap.sourceSha = OTHER_SHA;
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('integrity-mismatch'));
});

test('join SHA must equal the referenced source-snapshot SHA', () => {
  const doc = bindControlIdentities(validDoc());
  firstJoin(doc).sourceSha = OTHER_SHA;
  for (const run of doc.sourceRuns) run.sourceSha = OTHER_SHA;
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('integrity-mismatch'));
});

test('cross-layer source-snapshot id cannot satisfy a product-state obligation', () => {
  const doc = bindControlIdentities(validDoc());
  doc.obligations[0].state = 'snap-src-1';
  firstJoin(doc).semanticStateId = 'snap-src-1';
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('invalid-id') || receipt.reasons.includes('integrity-mismatch'));
});

test('assertion without a matching assertion identity cannot certify', () => {
  const doc = bindControlIdentities(validDoc());
  doc.identities = doc.identities.filter((entry) => entry.layer !== 'assertion');
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('invalid-id'));
});

test('assertion identity without a matching assertion cannot certify', () => {
  const doc = bindControlIdentities(validDoc());
  doc.identities.push(assertionIdentity('assert-orphan'));
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('invalid-id'));
  assert.equal(JSON.stringify(receipt).includes('assert-orphan'), false);
});

test('required obligation state must resolve to a product-state identity with revision', () => {
  const doc = bindControlIdentities(validDoc());
  const state = doc.identities.find((entry) => entry.layer === 'product-state');
  delete state.revision;
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
});

test('evidence identity digest must participate in credited artifact closure', () => {
  const doc = bindControlIdentities(validDoc());
  const identity = doc.identities.find((entry) => entry.layer === 'evidence');
  identity.evidenceDigest = EXTRA_DIGEST;
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('integrity-mismatch'));
});

test('enumerated factCount must equal assertions whose run is that envelope', () => {
  const doc = validDoc();
  const capture = doc.sourceRuns.find((run) => run.domain === 'capture-maps');
  capture.factCount = 1;
  delete capture.emptyUniverseProof;
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.equal(receipt.axes.completeness === 'valid', false);
});

test('complete enumerated run with zero assertions certifies only with factCount 0 and emptyUniverseProof', () => {
  const doc = validDoc();
  const capture = doc.sourceRuns.find((run) => run.domain === 'capture-maps');
  capture.factCount = 0;
  capture.emptyUniverseProof = true;
  assert.equal((doc.assertions ?? []).filter((assertion) => assertion.run === capture.id).length, 0);
  const withProof = assessPhase0Contract(doc);
  assert.equal(withProof.reasons.includes('empty-universe-unproven'), false);

  delete capture.emptyUniverseProof;
  const withoutProof = assessPhase0Contract(doc);
  assert.equal(withoutProof.certifies, false);
  assert.ok(withoutProof.reasons.includes('empty-universe-unproven'));
});

test('same subject and predicate in a different scope do not conflict', () => {
  const doc = bindControlIdentities(validDoc());
  doc.assertions.push({
    ...doc.assertions[0],
    id: 'assert-pricing-ready',
    scope: 'pricing',
    object: 'loading',
  });
  doc.identities.push(assertionIdentity('assert-pricing-ready'));
  const product = doc.sourceRuns.find((run) => run.domain === 'product-state');
  product.factCount = 2;
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.counts.contradictions, 0);
  assert.equal(receipt.reasons.includes('contradiction-blocks-obligation'), false);
});

test('same subject and predicate under a different source-snapshot validity do not conflict', () => {
  const doc = bindControlIdentities(validDoc());
  doc.identities.push(snapshotIdentity('snap-src-2', OTHER_SHA));
  doc.assertions.push({
    ...doc.assertions[0],
    id: 'assert-checkout-other-snap',
    validity: 'snap-src-2',
    object: 'loading',
  });
  doc.identities.push(assertionIdentity('assert-checkout-other-snap'));
  const product = doc.sourceRuns.find((run) => run.domain === 'product-state');
  product.factCount = 2;
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.counts.contradictions, 0);
  assert.equal(receipt.reasons.includes('contradiction-blocks-obligation'), false);
});

test('same subject predicate scope and validity with a different object still blocks', () => {
  const doc = bindControlIdentities(validDoc());
  doc.assertions.push({
    ...doc.assertions[0],
    id: 'assert-checkout-loading',
    object: 'loading',
  });
  doc.identities.push(assertionIdentity('assert-checkout-loading'));
  const product = doc.sourceRuns.find((run) => run.domain === 'product-state');
  product.factCount = 2;
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.equal(receipt.counts.contradictions >= 1, true);
  assert.ok(receipt.reasons.includes('contradiction-blocks-obligation'));
});

test('one extra valid artifact digest cannot certify', () => {
  const doc = validDoc();
  firstJoin(doc).artifactDigests.push(EXTRA_DIGEST);
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.equal(receipt.axes.provenance, 'invalid');
  assert.ok(receipt.reasons.includes('integrity-mismatch'));
});

test('split with duplicate to ids cannot certify', () => {
  const doc = bindControlIdentities(validDoc());
  doc.identities.push(productStateIdentity('state-a'), productStateIdentity('state-b'));
  doc.relations = [{ kind: 'split', from: ['state-checkout'], to: ['state-a', 'state-a'] }];
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('illegal-cardinality'));
});

test('merge with duplicate from ids cannot certify', () => {
  const doc = bindControlIdentities(validDoc());
  doc.identities.push(productStateIdentity('state-other'), productStateIdentity('state-combined'));
  doc.relations = [{ kind: 'merge', from: ['state-checkout', 'state-checkout'], to: ['state-combined'] }];
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('illegal-cardinality'));
});

test('empty relation endpoints cannot certify', () => {
  const doc = bindControlIdentities(validDoc());
  doc.relations = [{ kind: 'rename', from: [], to: [] }];
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('illegal-cardinality'));
});

test('duplicate identical relations cannot certify', () => {
  const doc = bindControlIdentities(validDoc());
  doc.identities.push(productStateIdentity('state-checkout-v2'));
  const relation = { kind: 'rename', from: ['state-checkout'], to: ['state-checkout-v2'] };
  doc.relations = [relation, { ...relation, from: [...relation.from], to: [...relation.to] }];
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('duplicate-id'));
});

test('duplicate comparability receipts for the same surface cannot certify', () => {
  const doc = validDoc();
  doc.comparability = [doc.comparability[0], { ...doc.comparability[0] }];
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('duplicate-id'));
});

test('canonical digest is stable across same-key insertion order', () => {
  const a = validDoc();
  const b = validDoc();
  b.comparability = [...a.comparability].reverse();
  b.relations = [...a.relations].reverse();
  b.integrity = [...a.integrity].reverse();
  assert.equal(serializePhase0Contract(a), serializePhase0Contract(b));
  assert.equal(digestPhase0Contract(a), digestPhase0Contract(b));
});

test('optional obligation with unknown state and snapshot cannot certify', () => {
  const doc = bindControlIdentities(validDoc());
  doc.obligations.push({
    ...doc.obligations[0],
    id: 'obl-optional',
    required: false,
    outcome: 'unproven',
    state: 'state-missing',
    sourceSnapshot: 'snap-missing',
  });
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('invalid-id') || receipt.reasons.includes('dangling-endpoint'));
  assert.equal(JSON.stringify(receipt).includes('state-missing'), false);
});

test('required join bound to the wrong source-snapshot cannot certify', () => {
  const doc = bindControlIdentities(validDoc());
  doc.identities.push(snapshotIdentity('snap-src-other', OTHER_SHA));
  doc.obligations[0].sourceSnapshot = 'snap-src-other';
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('integrity-mismatch'));
});

test('StyleProof authority cannot declare product state', () => {
  const doc = validDoc();
  const product = doc.sourceRuns.find((run) => run.domain === 'product-state');
  product.authority = 'styleproof';
  product.producer = 'styleproof';
  if (doc.assertions?.[0]) {
    doc.assertions[0].producer = 'styleproof';
    doc.assertions[0].run = product.id;
  }
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.equal(receipt.axes.authority, 'invalid');
  assert.ok(receipt.reasons.includes('unauthorized-mode'));
});

test('consumer authority cannot emit observed capture evidence', () => {
  const doc = validDoc();
  const capture = doc.sourceRuns.find((run) => run.domain === 'capture-maps');
  capture.authority = 'consumer';
  capture.producer = 'checkout-app';
  doc.assertions.push({
    ...doc.assertions[0],
    id: 'assert-capture-observed',
    mode: 'observed',
    producer: 'checkout-app',
    producerVersion: capture.producerVersion,
    run: capture.id,
  });
  doc.identities.push(assertionIdentity('assert-capture-observed'));
  capture.factCount = 1;
  delete capture.emptyUniverseProof;
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.equal(receipt.axes.authority, 'invalid');
  assert.ok(receipt.reasons.includes('unauthorized-mode'));
});

test('comparable with missing-before cannot certify', () => {
  const doc = validDoc();
  doc.comparability = [
    {
      surface: 'checkout',
      status: 'comparable',
      required: true,
      reason: 'missing-before',
    },
  ];
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.equal(receipt.axes.comparability === 'valid', false);
});

test('not-required with explicit-state-match cannot certify', () => {
  const doc = validDoc();
  doc.comparability = [
    {
      surface: 'checkout',
      status: 'not-required',
      required: false,
      reason: 'explicit-state-match',
    },
  ];
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
});

test('incomparable with state-identity-missing cannot certify', () => {
  const doc = validDoc();
  doc.comparability = [
    {
      surface: 'checkout',
      status: 'incomparable',
      required: true,
      reason: 'state-identity-missing',
    },
  ];
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.equal(receipt.axes.comparability === 'valid', false);
});
