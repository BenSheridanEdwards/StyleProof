import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createReleaseConfidenceManifest,
  digestReleaseConfidenceManifest,
  parseReleaseConfidenceManifest,
  ReleaseConfidenceManifestError,
  serializeReleaseConfidenceManifest,
  validateReleaseConfidenceManifest,
} from '../dist/release-confidence-manifest.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/phase0-contract/valid-enumerated.json',
);
const LEGACY_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/phase0-contract/legacy-unproven.json',
);

function validContract() {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
}

test('legacy contract stays present and non-certifying through manifest round-trip', () => {
  const contract = JSON.parse(fs.readFileSync(LEGACY_FIXTURE, 'utf8'));
  const manifest = createReleaseConfidenceManifest({
    manifestId: 'rcm-legacy',
    producerVersion: '6.2.2',
    releaseScope: 'release-legacy',
    contract,
  });
  const parsed = parseReleaseConfidenceManifest(serializeReleaseConfidenceManifest(manifest));
  const receipt = validateReleaseConfidenceManifest(parsed);
  assert.equal(receipt.presence, 'present');
  assert.equal(receipt.certifies, false);
  assert.ok(receipt.reasons.includes('legacy-unproven'));
});

test('duplicate derived summary ids cannot collapse into a certifying set', () => {
  const contract = validContract();
  contract.assertions[0].mode = 'excluded';
  const manifest = createReleaseConfidenceManifest({
    manifestId: 'rcm-duplicate-summary',
    producerVersion: '6.2.2',
    releaseScope: 'release-control',
    contract,
  });
  manifest.exclusions.push(manifest.exclusions[0]);
  manifest.manifestDigest = digestReleaseConfidenceManifest(manifest);
  const receipt = validateReleaseConfidenceManifest(manifest);
  assert.equal(receipt.presence, 'present-invalid');
  assert.deepEqual(receipt.reasons, ['manifest-projection-mismatch']);
});

test('Unicode-equivalent duplicate JSON keys hard-fail', () => {
  const manifest = createReleaseConfidenceManifest({
    manifestId: 'rcm-unicode-duplicate',
    producerVersion: '6.2.2',
    releaseScope: 'release-control',
    contract: validContract(),
  });
  const bytes = serializeReleaseConfidenceManifest(manifest).replace(
    '"kind":"styleproof.release-confidence"',
    '"k\\u0069nd":"styleproof.release-confidence","kind":"styleproof.release-confidence"',
  );
  assert.throws(() => parseReleaseConfidenceManifest(bytes), ReleaseConfidenceManifestError);
});

test('canonical bytes and digest ignore semantically unordered insertion order', () => {
  const manifest = createReleaseConfidenceManifest({
    manifestId: 'rcm-canonical',
    producerVersion: '6.2.2',
    releaseScope: 'release-control',
    contract: validContract(),
  });
  const permuted = structuredClone(manifest);
  for (const field of [
    'identities',
    'assertions',
    'sourceRuns',
    'obligations',
    'relations',
    'comparability',
    'evidenceJoins',
    'exclusions',
  ]) {
    permuted[field].reverse();
  }
  for (const run of permuted.sourceRuns) run.capabilities.reverse();
  for (const join of permuted.evidenceJoins) join.artifactDigests.reverse();
  permuted.declaredScope.surfaces.reverse();
  permuted.gaps.sourceRuns.reverse();
  permuted.gaps.obligations.reverse();
  permuted.gaps.comparability.reverse();

  assert.equal(digestReleaseConfidenceManifest(permuted), manifest.manifestDigest);
  assert.equal(validateReleaseConfidenceManifest(permuted).certifies, true);
  assert.equal(serializeReleaseConfidenceManifest(permuted), serializeReleaseConfidenceManifest(manifest));
});

test('Phase 0 array iterators cannot split assessment from manifest digest', () => {
  for (const field of ['identities', 'assertions', 'sourceRuns']) {
    const manifest = createReleaseConfidenceManifest({
      manifestId: `rcm-contract-array-${field}`,
      producerVersion: '6.2.2',
      releaseScope: 'release-control',
      contract: validContract(),
    });
    Object.defineProperty(manifest[field], Symbol.iterator, {
      value: function* emptyIterator() {},
    });
    assert.throws(() => digestReleaseConfidenceManifest(manifest), ReleaseConfidenceManifestError, field);
    const receipt = validateReleaseConfidenceManifest(manifest);
    assert.equal(receipt.presence, 'present-invalid', field);
    assert.equal(receipt.certifies, false, field);
  }
});

