import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessPhase0Contract, parsePhase0Contract, Phase0ContractError } from '../dist/phase0-contract.js';
import { digestPhase0Contract, serializePhase0Contract } from '../dist/index.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/phase0-contract');

function loadFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

function validDoc() {
  return JSON.parse(loadFixture('valid-enumerated.json'));
}

function firstJoin(doc) {
  return Array.isArray(doc.integrity) ? doc.integrity[0] : doc.integrity;
}

function productStateIdentity(id, revision = 'rev-1') {
  return { id, layer: 'product-state', revision };
}

function assertionIdentity(id) {
  return { id, layer: 'assertion', assertionId: id };
}

test('absent document is absent-legacy and cannot certify', () => {
  const receipt = assessPhase0Contract();
  assert.equal(receipt.presence, 'absent-legacy');
  assert.equal(receipt.certifies, false);
  assert.equal(receipt.status, 'unproven');
  assert.equal(receipt.axes.integrity, 'unproven');
  assert.deepEqual(receipt.reasons, ['document-absent']);
  assert.notEqual(receipt.presence, 'present-invalid');
});

test('present-invalid empty object is distinct from absent-legacy and cannot certify', () => {
  const receipt = assessPhase0Contract({});
  assert.equal(receipt.presence, 'present-invalid');
  assert.equal(receipt.certifies, false);
  assert.equal(receipt.status, 'invalid');
  assert.equal(receipt.axes.integrity, 'invalid');
  assert.deepEqual(receipt.reasons, ['document-invalid']);
  assert.notEqual(receipt.presence, 'absent-legacy');
});

test('unknown field fails closed without echoing the hostile name', () => {
  const hostile = 'secret-token-value';
  const receipt = assessPhase0Contract({
    version: '0.1',
    documentId: 'doc-1',
    [hostile]: true,
  });
  assert.equal(receipt.certifies, false);
  assert.equal(receipt.presence, 'present-invalid');
  assert.ok(receipt.reasons.includes('unknown-field'));
  assert.equal(JSON.stringify(receipt).includes(hostile), false);
});

test('unknown enum fails closed without echoing the hostile value', () => {
  const hostile = 'guessed-from-dom';
  const digest = 'a'.repeat(64);
  const receipt = assessPhase0Contract({
    version: '0.1',
    documentId: 'doc-1',
    assertions: [
      {
        id: 'assert-1',
        mode: hostile,
        subject: 'state-1',
        predicate: 'status',
        object: 'ready',
        sourceDigest: digest,
        inputDigest: digest,
        producer: 'styleproof',
        producerVersion: '6.2.1',
        run: 'run-1',
        scope: 'checkout',
        validity: 'snap-1',
      },
    ],
  });
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('unknown-enum'));
  assert.equal(JSON.stringify(receipt).includes(hostile), false);
});

test('nested duplicate JSON key fails closed', () => {
  const bytes = '{"version":"0.1","documentId":"doc-1","integrity":{"sourceSha":"aa","sourceSha":"bb"}}';
  const receipt = parsePhase0Contract(bytes);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('duplicate-json-key'));
});

test('valid enumerated control certifies when every required axis is valid', () => {
  const receipt = parsePhase0Contract(loadFixture('valid-enumerated.json'));
  assert.equal(receipt.presence, 'present');
  assert.equal(receipt.certifies, true);
  assert.equal(receipt.status, 'valid');
  assert.equal(receipt.axes.integrity, 'valid');
  assert.equal(receipt.axes.envelopes, 'valid');
  assert.equal(receipt.axes.authority, 'valid');
  assert.equal(receipt.axes.execution, 'valid');
  assert.equal(receipt.axes.identity, 'valid');
  assert.equal(receipt.axes.comparability, 'valid');
  assert.equal(receipt.axes.completeness, 'valid');
  assert.equal(receipt.axes.provenance, 'valid');
  assert.deepEqual(receipt.reasons, []);
});

test('genuine one-sided addition without a relation remains not-required', () => {
  const doc = validDoc();
  doc.identities.push(productStateIdentity('state-pricing'));
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.axes.identity, 'valid');
  assert.equal(receipt.reasons.includes('missing-relation'), false);
  assert.equal(receipt.counts.relations, 0);
});

