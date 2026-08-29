import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessPhase0Contract, parsePhase0Contract, Phase0ContractError } from '../dist/phase0-contract.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/phase0-contract');

function validDoc() {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, 'valid-enumerated.json'), 'utf8'));
}

function assertionIdentity(id) {
  return { id, layer: 'assertion', assertionId: id };
}

function productRun(doc) {
  return doc.sourceRuns.find((run) => run.domain === 'product-state');
}

function addAssertion(doc, id, fields) {
  doc.assertions.push({ ...doc.assertions[0], id, ...fields });
  doc.identities.push(assertionIdentity(id));
}

test('pricing-scope contradiction does not block a checkout obligation', () => {
  const doc = validDoc();
  addAssertion(doc, 'assert-pricing-ready', { scope: 'pricing', object: 'ready' });
  addAssertion(doc, 'assert-pricing-loading', { scope: 'pricing', object: 'loading' });
  productRun(doc).factCount = 3;
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.counts.contradictions, 1);
  assert.equal(receipt.counts.blockedObligations, 0);
  assert.equal(receipt.reasons.includes('contradiction-blocks-obligation'), false);
});

test('same checkout snapshot contradiction still blocks the required obligation', () => {
  const doc = validDoc();
  addAssertion(doc, 'assert-checkout-loading', { object: 'loading' });
  productRun(doc).factCount = 2;
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.equal(receipt.counts.contradictions, 1);
  assert.equal(receipt.counts.blockedObligations, 1);
  assert.ok(receipt.reasons.includes('contradiction-blocks-obligation'));
});

test('contradiction count is bounded tuples not collapsed subjects', () => {
  const doc = validDoc();
  addAssertion(doc, 'assert-checkout-loading', { object: 'loading' });
  addAssertion(doc, 'assert-pricing-ready', { scope: 'pricing', object: 'ready' });
  addAssertion(doc, 'assert-pricing-loading', { scope: 'pricing', object: 'loading' });
  productRun(doc).factCount = 4;
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.counts.contradictions, 2);
  assert.equal(receipt.counts.blockedObligations, 1);
  assert.ok(receipt.reasons.includes('contradiction-blocks-obligation'));
});

test('source-snapshot to product-state relation cannot certify', () => {
  const doc = validDoc();
  doc.relations = [{ kind: 'rename', from: ['snap-src-1'], to: ['state-checkout'] }];
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.equal(receipt.axes.identity, 'invalid');
  assert.ok(receipt.reasons.includes('dangling-endpoint'));
});

test('assertion to evidence relation cannot certify', () => {
  const doc = validDoc();
  doc.relations = [{ kind: 'rename', from: ['assert-checkout-ready'], to: ['evidence-checkout'] }];
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.equal(receipt.axes.identity, 'invalid');
  assert.ok(receipt.reasons.includes('dangling-endpoint'));
});

test('named valid rename split and merge fixtures stay identity-valid', () => {
  for (const name of ['valid-rename.json', 'valid-split.json', 'valid-merge.json']) {
    const receipt = parsePhase0Contract(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
    assert.equal(receipt.axes.identity, 'valid', name);
    assert.equal(receipt.certifies, true, name);
  }
});

test('duplicate source-run capability cannot certify', () => {
  const doc = validDoc();
  doc.sourceRuns[0].capabilities = ['computed-style', 'computed-style'];
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('duplicate-id'));
});

test('emptyUniverseProof with positive factCount cannot certify', () => {
  const doc = validDoc();
  const product = productRun(doc);
  product.emptyUniverseProof = true;
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('empty-universe-conflict'));
});

test('zero facts with emptyUniverseProof and positive facts without proof remain valid', () => {
  const receipt = assessPhase0Contract(validDoc());
  assert.equal(receipt.certifies, true);
  const capture = validDoc().sourceRuns.find((run) => run.domain === 'capture-maps');
  const product = productRun(validDoc());
  assert.equal(capture.factCount, 0);
  assert.equal(capture.emptyUniverseProof, true);
  assert.equal(product.factCount, 1);
  assert.equal(product.emptyUniverseProof, undefined);
});

function mutateRun(execution, closure) {
  const doc = validDoc();
  doc.sourceRuns[0].execution = execution;
  doc.sourceRuns[0].closure = closure;
  return assessPhase0Contract(doc);
}

function assertRunState(receipt, status, reasons) {
  assert.equal(receipt.certifies, false);
  assert.equal(receipt.axes.execution, status);
  assert.equal(receipt.axes.completeness, status);
  assert.equal(receipt.axes.execution, receipt.axes.completeness);
  for (const reason of reasons) assert.ok(receipt.reasons.includes(reason), reason);
  assert.notEqual(receipt.reasons.length, 0);
}