test('accessors and iterator-lying envelope arrays are present-invalid', () => {
  const fresh = () =>
    createReleaseConfidenceManifest({
      manifestId: 'rcm-own-data',
      producerVersion: '6.2.2',
      releaseScope: 'release-control',
      contract: validContract(),
    });

  const topAccessor = fresh();
  Object.defineProperty(topAccessor, 'kind', { enumerable: true, get: () => 'styleproof.release-confidence' });
  const producerAccessor = fresh();
  Object.defineProperty(producerAccessor.producer, 'name', { enumerable: true, get: () => 'styleproof' });

  const lyingScope = fresh();
  lyingScope.declaredScope.surfaces[0] = 'evil-surface';
  Object.defineProperty(lyingScope.declaredScope.surfaces, Symbol.iterator, {
    value: function* honestIterator() {
      yield 'checkout';
    },
  });

  const lyingExclusions = fresh();
  lyingExclusions.exclusions.push('evil-exclusion');
  Object.defineProperty(lyingExclusions.exclusions, Symbol.iterator, {
    value: function* emptyIterator() {},
  });

  const lyingGaps = fresh();
  lyingGaps.gaps.sourceRuns.push('evil-gap');
  Object.defineProperty(lyingGaps.gaps.sourceRuns, Symbol.iterator, {
    value: function* emptyIterator() {},
  });

  for (const candidate of [topAccessor, producerAccessor, lyingScope, lyingExclusions, lyingGaps]) {
    const receipt = validateReleaseConfidenceManifest(candidate);
    assert.equal(receipt.presence, 'present-invalid');
    assert.equal(receipt.certifies, false);
  }
});

test('reflective envelope objects and arrays are present-invalid even when traps look honest', () => {
  const fresh = () =>
    createReleaseConfidenceManifest({
      manifestId: 'rcm-reflective',
      producerVersion: '6.2.2',
      releaseScope: 'release-control',
      contract: validContract(),
    });
  const cases = [];
  const top = fresh();
  cases.push(new Proxy(top, {}));
  const producer = fresh();
  producer.producer = new Proxy(producer.producer, {});
  cases.push(producer);
  const scope = fresh();
  scope.declaredScope = new Proxy(scope.declaredScope, {});
  cases.push(scope);
  const gaps = fresh();
  gaps.gaps = new Proxy(gaps.gaps, {});
  cases.push(gaps);
  const exclusions = fresh();
  exclusions.exclusions = new Proxy(exclusions.exclusions, {});
  cases.push(exclusions);
  const gapArray = fresh();
  gapArray.gaps.sourceRuns = new Proxy(gapArray.gaps.sourceRuns, {});
  cases.push(gapArray);
  const scopeArray = fresh();
  scopeArray.declaredScope.surfaces = new Proxy(scopeArray.declaredScope.surfaces, {});
  cases.push(scopeArray);
  for (const candidate of cases) {
    const receipt = validateReleaseConfidenceManifest(candidate);
    assert.equal(receipt.presence, 'present-invalid');
    assert.equal(receipt.certifies, false);
  }
});

test('nested reflective Phase 0 records are present-invalid even when traps look honest', () => {
  for (const field of ['identities', 'assertions', 'sourceRuns', 'obligations', 'comparability', 'evidenceJoins']) {
    const manifest = createReleaseConfidenceManifest({
      manifestId: `rcm-nested-reflective-${field}`,
      producerVersion: '6.2.2',
      releaseScope: 'release-control',
      contract: validContract(),
    });
    manifest[field][0] = new Proxy(manifest[field][0], {});
    const receipt = validateReleaseConfidenceManifest(manifest);
    assert.equal(receipt.presence, 'present-invalid', field);
    assert.equal(receipt.certifies, false, field);
  }
});

