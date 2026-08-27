import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readRegularFileNoFollow, UnsafeFilesystemEntryError } from '../dist/safe-filesystem.js';
import { mkTmp, rmTmp } from './helpers.mjs';

test('readRegularFileNoFollow reads regular bytes and refuses symlinks', () => {
  const workspace = mkTmp('styleproof-safe-read-');
  try {
    const regular = path.join(workspace, 'regular.json');
    const linked = path.join(workspace, 'linked.json');
    fs.writeFileSync(regular, '{"ok":true}');
    fs.symlinkSync(regular, linked);

    assert.equal(readRegularFileNoFollow(regular).toString('utf8'), '{"ok":true}');
    assert.throws(
      () => readRegularFileNoFollow(linked),
      (error) => error instanceof UnsafeFilesystemEntryError && error.kind === 'symbolic-link',
    );
  } finally {
    rmTmp(workspace);
  }
});

test('readRegularFileNoFollow refuses a FIFO without opening it', { skip: process.platform === 'win32' }, () => {
  const workspace = mkTmp('styleproof-safe-read-fifo-');
  try {
    const fifoPath = path.join(workspace, 'capture.json');
    const fifo = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' });
    assert.equal(fifo.status, 0, fifo.stderr);
    const started = Date.now();
    assert.throws(
      () => readRegularFileNoFollow(fifoPath),
      (error) => error instanceof UnsafeFilesystemEntryError && error.kind === 'non-regular',
    );
    assert.ok(Date.now() - started < 1_000, 'FIFO refusal blocked while opening the file');
  } finally {
    rmTmp(workspace);
  }
});
