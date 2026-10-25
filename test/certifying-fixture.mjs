import fs from 'node:fs';
import path from 'node:path';
import { COVERAGE_LEDGER } from '../dist/coverage.js';
import { buildConfidenceLedger, writeConfidenceLedger } from '../dist/confidence-ledger.js';
import { fixtureCompatibilityKey, fixtureContentHash } from './helpers.mjs';

export function stampCertifyingFixture(dir, sha) {
  fs.writeFileSync(
    path.join(dir, 'styleproof-manifest.json'),
    JSON.stringify({
      version: 1,
      packageVersion: 'test',
      sha,
      dirty: false,
      spec: 'e2e/styleproof.spec.ts',
      specHash: fixtureContentHash('test'),
      platform: process.platform,
      arch: process.arch,
      nodeMajor: process.versions.node.split('.')[0],
      screenshots: false,
      har: false,
      compatibilityKey: fixtureCompatibilityKey('action-receipt-parity-test'),
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  fs.writeFileSync(
    path.join(dir, COVERAGE_LEDGER),
    JSON.stringify({ version: 1, expected: ['home'], exclude: {}, determinism: 'self-checked' }),
  );
  writeConfidenceLedger(
    dir,
    buildConfidenceLedger({
      capturedKeys: ['home'],
      coverage: { version: 1, expected: ['home'], exclude: {}, determinism: 'self-checked' },
    }),
  );
}
