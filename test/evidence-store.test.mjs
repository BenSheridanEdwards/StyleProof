import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  createEvidenceCapture,
  materializeEvidenceCapture,
  putEvidenceObject,
  readEvidenceObject,
  readEvidenceRef,
  writeEvidenceRef,
  EvidenceStoreError,
} from '../dist/evidence-store.js';
import { mkTmp, rmTmp } from './helpers.mjs';

test('evidence store deduplicates immutable bytes and detects corruption', () => {
  const root = mkTmp('styleproof-evidence-store-');
  try {
    const bytes = Buffer.from('deterministic-map-bytes');
    const digest = createHash('sha256').update(bytes).digest('hex');

    const first = putEvidenceObject(root, bytes);
    const second = putEvidenceObject(root, bytes);

    assert.deepEqual(first, { algorithm: 'sha256', digest, size: bytes.length });
    assert.deepEqual(second, first);
    assert.deepEqual(readEvidenceObject(root, first), bytes);

    const objectPath = path.join(root, 'objects', 'sha256', digest.slice(0, 2), digest);
    assert.equal(fs.existsSync(objectPath), true);
    fs.writeFileSync(objectPath, 'corrupt');
    assert.throws(
      () => readEvidenceObject(root, first),
      (error) => error instanceof EvidenceStoreError && /digest mismatch/.test(error.message),
    );
    assert.throws(
      () => putEvidenceObject(root, bytes),
      (error) => error instanceof EvidenceStoreError && /digest mismatch/.test(error.message),
    );
  } finally {
    rmTmp(root);
  }
});

test('capture identity is canonical and materialization verifies an immutable manifest', () => {
  const root = mkTmp('styleproof-capture-store-');
  const workspace = mkTmp('styleproof-capture-out-');
  const out = path.join(workspace, 'materialized');
  try {
    const source = { sha: 'a'.repeat(40), compatibilityKey: 'compat-123' };
    const trust = { coverageBasis: 'complete', determinismStatus: 'proven' };
    const files = [
      { path: 'home@1280.json', bytes: Buffer.from('{"url":"/"}') },
      { path: 'screenshots/home@1280.png', bytes: Buffer.from([1, 2, 3, 4]) },
    ];

    const first = createEvidenceCapture(root, { source, trust, files });
    const second = createEvidenceCapture(root, { source, trust, files: [...files].reverse() });
    assert.deepEqual(second.capture, first.capture, 'input ordering changed capture identity');
    assert.deepEqual(
      first.manifest.files.map((file) => file.path),
      ['home@1280.json', 'screenshots/home@1280.png'],
    );

    materializeEvidenceCapture(root, first.capture, out);
    assert.equal(fs.readFileSync(path.join(out, 'home@1280.json'), 'utf8'), '{"url":"/"}');
    assert.deepEqual(fs.readFileSync(path.join(out, 'screenshots/home@1280.png')), Buffer.from([1, 2, 3, 4]));

    assert.throws(
      () => createEvidenceCapture(root, { source, trust, files: [{ path: '../escape', bytes: Buffer.from('x') }] }),
      (error) => error instanceof EvidenceStoreError && /unsafe evidence path/.test(error.message),
    );
    assert.throws(
      () => createEvidenceCapture(root, { source, trust, files: [files[0], files[0]] }),
      (error) => error instanceof EvidenceStoreError && /duplicate evidence path/.test(error.message),
    );
    assert.throws(
      () =>
        createEvidenceCapture(root, {
          source,
          trust: { coverageBasis: 'probably-complete', determinismStatus: 'proven' },
          files,
        }),
      (error) => error instanceof EvidenceStoreError && /invalid evidence trust/.test(error.message),
    );
  } finally {
    rmTmp(root);
    rmTmp(workspace);
  }
});

