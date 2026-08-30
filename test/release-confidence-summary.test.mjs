import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReleaseConfidenceManifest } from '../dist/release-confidence-manifest.js';
import { summarizeReleaseConfidence } from '../dist/release-confidence-summary.js';
import * as styleproof from '../dist/index.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/phase0-contract/valid-enumerated.json',
);

test('absent release confidence is a bounded blocking summary', () => {
  assert.deepEqual(summarizeReleaseConfidence(), {
    kind: 'styleproof.release-confidence.summary',
    version: '0.1',
    presence: 'absent-legacy',
    certifies: false,
    status: 'unproven',
    blocking: true,
    worstAxis: 'integrity',
    declared: { surfaces: 0, obligations: 0, assertions: 0 },
    evidenced: { joins: 0, completeDomains: 0, requiredDomains: 6 },
    incomparable: [],
    reasons: ['manifest-absent'],
  });
});

test('certifying release confidence is a separate non-blocking manifest summary', () => {
  const contract = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const manifest = createReleaseConfidenceManifest({
    manifestId: 'rcm-report-control',
    producerVersion: '6.2.2',
    releaseScope: 'styleproof-report',
    contract,
  });

  const summary = summarizeReleaseConfidence(manifest);
  assert.equal(summary.presence, 'present');
  assert.equal(summary.certifies, true);
  assert.equal(summary.status, 'valid');
  assert.equal(summary.blocking, false);
  assert.equal(summary.worstAxis, 'none');
  assert.equal(summary.manifestDigest, manifest.manifestDigest);
  assert.deepEqual(summary.declared, {
    surfaces: manifest.declaredScope.surfaces.length,
    obligations: manifest.obligations.length,
    assertions: manifest.assertions.length,
  });
  assert.deepEqual(summary.evidenced, {
    joins: manifest.evidenceJoins.length,
    completeDomains: 6,
    requiredDomains: 6,
  });
  assert.deepEqual(summary.incomparable, []);
  assert.deepEqual(summary.reasons, []);
});

test('exports the release confidence summary from the package root', () => {
  assert.equal(styleproof.summarizeReleaseConfidence, summarizeReleaseConfidence);
});