test('hostile programmatic objects return one closed invalid receipt without leaking attacker text', () => {
  const secret = 'private-token-material';
  const manifest = createReleaseConfidenceManifest({
    manifestId: 'rcm-hostile',
    producerVersion: '6.2.2',
    releaseScope: 'release-control',
    contract: validContract(),
  });
  Object.defineProperty(manifest, 'kind', {
    enumerable: true,
    configurable: true,
    get() {
      throw new Error(secret);
    },
  });

  let receipt;
  assert.doesNotThrow(() => {
    receipt = validateReleaseConfidenceManifest(manifest);
  });
  assert.deepEqual(receipt, {
    presence: 'present-invalid',
    certifies: false,
    status: 'invalid',
    reasons: ['manifest-invalid'],
  });
  assert.equal(JSON.stringify(receipt).includes(secret), false);

  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.doesNotThrow(() => validateReleaseConfidenceManifest(revoked.proxy));
  assert.deepEqual(validateReleaseConfidenceManifest(revoked.proxy), receipt);
});

test('duplicate JSON keys hard-fail even when JSON.parse would collapse to valid bytes', () => {
  const manifest = createReleaseConfidenceManifest({
    manifestId: 'rcm-duplicate',
    producerVersion: '6.2.2',
    releaseScope: 'release-control',
    contract: validContract(),
  });
  const bytes = serializeReleaseConfidenceManifest(manifest).replace(
    '"manifestId":"rcm-duplicate"',
    '"manifestId":"rcm-duplicate","manifestId":"rcm-duplicate"',
  );
  assert.throws(() => parseReleaseConfidenceManifest(bytes), ReleaseConfidenceManifestError);
});

test('oversized manifest bytes fail before UTF-8 decoding', () => {
  const original = TextDecoder.prototype.decode;
  let decoded = false;
  TextDecoder.prototype.decode = function decodeOversize(...args) {
    decoded = true;
    return original.apply(this, args);
  };
  try {
    const bytes = new Uint8Array(16 * 1024 * 1024 + 1);
    assert.throws(() => parseReleaseConfidenceManifest(bytes), ReleaseConfidenceManifestError);
    assert.equal(decoded, false);
  } finally {
    TextDecoder.prototype.decode = original;
  }
});

test('typed-array subclass cannot lie about byte length before decoding', () => {
  class LyingBytes extends Uint8Array {
    get byteLength() {
      return 0;
    }
  }
  const original = TextDecoder.prototype.decode;
  let decoded = false;
  TextDecoder.prototype.decode = function decodeOversize(...args) {
    decoded = true;
    return original.apply(this, args);
  };
  try {
    const bytes = new LyingBytes(16 * 1024 * 1024 + 1);
    assert.throws(() => parseReleaseConfidenceManifest(bytes), ReleaseConfidenceManifestError);
    assert.equal(decoded, false);
  } finally {
    TextDecoder.prototype.decode = original;
  }
});

test('exports the manifest kernel from the package root', async () => {
  const root = await import('../dist/index.js');
  for (const name of [
    'createReleaseConfidenceManifest',
    'digestReleaseConfidenceManifest',
    'parseReleaseConfidenceManifest',
    'serializeReleaseConfidenceManifest',
    'validateReleaseConfidenceManifest',
    'ReleaseConfidenceManifestError',
  ]) {
    assert.equal(typeof root[name], name.endsWith('Error') ? 'function' : 'function', name);
  }
});

test('derives exclusions and unresolved obligation/comparability gaps from the contract', () => {
  const excludedContract = validContract();
  excludedContract.assertions[0].mode = 'excluded';
  const excluded = createReleaseConfidenceManifest({
    manifestId: 'rcm-excluded',
    producerVersion: '6.2.2',
    releaseScope: 'release-control',
    contract: excludedContract,
  });
  assert.deepEqual(excluded.exclusions, ['assert-checkout-ready']);

  const obligationContract = validContract();
  const obligationId = obligationContract.obligations[0].id;
  obligationContract.obligations[0].outcome = 'unproven';
  const obligationGap = createReleaseConfidenceManifest({
    manifestId: 'rcm-obligation-gap',
    producerVersion: '6.2.2',
    releaseScope: 'release-control',
    contract: obligationContract,
  });
  assert.deepEqual(obligationGap.gaps.obligations, [obligationId]);
  assert.equal(validateReleaseConfidenceManifest(obligationGap).certifies, false);

  const comparabilityContract = validContract();
  comparabilityContract.comparability[0] = {
    surface: 'checkout',
    status: 'unproven',
    required: true,
    reason: 'state-identity-missing',
  };
  const comparabilityGap = createReleaseConfidenceManifest({
    manifestId: 'rcm-comparability-gap',
    producerVersion: '6.2.2',
    releaseScope: 'release-control',
    contract: comparabilityContract,
  });
  assert.deepEqual(comparabilityGap.gaps.comparability, ['checkout']);
  assert.equal(validateReleaseConfidenceManifest(comparabilityGap).certifies, false);
});

