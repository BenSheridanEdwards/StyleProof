import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  LEGACY_PAIRS_ACK_FILE,
  applyLegacyPairReceipts,
  auditLegacyPairs,
  declarationMatches,
  legacyPairsGateArmed,
  readLegacyPairsAckFile,
} from '../dist/legacy-pairs.js';
import { mkTmp, rmTmp } from './helpers.mjs';

const legacy = (surface) => ({ surface, status: 'unproven', required: false });
const required = (surface) => ({ surface, status: 'unproven', required: true });
const comparable = (surface) => ({ surface, status: 'comparable', required: true });

test('declarationMatches: surface base covers every width; exact key stays exact', () => {
  assert.equal(declarationMatches('home', 'home@1280'), true);
  assert.equal(declarationMatches('home', 'home@768'), true);
  assert.equal(declarationMatches('home@1280', 'home@1280'), true);
  assert.equal(declarationMatches('home@1280', 'home@768'), false);
  assert.equal(declarationMatches('pricing', 'home@1280'), false);
});

test('auditLegacyPairs: undeclared unproven pairs are the fail-closed set when armed', () => {
  const audit = auditLegacyPairs([legacy('home@1280'), legacy('pricing@1280')], {}, true);
  assert.equal(audit.armed, true);
  assert.deepEqual(audit.undeclared, ['home@1280', 'pricing@1280']);
  assert.deepEqual(audit.declared, []);
});

test('auditLegacyPairs: a declared surface base acknowledges every width of that pair', () => {
  const audit = auditLegacyPairs(
    [legacy('home@1280'), legacy('home@768'), legacy('pricing@1280')],
    { home: 'known demo shell pending identity stamp' },
    true,
  );
  assert.deepEqual(audit.declared, ['home@1280', 'home@768']);
  assert.deepEqual(audit.undeclared, ['pricing@1280']);
  assert.deepEqual(audit.staleAcknowledgements, []);
});

test('auditLegacyPairs: comparable identity is not a legacy pair and stale-declares the leftover', () => {
  const audit = auditLegacyPairs(
    [comparable('home@1280'), required('checkout@1280')],
    { home: 'no longer legacy — identity is on the maps' },
    true,
  );
  assert.deepEqual(audit.legacyPairs, []);
  assert.deepEqual(audit.undeclared, []);
  assert.deepEqual(audit.staleAcknowledgements, ['home']);
});

test('applyLegacyPairReceipts: only undeclared legacy receipts become required', () => {
  const gated = applyLegacyPairReceipts([legacy('home@1280'), legacy('pricing@1280')], {
    armed: true,
    legacyPairs: ['home@1280', 'pricing@1280'],
    declared: ['home@1280'],
    undeclared: ['pricing@1280'],
    staleAcknowledgements: [],
  });
  assert.deepEqual(gated, [
    { surface: 'home@1280', status: 'unproven', required: false },
    { surface: 'pricing@1280', status: 'unproven', required: true },
  ]);
});

test('readLegacyPairsAckFile: missing explicit file fails closed; present file declares pairs', () => {
  const dir = mkTmp('styleproof-legacy-pairs-read-');
  try {
    assert.throws(
      () => readLegacyPairsAckFile(path.join(dir, 'missing.json')),
      /legacy product-state declare file is required/,
    );
    const file = path.join(dir, LEGACY_PAIRS_ACK_FILE);
    fs.writeFileSync(file, JSON.stringify({ home: 'known demo shell' }));
    assert.equal(legacyPairsGateArmed(file), true);
    assert.deepEqual(readLegacyPairsAckFile(file), { home: 'known demo shell' });
  } finally {
    rmTmp(dir);
  }
});

test('readLegacyPairsAckFile: rejects an empty reason or unsafe key', () => {
  const dir = mkTmp('styleproof-legacy-pairs-file-');
  try {
    const emptyReason = path.join(dir, 'empty-reason.json');
    fs.writeFileSync(emptyReason, JSON.stringify({ home: '' }));
    assert.throws(() => readLegacyPairsAckFile(emptyReason), /must be a non-empty reason string/);

    const unsafe = path.join(dir, 'unsafe.json');
    fs.writeFileSync(unsafe, JSON.stringify({ '../secret': 'nope' }));
    assert.throws(() => readLegacyPairsAckFile(unsafe), /not a safe single path segment/);
  } finally {
    rmTmp(dir);
  }
});