test('one-sided removal does not mint a relation or satisfy a required obligation', () => {
  const doc = validDoc();
  doc.comparability = [
    {
      surface: 'checkout',
      status: 'not-required',
      required: false,
      reason: 'missing-after',
    },
  ];
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.equal(receipt.axes.comparability, 'invalid');
  assert.ok(receipt.reasons.includes('comparability-mismatch'));
  assert.equal(receipt.axes.identity, 'valid');
  assert.equal(receipt.reasons.includes('missing-relation'), false);
});

test('similar names without an explicit relation do not mint an identity join', () => {
  const raw = loadFixture('missing-relation.json');
  const parsed = JSON.parse(raw);
  assert.deepEqual(parsed.relations, []);
  const receipt = parsePhase0Contract(raw);
  assert.equal(receipt.counts.relations, 0);
  assert.equal(receipt.axes.identity, 'valid');
  assert.equal(receipt.reasons.includes('missing-relation'), false);
  assert.equal(JSON.stringify(receipt).includes('rename'), false);
});

test('contradictory assertions coexist and block a required obligation', () => {
  const doc = validDoc();
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
  assert.equal(receipt.counts.assertions, 2);
  assert.equal(receipt.counts.contradictions >= 1, true);
  assert.equal(receipt.counts.blockedObligations >= 1, true);
  assert.ok(receipt.reasons.includes('contradiction-blocks-obligation'));
});

test('connector not-run is distinct from proved-empty and cannot certify', () => {
  const notRun = validDoc();
  notRun.sourceRuns[0].execution = 'not-run';
  notRun.sourceRuns[0].closure = 'unasserted';
  notRun.sourceRuns[0].factCount = 0;
  const notRunReceipt = assessPhase0Contract(notRun);
  assert.equal(notRunReceipt.certifies, false);
  assert.equal(notRunReceipt.presence, 'present');
  assert.ok(notRunReceipt.reasons.includes('connector-not-run'));
  assert.equal(notRunReceipt.axes.execution, 'unproven');

  const empty = validDoc();
  empty.sourceRuns[0].factCount = 0;
  empty.sourceRuns[0].emptyUniverseProof = true;
  const emptyReceipt = assessPhase0Contract(empty);
  assert.equal(emptyReceipt.certifies, true);
  assert.equal(emptyReceipt.presence, 'present');
  assert.equal(emptyReceipt.axes.completeness, 'valid');
  assert.equal(emptyReceipt.reasons.includes('connector-not-run'), false);
});

test('partial-prefix output cannot claim enumerated closure', () => {
  const doc = validDoc();
  doc.sourceRuns[0].execution = 'partial';
  doc.sourceRuns[0].closure = 'enumerated';
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('partial-enumerated'));
});

test('explicit rename split and merge cardinality plus illegal cycle and dangling controls', () => {
  const rename = validDoc();
  rename.identities.push(productStateIdentity('state-checkout-v2'));
  rename.relations = [{ kind: 'rename', from: ['state-checkout'], to: ['state-checkout-v2'] }];
  assert.equal(assessPhase0Contract(rename).axes.identity, 'valid');

  const split = validDoc();
  split.identities.push(productStateIdentity('state-a'), productStateIdentity('state-b'));
  split.relations = [{ kind: 'split', from: ['state-checkout'], to: ['state-a', 'state-b'] }];
  assert.equal(assessPhase0Contract(split).axes.identity, 'valid');

  const merge = validDoc();
  merge.identities.push(productStateIdentity('state-other'), productStateIdentity('state-combined'));
  merge.relations = [{ kind: 'merge', from: ['state-checkout', 'state-other'], to: ['state-combined'] }];
  assert.equal(assessPhase0Contract(merge).axes.identity, 'valid');

  const illegal = validDoc();
  illegal.identities.push(productStateIdentity('state-checkout-v2'), productStateIdentity('state-extra'));
  illegal.relations = [{ kind: 'rename', from: ['state-checkout'], to: ['state-checkout-v2', 'state-extra'] }];
  const illegalReceipt = assessPhase0Contract(illegal);
  assert.equal(illegalReceipt.certifies, false);
  assert.ok(illegalReceipt.reasons.includes('illegal-cardinality'));

  const dangling = validDoc();
  dangling.relations = [{ kind: 'rename', from: ['state-checkout'], to: ['state-missing'] }];
  const danglingReceipt = assessPhase0Contract(dangling);
  assert.equal(danglingReceipt.certifies, false);
  assert.ok(danglingReceipt.reasons.includes('dangling-endpoint'));

  const cycle = validDoc();
  cycle.identities.push(productStateIdentity('state-checkout-v2'));
  cycle.relations = [
    { kind: 'rename', from: ['state-checkout'], to: ['state-checkout-v2'] },
    { kind: 'rename', from: ['state-checkout-v2'], to: ['state-checkout'] },
  ];
  const cycleReceipt = assessPhase0Contract(cycle);
  assert.equal(cycleReceipt.certifies, false);
  assert.ok(cycleReceipt.reasons.includes('identity-cycle'));
});

