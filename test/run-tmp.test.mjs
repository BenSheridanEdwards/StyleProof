import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRunTmp, runWithTmp, sweepStaleRunTmp } from '../scripts/run-tmp.mjs';

function parentDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-tmp-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  return dir;
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', '']);
  await once(child, 'exit');

  return child.pid;
}

test('runWithTmp removes files created under the child temp directory', async (t) => {
  const parent = parentDir(t);

  const code = await runWithTmp(
    process.execPath,
    [
      '-e',
      `
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    require('node:assert/strict').equal(process.env.TMP, os.tmpdir());
    require('node:assert/strict').equal(process.env.TEMP, os.tmpdir());
    fs.writeFileSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'leak-')), 'file'), 'x');
  `,
    ],
    { env: { ...process.env, TMPDIR: parent } },
  );

  assert.equal(code, 0);
  assert.deepEqual(fs.readdirSync(parent), []);
});

test('runWithTmp removes the root after a child dies from SIGTERM', async (t) => {
  const parent = parentDir(t);

  const code = await runWithTmp(
    process.execPath,
    [
      '-e',
      `
    require('node:fs').writeFileSync(require('node:path').join(require('node:os').tmpdir(), 'file'), 'x');
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 30);
  `,
    ],
    { env: { ...process.env, TMPDIR: parent } },
  );

  assert.equal(code, 143);
  assert.deepEqual(fs.readdirSync(parent), []);
});

test('sweep removes only exact dead-pid roots and cleanup is idempotent', async (t) => {
  const parent = parentDir(t);
  const pid = await deadPid();
  const stale = path.join(parent, `styleproof-run-${pid}-abc`);

  const kept = [
    `styleproof-run-${process.pid}-abc`,
    `styleproof-run-${process.ppid}-abc`,
    'styleproof-other',
    `styleproof-run-${pid}x-abc`,
  ];

  for (const name of [stale, ...kept.map((name) => path.join(parent, name))]) fs.mkdirSync(name);
  assert.deepEqual(sweepStaleRunTmp({ parent }), [stale]);
  assert.deepEqual(fs.readdirSync(parent).sort(), kept.sort());
  const root = createRunTmp({ parent });
  assert.match(path.basename(root.dir), new RegExp(`^styleproof-run-${process.pid}-`));
  root.cleanup();
  root.cleanup();
  assert.equal(fs.existsSync(root.dir), false);
});

for (const [signal, expected] of [
  ['SIGTERM', 143],
  ['SIGINT', 130],
]) {
  test(`runWithTmp forwards ${signal} and removes its root before returning`, async (t) => {
    const parent = parentDir(t);
    const ready = path.join(parent, 'ready');
    const module = new URL('../scripts/run-tmp.mjs', import.meta.url).href;

    const child = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      `
    import { runWithTmp } from ${JSON.stringify(module)};
    const code = await runWithTmp(process.execPath, ['-e', ${JSON.stringify(`
      require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');
      setInterval(() => {}, 1000);
    `)}], { env: { ...process.env, TMPDIR: ${JSON.stringify(parent)} } });
    process.exitCode = code;
  `,
    ]);

    t.after(() => child.kill('SIGKILL'));
    const exited = once(child, 'exit');
    const deadline = Date.now() + 10_000;

    while (!fs.existsSync(ready)) {
      assert.ok(Date.now() < deadline, 'child became ready');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const started = Date.now();
    child.kill(signal);
    assert.deepEqual(await exited, [expected, null]);

    if (signal === 'SIGINT') assert.ok(Date.now() - started >= 2900, 'waits for the grace period');
    fs.unlinkSync(ready);
    assert.deepEqual(fs.readdirSync(parent), []);
  });
}

test(
  'sweep skips roots it cannot remove',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  async (t) => {
    t.after(() => fs.chmodSync(parent, 0o700));
    const parent = parentDir(t);
    const stale = path.join(parent, `styleproof-run-${await deadPid()}-locked`);
    fs.mkdirSync(stale);
    fs.chmodSync(parent, 0o500);
    assert.doesNotThrow(() => sweepStaleRunTmp({ parent }));
    assert.ok(fs.existsSync(stale));
  },
);