test('evidence refs recover a stale lock owned by a dead publisher', () => {
  const root = mkTmp('styleproof-evidence-stale-lock-');
  try {
    const source = { sha: 'e'.repeat(40), compatibilityKey: 'compat-stale-lock' };
    const trust = { coverageBasis: 'complete', determinismStatus: 'proven' };
    const first = createEvidenceCapture(root, {
      source,
      trust,
      files: [{ path: 'home@1280.json', bytes: Buffer.from('first') }],
    }).capture;
    const second = createEvidenceCapture(root, {
      source,
      trust,
      files: [{ path: 'home@1280.json', bytes: Buffer.from('second') }],
    }).capture;
    const key = `commits/${source.sha}/${source.compatibilityKey}`;
    writeEvidenceRef(root, key, first, null);

    const lockPath = path.join(root, 'refs', 'commits', source.sha, `${source.compatibilityKey}.json.lock`);
    const deadPublisher = spawnSync(process.execPath, ['-e', '']);
    assert.equal(deadPublisher.status, 0, deadPublisher.stderr?.toString());
    assert.equal(Number.isSafeInteger(deadPublisher.pid), true);
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        version: 1,
        pid: deadPublisher.pid,
        createdAt: '2026-01-01T00:00:00.000Z',
        token: 'deadbeefdeadbeefdeadbeefdeadbeef',
      }),
    );

    writeEvidenceRef(root, key, second, first);
    assert.deepEqual(readEvidenceRef(root, key), second);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    rmTmp(root);
  }
});

test('evidence refs recover a legacy PID-line lock owned by a dead publisher', () => {
  const root = mkTmp('styleproof-evidence-legacy-lock-');
  try {
    const source = { sha: 'f'.repeat(40), compatibilityKey: 'compat-legacy-lock' };
    const trust = { coverageBasis: 'complete', determinismStatus: 'proven' };
    const first = createEvidenceCapture(root, {
      source,
      trust,
      files: [{ path: 'home@1280.json', bytes: Buffer.from('first') }],
    }).capture;
    const second = createEvidenceCapture(root, {
      source,
      trust,
      files: [{ path: 'home@1280.json', bytes: Buffer.from('second') }],
    }).capture;
    const key = `commits/${source.sha}/${source.compatibilityKey}`;
    writeEvidenceRef(root, key, first, null);
    const lockPath = path.join(root, 'refs', 'commits', source.sha, `${source.compatibilityKey}.json.lock`);
    const deadPublisher = spawnSync(process.execPath, ['-e', '']);
    assert.equal(deadPublisher.status, 0, deadPublisher.stderr?.toString());
    fs.writeFileSync(lockPath, `${deadPublisher.pid}\n`);

    writeEvidenceRef(root, key, second, first);
    assert.deepEqual(readEvidenceRef(root, key), second);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    rmTmp(root);
  }
});

test('evidence refs use compare-and-swap instead of silently losing concurrent publication', () => {
  const root = mkTmp('styleproof-evidence-refs-');
  try {
    const source = { sha: 'b'.repeat(40), compatibilityKey: 'compat-refs' };
    const trust = { coverageBasis: 'complete', determinismStatus: 'proven' };
    const first = createEvidenceCapture(root, {
      source,
      trust,
      files: [{ path: 'home@1280.json', bytes: Buffer.from('first') }],
    }).capture;
    const second = createEvidenceCapture(root, {
      source,
      trust,
      files: [{ path: 'home@1280.json', bytes: Buffer.from('second') }],
    }).capture;
    const key = `commits/${source.sha}/${source.compatibilityKey}`;

    writeEvidenceRef(root, key, first, null);
    assert.deepEqual(readEvidenceRef(root, key), first);
    assert.throws(
      () => writeEvidenceRef(root, key, second, null),
      (error) => error instanceof EvidenceStoreError && /compare-and-swap/.test(error.message),
    );
    writeEvidenceRef(root, key, second, first);
    assert.deepEqual(readEvidenceRef(root, key), second);
    assert.throws(
      () => writeEvidenceRef(root, key, first, first),
      (error) => error instanceof EvidenceStoreError && /compare-and-swap/.test(error.message),
    );

    const lockPath = path.join(root, 'refs', 'commits', source.sha, `${source.compatibilityKey}.json.lock`);
    fs.writeFileSync(lockPath, 'other-publisher');
    assert.throws(
      () => writeEvidenceRef(root, key, first, second),
      (error) => error instanceof EvidenceStoreError && /locked by another publisher/.test(error.message),
    );
    assert.equal(fs.readFileSync(lockPath, 'utf8'), 'other-publisher');

    fs.rmSync(lockPath);
    const liveLock = JSON.stringify({
      version: 1,
      pid: process.pid,
      createdAt: '2000-01-01T00:00:00.000Z',
      token: 'feedfacefeedfacefeedfacefeedface',
    });
    fs.writeFileSync(lockPath, liveLock);
    assert.throws(
      () => writeEvidenceRef(root, key, first, second),
      (error) => error instanceof EvidenceStoreError && /locked by another publisher/.test(error.message),
    );
    assert.equal(fs.readFileSync(lockPath, 'utf8'), liveLock, 'live lock was stolen because it looked old');
  } finally {
    rmTmp(root);
  }
});