test('failed run is invalid with connector-failed', () => {
  assertRunState(mutateRun('failed', 'unasserted'), 'invalid', ['connector-failed']);
});

test('failed enumerated run is invalid with connector-failed and partial-enumerated', () => {
  assertRunState(mutateRun('failed', 'enumerated'), 'invalid', ['connector-failed', 'partial-enumerated']);
});

test('unsupported run is unproven with connector-unsupported', () => {
  assertRunState(mutateRun('unsupported', 'unasserted'), 'unproven', ['connector-unsupported']);
});

test('unsupported enumerated run remains invalid', () => {
  assertRunState(mutateRun('unsupported', 'enumerated'), 'invalid', ['partial-enumerated']);
});

test('not-run enumerated run remains invalid', () => {
  assertRunState(mutateRun('not-run', 'enumerated'), 'invalid', ['partial-enumerated']);
});

test('partial run with partial closure is unproven with connector-partial', () => {
  assertRunState(mutateRun('partial', 'partial'), 'unproven', ['connector-partial']);
});

test('partial run with unasserted closure is unproven with connector-partial', () => {
  assertRunState(mutateRun('partial', 'unasserted'), 'unproven', ['connector-partial']);
});

test('complete run with partial closure is unproven with closure-partial', () => {
  assertRunState(mutateRun('complete', 'partial'), 'unproven', ['closure-partial']);
});

test('complete run with unasserted closure is unproven with closure-unasserted', () => {
  assertRunState(mutateRun('complete', 'unasserted'), 'unproven', ['closure-unasserted']);
});

test('assertion scope differing from its resolved run cannot certify authority', () => {
  const doc = validDoc();
  doc.assertions[0].scope = 'pricing';
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.notEqual(receipt.axes.authority, 'valid');
  assert.ok(receipt.reasons.includes('scope-mismatch'));
  assert.equal(JSON.stringify(receipt).includes('pricing'), false);
});

test('capture run scope differing from bound obligation surface cannot certify provenance', () => {
  const doc = validDoc();
  const capture = doc.sourceRuns.find((run) => run.domain === 'capture-maps');
  capture.scope = 'pricing';
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.equal(receipt.axes.provenance, 'invalid');
  assert.ok(receipt.reasons.includes('integrity-mismatch'));
  assert.equal(JSON.stringify(receipt).includes('pricing'), false);
});

test('uncredited domain run scope may differ from the obligation surface', () => {
  const doc = validDoc();
  const coverage = doc.sourceRuns.find((run) => run.domain === 'coverage-ledger');
  coverage.scope = 'pricing';
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, true);
  assert.equal(receipt.axes.provenance, 'valid');
});

test('credited source-run configDigest must be in the exact artifact set', () => {
  const doc = validDoc();
  const fresh = 'cd'.repeat(32);
  doc.sourceRuns[0].configDigest = fresh;
  const receipt = assessPhase0Contract(doc);
  assert.equal(receipt.certifies, false);
  assert.equal(receipt.axes.provenance, 'invalid');
  assert.ok(receipt.reasons.includes('integrity-mismatch'));
  assert.equal(JSON.stringify(receipt).includes(fresh), false);
});

const MAX_JSON_DEPTH = 64;

function nestedJson(depth) {
  let json = '0';
  for (let i = 0; i < depth; i++) json = `{"n":${json}}`;
  return json;
}

test('JSON nesting at the accepted depth bound does not throw', () => {
  const receipt = parsePhase0Contract(nestedJson(MAX_JSON_DEPTH));
  assert.equal(receipt.presence, 'present-invalid');
  assert.equal(receipt.certifies, false);
});

test('JSON nesting one past the depth bound throws a privacy-safe Phase0ContractError', () => {
  const source = nestedJson(MAX_JSON_DEPTH + 1);
  assert.throws(() => parsePhase0Contract(source), Phase0ContractError);
  try {
    parsePhase0Contract(source);
  } catch (error) {
    assert.equal(error instanceof Phase0ContractError, true);
    assert.equal(error instanceof RangeError, false);
    assert.equal(String(error).includes(source), false);
    assert.equal(String(error).includes('{'), false);
  }
});

test('nested duplicate JSON key fixture stays present-invalid', () => {
  const receipt = parsePhase0Contract(fs.readFileSync(path.join(FIXTURES, 'duplicate-json-key.json'), 'utf8'));
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('duplicate-json-key'));
});