test('one state with environment-specific outcomes cannot collapse', () => {
  const doc = validDoc();
  doc.obligations.push({
    ...doc.obligations[0],
    id: 'obl-webkit',
    environment: 'ab'.repeat(32),
    outcome: 'unproven',
  });
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.equal(receipt.counts.obligations, 2);
  assert.ok(receipt.reasons.includes('environment-unproven'));
  assert.equal(Object.hasOwn(receipt, 'stateStatus'), false);
});

test('cross-SHA integrity evidence fails closed', () => {
  const doc = validDoc();
  firstJoin(doc).sourceSha = 'abcdef0123456789abcdef0123456789abcdef01';
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.equal(receipt.axes.provenance, 'invalid');
  assert.ok(receipt.reasons.includes('integrity-mismatch'));
});

test('legacy no-pin remains unproven and cannot certify', () => {
  const doc = validDoc();
  doc.comparability = [
    {
      surface: 'checkout',
      status: 'unproven',
      required: true,
      reason: 'state-identity-missing',
    },
  ];
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.equal(receipt.axes.comparability, 'unproven');
  assert.ok(receipt.reasons.includes('legacy-unproven'));
});

test('certifiesFully is an unknown field and never promotes comparability', () => {
  const doc = validDoc();
  doc.certifiesFully = true;
  doc.comparability = [
    {
      surface: 'checkout',
      status: 'unproven',
      required: false,
      reason: 'state-identity-missing',
    },
  ];
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('unknown-field'));
  assert.equal(JSON.stringify(receipt).includes('certifiesFully'), false);
});

test('unreadable non-JSON bytes throw Phase0ContractError without echoing hostile text', () => {
  const hostile = 'password=super-secret';
  assert.throws(() => parsePhase0Contract(`{${hostile}`), Phase0ContractError);
  try {
    parsePhase0Contract(`{${hostile}`);
  } catch (error) {
    assert.equal(error instanceof Phase0ContractError, true);
    assert.equal(String(error).includes(hostile), false);
  }
});

test('complete-looking zero facts without empty-universe proof cannot certify', () => {
  const doc = validDoc();
  const capture = doc.sourceRuns.find((run) => run.domain === 'capture-maps');
  capture.factCount = 0;
  delete capture.emptyUniverseProof;
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('empty-universe-unproven'));
});

test('style-token comparability reason is unknown-enum and cannot mint comparable', () => {
  const doc = validDoc();
  doc.comparability[0].reason = 'style-token-match';
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('unknown-enum'));
  assert.equal(JSON.stringify(receipt).includes('style-token-match'), false);
});

test('missing one required domain cannot certify and does not echo domain values', () => {
  const doc = validDoc();
  doc.sourceRuns = doc.sourceRuns.filter((run) => run.domain !== 'coverage-ledger');
  assert.ok(doc.sourceRuns.length < 6);
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('missing-required-domain'));
  const dumped = JSON.stringify(receipt);
  assert.equal(dumped.includes('coverage-ledger'), false);
  assert.equal(dumped.includes('determinism'), false);
  assert.equal(dumped.includes('product-state'), false);
  assert.equal(dumped.includes('evidence-store'), false);
  assert.equal(dumped.includes('source-binding'), false);
  assert.equal(dumped.includes('capture-maps'), false);
});

test('duplicate required domain cannot certify and does not echo the domain', () => {
  const doc = validDoc();
  doc.sourceRuns.push({ ...doc.sourceRuns[0], id: 'run-capture-maps-dup' });
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('duplicate-domain'));
  assert.equal(JSON.stringify(receipt).includes('capture-maps'), false);
});

test('assertion with no matching source run cannot certify authority', () => {
  const doc = validDoc();
  doc.assertions[0].run = 'run-absent';
  firstJoin(doc).run = 'run-absent';
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.notEqual(receipt.axes.authority, 'valid');
  assert.ok(receipt.reasons.includes('unmatched-source-run'));
  assert.equal(JSON.stringify(receipt).includes('run-absent'), false);
});

