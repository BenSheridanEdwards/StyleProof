import assert from 'node:assert/strict';
import test from 'node:test';
import { digestApprovalReceipt, StyleProofApprovalReceiptError } from '../dist/approval-receipt.js';

const digest = (character) => character.repeat(64);
const sha = (character) => character.repeat(40);

function validReceipt(overrides = {}) {
  return {
    headSha: sha('b'),
    baseSha: sha('a'),
    baseManifestDigest: digest('1'),
    headManifestDigest: digest('2'),
    releaseConfidenceDigest: digest('3'),
    policyDigest: digest('4'),
    producer: { name: 'styleproof', version: '6.2.2' },
    statusContext: 'StyleProof',
    trustState: 'STYLE_REVIEW_REQUIRED',
    ...overrides,
  };
}

test('approval receipt digest is canonical and binds every trust-controlling input', () => {
  const control = validReceipt();
  const canonical = digestApprovalReceipt(control);
  assert.match(canonical, /^[0-9a-f]{64}$/);

  const reordered = {
    trustState: control.trustState,
    statusContext: control.statusContext,
    producer: { version: '6.2.2', name: 'styleproof' },
    policyDigest: control.policyDigest,
    releaseConfidenceDigest: control.releaseConfidenceDigest,
    headManifestDigest: control.headManifestDigest,
    baseManifestDigest: control.baseManifestDigest,
    baseSha: control.baseSha,
    headSha: control.headSha,
  };
  assert.equal(digestApprovalReceipt(reordered), canonical);

  const mutations = [
    { headSha: sha('c') },
    { baseSha: sha('c') },
    { baseManifestDigest: digest('5') },
    { headManifestDigest: digest('5') },
    { releaseConfidenceDigest: digest('5') },
    { policyDigest: digest('5') },
    { producer: { name: 'styleproof', version: '6.2.3' } },
    { statusContext: 'StyleProof strict' },
  ];
  for (const mutation of mutations) {
    assert.notEqual(digestApprovalReceipt(validReceipt(mutation)), canonical, JSON.stringify(mutation));
  }
  assert.notEqual(
    digestApprovalReceipt(validReceipt({ headSha: control.baseSha, baseSha: control.headSha })),
    canonical,
  );
});

test('approval receipt rejects unapprovable, malformed, and open objects', () => {
  const invalid = [
    validReceipt({ headSha: 'short' }),
    validReceipt({ baseSha: sha('A') }),
    validReceipt({ releaseConfidenceDigest: 'not-a-digest' }),
    validReceipt({ producer: { name: 'other', version: '6.2.2' } }),
    validReceipt({ producer: { name: 'styleproof', version: '' } }),
    validReceipt({ statusContext: '' }),
    validReceipt({ trustState: 'CERTIFICATION_FAILED' }),
    { ...validReceipt(), publicationSha: sha('c') },
    Object.assign(Object.create({ inherited: true }), validReceipt()),
    new Proxy(validReceipt(), {}),
  ];
  const accessor = validReceipt();
  Object.defineProperty(accessor, 'policyDigest', { enumerable: true, get: () => digest('4') });
  invalid.push(accessor);

  for (const value of invalid) {
    assert.throws(() => digestApprovalReceipt(value), StyleProofApprovalReceiptError);
  }
});
