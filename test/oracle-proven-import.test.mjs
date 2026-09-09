/**
 * Oracle-proven import tests (#520 gap 2).
 *
 * StyleProof must correctly handle bundles with `determinism: 'oracle-proven'`
 * in the coverage ledger. The five-run oracle is the strongest determinism
 * basis and must be preserved through import/export cycles.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { auditDeterminism, COVERAGE_LEDGER } from '../dist/coverage.js';
import { readCoverageLedgerLenient } from '../dist/confidence-ledger.js';
import { mkTmp, rmTmp, makeMap } from './helpers.mjs';

const writeCoverageLedger = (dir, ledger) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, COVERAGE_LEDGER), JSON.stringify(ledger));
};

const writeMap = (dir, surface, map) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${surface}.json.gz`), gzipSync(JSON.stringify(map)));
};

test('auditDeterminism recognizes oracle-proven as a proven basis', () => {
  const baseLedger = { version: 1, expected: ['home'], exclude: {}, determinism: 'oracle-proven' };
  const headLedger = { version: 1, expected: ['home'], exclude: {}, determinism: 'oracle-proven' };

  const verdict = auditDeterminism(baseLedger, headLedger);

  assert.equal(verdict.status, 'proven', 'both oracle-proven should yield proven status');
  assert.equal(verdict.base, 'oracle-proven');
  assert.equal(verdict.head, 'oracle-proven');
});

test('auditDeterminism: oracle-proven base with self-checked head is still proven', () => {
  const baseLedger = { version: 1, expected: ['home'], exclude: {}, determinism: 'oracle-proven' };
  const headLedger = { version: 1, expected: ['home'], exclude: {}, determinism: 'self-checked' };

  const verdict = auditDeterminism(baseLedger, headLedger);

  assert.equal(verdict.status, 'proven');
  assert.equal(verdict.base, 'oracle-proven');
  assert.equal(verdict.head, 'self-checked');
});

test('auditDeterminism: oracle-proven base with replayed head is proven', () => {
  const baseLedger = { version: 1, expected: ['home'], exclude: {}, determinism: 'oracle-proven' };
  const headLedger = { version: 1, expected: ['home'], exclude: {}, determinism: 'replayed' };

  const verdict = auditDeterminism(baseLedger, headLedger);

  assert.equal(verdict.status, 'proven');
  assert.equal(verdict.base, 'oracle-proven');
  assert.equal(verdict.head, 'replayed');
});

test('auditDeterminism: oracle-proven base with unproven head is unproven', () => {
  const baseLedger = { version: 1, expected: ['home'], exclude: {}, determinism: 'oracle-proven' };
  const headLedger = { version: 1, expected: ['home'], exclude: {}, determinism: 'unproven' };

  const verdict = auditDeterminism(baseLedger, headLedger);

  assert.equal(verdict.status, 'unproven', 'any unproven side downgrades the whole diff');
  assert.equal(verdict.base, 'oracle-proven');
  assert.equal(verdict.head, 'unproven');
});

test('auditDeterminism: missing determinism field yields unknown', () => {
  const baseLedger = { version: 1, expected: ['home'], exclude: {} };
  const headLedger = { version: 1, expected: ['home'], exclude: {}, determinism: 'oracle-proven' };

  const verdict = auditDeterminism(baseLedger, headLedger);

  assert.equal(verdict.status, 'unknown', 'missing determinism on either side is unknown');
  assert.equal(verdict.base, 'unknown');
  assert.equal(verdict.head, 'oracle-proven');
});

test('auditDeterminism: null ledgers yield unknown status', () => {
  const verdict = auditDeterminism(null, null);

  assert.equal(verdict.status, 'unknown');
  assert.equal(verdict.base, 'unknown');
  assert.equal(verdict.head, 'unknown');
});

test('readCoverageLedgerLenient reads oracle-proven from disk', () => {
  const tmp = mkTmp();
  try {
    const ledger = {
      version: 1,
      expected: ['home', 'about', 'pricing'],
      exclude: { admin: 'Requires authentication' },
      determinism: 'oracle-proven',
    };
    writeCoverageLedger(tmp, ledger);
    writeMap(tmp, 'home@1280', makeMap());

    const read = readCoverageLedgerLenient(tmp);

    assert.ok(read, 'ledger should be read');
    assert.equal(read.determinism, 'oracle-proven');
    assert.deepEqual(read.expected, ['home', 'about', 'pricing']);
    assert.deepEqual(read.exclude, { admin: 'Requires authentication' });
  } finally {
    rmTmp(tmp);
  }
});

test('readCoverageLedgerLenient preserves all determinism basis values', () => {
  const bases = ['oracle-proven', 'self-checked', 'replayed', 'unproven'];
  const tmp = mkTmp();

  try {
    for (const basis of bases) {
      const subdir = path.join(tmp, basis);
      const ledger = { version: 1, expected: null, exclude: {}, determinism: basis };
      writeCoverageLedger(subdir, ledger);
      writeMap(subdir, 'surface@1280', makeMap());

      const read = readCoverageLedgerLenient(subdir);
      assert.equal(read?.determinism, basis, `${basis} should be preserved`);
    }
  } finally {
    rmTmp(tmp);
  }
});

test('oracle-proven bundle import preserves determinism through round-trip', () => {
  const tmp = mkTmp();
  try {
    const oracleProvenLedger = {
      version: 1,
      expected: ['dashboard', 'settings'],
      exclude: {},
      determinism: 'oracle-proven',
      dataResidue: 'gate',
    };
    writeCoverageLedger(tmp, oracleProvenLedger);
    writeMap(tmp, 'dashboard@1280', makeMap());
    writeMap(tmp, 'settings@1280', makeMap());

    const read = readCoverageLedgerLenient(tmp);
    assert.equal(read?.determinism, 'oracle-proven');
    assert.equal(read?.dataResidue, 'gate');

    const selfCheckedLedger = {
      version: 1,
      expected: ['dashboard', 'settings'],
      exclude: {},
      determinism: 'self-checked',
      dataResidue: 'gate',
    };
    const verdict = auditDeterminism(read, selfCheckedLedger);
    assert.equal(verdict.status, 'proven');
  } finally {
    rmTmp(tmp);
  }
});
