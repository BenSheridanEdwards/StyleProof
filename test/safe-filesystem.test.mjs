import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isWithinDirectory, readRegularFileNoFollow, UnsafeFilesystemEntryError } from '../dist/safe-filesystem.js';
import { mkTmp, rmTmp } from './helpers.mjs';

const refusedAs = (kind) => (error) => error instanceof UnsafeFilesystemEntryError && error.kind === kind;

function mutateOnCall(t, method, callNumber, mutate) {
  const original = fs[method];
  let calls = 0;
  t.mock.method(fs, method, (...args) => {
    if (++calls === callNumber) mutate();
    return original(...args);
  });
}

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

test('readRegularFileNoFollow sizes a bounded read to the file, not to the cap', () => {
  const workspace = mkTmp('styleproof-safe-read-size-');
  try {
    // Larger than Buffer's 4 KiB pool cutoff, so the backing store is this read's own.
    const map = path.join(workspace, 'home@1280.json');
    fs.writeFileSync(map, 'x'.repeat(64 * 1024));
    const bytes = readRegularFileNoFollow(map, 256 * 1024 * 1024);
    assert.equal(bytes.length, 64 * 1024);
    assert.ok(
      bytes.buffer.byteLength <= 64 * 1024 + 1,
      `a 64 KiB read reserved ${bytes.buffer.byteLength} bytes instead of the file size`,
    );
  } finally {
    rmTmp(workspace);
  }
});

test('readRegularFileNoFollow refuses a file that grows after it is sized', (t) => {
  const workspace = mkTmp('styleproof-safe-read-grow-');
  try {
    const file = path.join(workspace, 'home@1280.json');
    const fstatSync = fs.fstatSync;
    let sized = false;
    // Append right after the first fstat, the one the read is sized from.
    t.mock.method(fs, 'fstatSync', (descriptor) => {
      const stat = fstatSync(descriptor);
      if (!sized) fs.appendFileSync(file, 'tail');
      sized = true;
      return stat;
    });

    fs.writeFileSync(file, 'head');
    assert.throws(() => readRegularFileNoFollow(file, 1024), refusedAs('changed-during-read'));

    sized = false;
    fs.writeFileSync(file, 'x'.repeat(64));
    assert.throws(() => readRegularFileNoFollow(file, 64), refusedAs('oversized'));
  } finally {
    rmTmp(workspace);
  }
});

for (const maximumBytes of [1024, undefined]) {
  const mode = maximumBytes === undefined ? 'uncapped' : 'capped';
  for (const { name, method, callNumber, mutate } of [
    {
      name: 'growing rewrite after EOF',
      method: 'fstatSync',
      callNumber: 2,
      mutate: (file) => fs.writeFileSync(file, 'y'.repeat(128)),
    },
    {
      name: 'same-size rewrite after EOF',
      method: 'fstatSync',
      callNumber: 2,
      mutate: (file) => {
        fs.writeFileSync(file, 'y'.repeat(64));
        const changedTime = new Date(2000, 0, 1);
        fs.utimesSync(file, changedTime, changedTime);
      },
    },
    {
      name: 'truncate after EOF',
      method: 'fstatSync',
      callNumber: 2,
      mutate: (file) => fs.truncateSync(file, 16),
    },
    {
      name: 'path rewrite after the final descriptor stat',
      method: 'lstatSync',
      callNumber: 3,
      mutate: (file) => fs.writeFileSync(file, 'y'.repeat(128)),
    },
  ]) {
    test(`readRegularFileNoFollow refuses a ${name} (${mode})`, (t) => {
      const workspace = mkTmp('styleproof-safe-read-mutate-');
      try {
        const file = path.join(workspace, 'home@1280.json');
        fs.writeFileSync(file, 'x'.repeat(64));
        mutateOnCall(t, method, callNumber, () => mutate(file));
        assert.throws(() => readRegularFileNoFollow(file, maximumBytes), refusedAs('changed-during-read'));
      } finally {
        rmTmp(workspace);
      }
    });
  }
}

test('readRegularFileNoFollow refuses a rewrite past the cap after EOF as oversized', (t) => {
  const workspace = mkTmp('styleproof-safe-read-rewrite-cap-');
  try {
    const file = path.join(workspace, 'home@1280.json');
    fs.writeFileSync(file, 'x'.repeat(64));
    mutateOnCall(t, 'fstatSync', 2, () => fs.writeFileSync(file, 'y'.repeat(128)));
    assert.throws(() => readRegularFileNoFollow(file, 64), refusedAs('oversized'));
  } finally {
    rmTmp(workspace);
  }
});

test('readRegularFileNoFollow refuses uncapped growth after it is sized', (t) => {
  const workspace = mkTmp('styleproof-safe-read-uncapped-grow-');
  try {
    const file = path.join(workspace, 'home@1280.json');
    fs.writeFileSync(file, 'x'.repeat(64));
    const fstatSync = fs.fstatSync;
    let sized = false;
    t.mock.method(fs, 'fstatSync', (descriptor) => {
      const stat = fstatSync(descriptor);
      if (!sized) fs.appendFileSync(file, 'tail');
      sized = true;
      return stat;
    });
    assert.throws(() => readRegularFileNoFollow(file), refusedAs('changed-during-read'));
  } finally {
    rmTmp(workspace);
  }
});

test('isWithinDirectory treats every path as inside the filesystem root', () => {
  const root = path.parse(process.cwd()).root;
  assert.equal(isWithinDirectory(root, root), true);
  assert.equal(isWithinDirectory(root, path.join(root, 'repo', 'app')), true);
  assert.equal(isWithinDirectory(path.join(root, 'repo'), path.join(root, 'repo', 'app')), true);
  assert.equal(isWithinDirectory(path.join(root, 'repo'), path.join(root, 'repo-other')), false);
});
