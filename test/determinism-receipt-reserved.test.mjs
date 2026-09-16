import test from 'node:test';
import assert from 'node:assert/strict';
import { DETERMINISM_RECEIPT, isMapFile, isOwnedCaptureArtifact } from '../dist/map-store.js';

// #534: styleproof-determinism.json must be registered in RESERVED_BUNDLE_FILES
// This is the proof receipt written by the five-run oracle (--prove-determinism).

test('styleproof-determinism.json is registered as a reserved bundle file (#534)', () => {
  assert.equal(typeof DETERMINISM_RECEIPT, 'string', 'DETERMINISM_RECEIPT constant must be exported');
  assert.equal(DETERMINISM_RECEIPT, 'styleproof-determinism.json', 'constant must be the determinism receipt filename');
  assert.equal(isMapFile(DETERMINISM_RECEIPT), false, 'the determinism receipt must never count as a surface map');
});

test('styleproof-determinism.json is treated as an owned capture artifact (#534)', () => {
  assert.equal(
    isOwnedCaptureArtifact(DETERMINISM_RECEIPT),
    true,
    'the determinism receipt must be recognized as an owned capture artifact',
  );
});