test('mismatched producer version or run cannot certify authority', () => {
  const doc = validDoc();
  const bound = doc.sourceRuns.find((run) => run.id === doc.assertions[0].run) ?? doc.sourceRuns[0];
  bound.producer = 'other-producer';
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.equal(receipt.axes.authority, 'invalid');
  assert.ok(receipt.reasons.includes('producer-mismatch'));
  assert.equal(JSON.stringify(receipt).includes('other-producer'), false);
});

test('producer mode outside domain authority cannot certify', () => {
  const doc = validDoc();
  doc.assertions[0].mode = 'observed';
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.equal(receipt.axes.authority, 'invalid');
  assert.ok(receipt.reasons.includes('unauthorized-mode'));
  assert.equal(JSON.stringify(receipt).includes('observed'), false);
});

test('integrity join field mismatches cannot certify', () => {
  const digestB = 'ab'.repeat(32);
  const attacks = [
    ['manifestDigest', digestB],
    ['compatibilityKey', 'aaaaaaaaaaaaaaaa'],
    ['physicalCaptureKey', 'other-capture'],
    ['semanticStateId', 'state-unknown'],
    ['environmentDigest', digestB],
    ['sensorContract', 'other-sensor'],
  ];
  for (const [field, value] of attacks) {
    const doc = validDoc();
    firstJoin(doc)[field] = value;
    const receipt = assessPhase0Contract(doc);
    assert.equal(receipt.certifies, false, field);
    assert.equal(receipt.axes.provenance, 'invalid', field);
    assert.ok(receipt.reasons.includes('integrity-mismatch'), field);
    assert.equal(JSON.stringify(receipt).includes(String(value)), false, field);
  }
});

test('capture-maps output digest must equal join manifest digest', () => {
  const doc = validDoc();
  const capture = doc.sourceRuns.find((run) => run.domain === 'capture-maps');
  capture.outputDigest = 'aa'.repeat(32);
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.equal(receipt.axes.provenance, 'invalid');
  assert.ok(receipt.reasons.includes('integrity-mismatch'));
});

test('compatibility keys across runs and join must match', () => {
  const doc = validDoc();
  for (const run of doc.sourceRuns) run.compatibilityKey = '0000000000000000';
  firstJoin(doc).compatibilityKey = 'aaaaaaaaaaaaaaaa';
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('integrity-mismatch'));
  assert.equal(JSON.stringify(receipt).includes('aaaaaaaaaaaaaaaa'), false);
});

test('artifactDigests cannot silently omit credited source or assertion digests', () => {
  const doc = validDoc();
  firstJoin(doc).artifactDigests = [firstJoin(doc).manifestDigest];
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.equal(receipt.axes.provenance, 'invalid');
  assert.ok(receipt.reasons.includes('integrity-mismatch'));
});

test('second required satisfied obligation without its own join cannot certify', () => {
  const doc = validDoc();
  doc.obligations.push({ ...doc.obligations[0], id: 'obl-2', surface: 'pricing' });
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('missing-join'));
});

test('extra integrity join cannot certify', () => {
  const doc = validDoc();
  const extra = { ...firstJoin(doc), obligationId: 'obl-extra' };
  doc.integrity = Array.isArray(doc.integrity) ? [...doc.integrity, extra] : [firstJoin(doc), extra];
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('extra-join'));
  assert.equal(JSON.stringify(receipt).includes('obl-extra'), false);
});

test('duplicate join for one obligation cannot certify', () => {
  const doc = validDoc();
  const join = { ...firstJoin(doc), obligationId: doc.obligations[0].id };
  doc.integrity = [join, { ...join }];
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('duplicate-join'));
});

test('canonical digest is independent of insertion order', () => {
  const a = validDoc();
  const b = validDoc();
  b.assertions = [...a.assertions].reverse();
  b.sourceRuns = [...a.sourceRuns].reverse();
  b.identities = [...a.identities].reverse();
  b.obligations = [...a.obligations].reverse();
  b.comparability = [...a.comparability].reverse();
  b.integrity = [...a.integrity].reverse();
  b.relations = [...a.relations].reverse();
  for (const run of b.sourceRuns) run.capabilities = [...run.capabilities].reverse();
  for (const join of b.integrity) join.artifactDigests = [...join.artifactDigests].reverse();
  assert.equal(serializePhase0Contract(a), serializePhase0Contract(b));
  assert.equal(digestPhase0Contract(a), digestPhase0Contract(b));
});