test('partial source runs remain present gaps and never certify', () => {
  const contract = validContract();
  contract.sourceRuns[0].execution = 'partial';
  contract.sourceRuns[0].closure = 'partial';
  const manifest = createReleaseConfidenceManifest({
    manifestId: 'rcm-partial',
    producerVersion: '6.2.2',
    releaseScope: 'release-control',
    contract,
  });

  assert.deepEqual(manifest.gaps.sourceRuns, ['run-capture-maps']);
  const receipt = validateReleaseConfidenceManifest(manifest);
  assert.equal(receipt.presence, 'present');
  assert.equal(receipt.certifies, false);
  assert.equal(receipt.status, 'unproven');
  assert.ok(receipt.reasons.includes('connector-partial'));
});

test('unknown fields remain present-invalid even with a recomputed digest', () => {
  for (const mutate of [
    (manifest) => {
      manifest.futurePolicy = 'allow';
    },
    (manifest) => {
      manifest.producer.futureName = 'other';
    },
  ]) {
    const manifest = createReleaseConfidenceManifest({
      manifestId: 'rcm-unknown-field',
      producerVersion: '6.2.2',
      releaseScope: 'release-control',
      contract: validContract(),
    });
    mutate(manifest);
    manifest.manifestDigest = digestReleaseConfidenceManifest(manifest);

    const receipt = validateReleaseConfidenceManifest(manifest);
    assert.equal(receipt.presence, 'present-invalid');
    assert.equal(receipt.certifies, false);
    assert.deepEqual(receipt.reasons, ['manifest-invalid']);
  }
});

test('stale manifest digest is present-invalid and parser hard-fails', () => {
  const manifest = createReleaseConfidenceManifest({
    manifestId: 'rcm-stale',
    producerVersion: '6.2.2',
    releaseScope: 'release-control',
    contract: validContract(),
  });
  manifest.manifestDigest = 'f'.repeat(64);

  const receipt = validateReleaseConfidenceManifest(manifest);
  assert.equal(receipt.presence, 'present-invalid');
  assert.equal(receipt.status, 'invalid');
  assert.equal(receipt.certifies, false);
  assert.deepEqual(receipt.reasons, ['manifest-digest-mismatch']);
  assert.throws(() => parseReleaseConfidenceManifest(JSON.stringify(manifest)));
});

test('projects a certifying Phase 0 contract into one exact-source v0.1 manifest', () => {
  const manifest = createReleaseConfidenceManifest({
    manifestId: 'rcm-control',
    producerVersion: '6.2.2',
    releaseScope: 'release-control',
    contract: validContract(),
  });

  assert.equal(manifest.kind, 'styleproof.release-confidence');
  assert.equal(manifest.version, '0.1');
  assert.deepEqual(manifest.producer, { name: 'styleproof', version: '6.2.2' });
  assert.equal(manifest.sourceSha, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(manifest.compatibilityKey, '0000000000000000');
  assert.deepEqual(manifest.declaredScope, { id: 'release-control', surfaces: ['checkout'] });
  assert.equal(manifest.assertions.length, 1);
  assert.equal(manifest.obligations.length, 1);
  assert.equal(manifest.evidenceJoins.length, 1);
  assert.deepEqual(manifest.exclusions, []);
  assert.deepEqual(manifest.gaps, { sourceRuns: [], obligations: [], comparability: [] });
  assert.match(manifest.manifestDigest, /^[0-9a-f]{64}$/);
  assert.equal(manifest.manifestDigest, digestReleaseConfidenceManifest(manifest));

  const bytes = serializeReleaseConfidenceManifest(manifest);
  const parsed = parseReleaseConfidenceManifest(bytes);
  assert.deepEqual(parsed, manifest);

  const receipt = validateReleaseConfidenceManifest(parsed);
  assert.equal(receipt.presence, 'present');
  assert.equal(receipt.certifies, true);
  assert.equal(receipt.manifestDigest, manifest.manifestDigest);
  assert.deepEqual(receipt.reasons, []);
});