test('duplicate ids are rejected rather than canonicalized away', () => {
  const doc = validDoc();
  doc.assertions.push({ ...doc.assertions[0] });
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('duplicate-id'));
  assert.notEqual(serializePhase0Contract(validDoc()), serializePhase0Contract(doc));
});

test('required obligation must reference a product-state identity', () => {
  const doc = validDoc();
  doc.obligations[0].state = 'evidence-checkout';
  firstJoin(doc).semanticStateId = 'evidence-checkout';
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.equal(receipt.axes.provenance, 'invalid');
  assert.ok(receipt.reasons.includes('integrity-mismatch'));
});

test('merge onto an existing from identity is a cycle', () => {
  const doc = validDoc();
  doc.identities.push(productStateIdentity('state-other'));
  doc.relations = [{ kind: 'merge', from: ['state-checkout', 'state-other'], to: ['state-checkout'] }];
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('identity-cycle'));
});

test('closed reasons are sorted and deduped', () => {
  const doc = validDoc();
  doc.sourceRuns.push({ ...doc.sourceRuns[0], id: 'run-capture-maps-dup' });
  doc.sourceRuns = doc.sourceRuns.filter((run) => run.domain !== 'determinism');
  const receipt = assessPhase0Contract(doc);
  assert.deepEqual(receipt.reasons, [...receipt.reasons].sort());
  assert.equal(receipt.reasons.length, new Set(receipt.reasons).size);
});

test('named connector-not-run fixture cannot certify', () => {
  const receipt = parsePhase0Contract(loadFixture('connector-not-run.json'));
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('connector-not-run'));
  assert.equal(receipt.axes.execution, 'unproven');
});

test('named empty-universe fixture certifies only with proof', () => {
  const receipt = parsePhase0Contract(loadFixture('empty-universe-proof.json'));
  assert.equal(receipt.certifies, true);
  assert.equal(receipt.axes.completeness, 'valid');
});

test('named legacy-unproven fixture remains unproven', () => {
  const receipt = parsePhase0Contract(loadFixture('legacy-unproven.json'));
  assert.equal(receipt.certifies, false);
  assert.equal(receipt.axes.comparability, 'unproven');
  assert.ok(receipt.reasons.includes('legacy-unproven'));
});

test('named unauthorized-mode fixture cannot certify', () => {
  const receipt = parsePhase0Contract(loadFixture('unauthorized-mode.json'));
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('unauthorized-mode'));
});

test('named partial-prefix fixture cannot claim enumerated closure', () => {
  const receipt = parsePhase0Contract(loadFixture('partial-prefix.json'));
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('partial-enumerated'));
});

test('named contradictory-assertions fixture blocks the obligation', () => {
  const receipt = parsePhase0Contract(loadFixture('contradictory-assertions.json'));
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('contradiction-blocks-obligation'));
});

test('named valid rename split and merge fixtures keep identity valid', () => {
  for (const name of ['valid-rename.json', 'valid-split.json', 'valid-merge.json']) {
    const receipt = parsePhase0Contract(loadFixture(name));
    assert.equal(receipt.axes.identity, 'valid', name);
    assert.equal(receipt.certifies, true, name);
  }
});

test('named environment-unproven fixture cannot collapse outcomes', () => {
  const receipt = parsePhase0Contract(loadFixture('environment-unproven.json'));
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('environment-unproven'));
});

test('named cross-sha fixture cannot certify', () => {
  const receipt = parsePhase0Contract(loadFixture('cross-sha.json'));
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('integrity-mismatch'));
});

test('named present-invalid and unknown-field and duplicate-key controls fail closed', () => {
  const invalid = parsePhase0Contract(loadFixture('present-invalid.json'));
  assert.equal(invalid.presence, 'present-invalid');
  assert.equal(invalid.certifies, false);
  const unknown = parsePhase0Contract(loadFixture('unknown-field.json'));
  assert.ok(unknown.reasons.includes('unknown-field'));
  assert.equal(JSON.stringify(unknown).includes('certifiesFully'), false);
  const dup = parsePhase0Contract(loadFixture('duplicate-json-key.json'));
  assert.ok(dup.reasons.includes('duplicate-json-key'));
});
