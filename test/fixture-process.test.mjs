import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('fixture subprocess deadline names the command and deadline', () => {
  const source = `import { fixtureProcess } from './test/helpers/fixture-process.mjs';
    fixtureProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 150 });`;
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    timeout: 3000,
  });
  assert.ok(Date.now() - started < 2500, 'fixture exceeded outer guard');
  assert.match(result.stderr, /deadline 150 ms/);
  assert.ok(result.stderr.includes(process.execPath), result.stderr);
  assert.match(result.stderr, /local git install may have stalled/);
});

const { fixtureProcess } = await import('./helpers/fixture-process.mjs');
for (const [name, source, options] of [
  ['success', 'console.log("ok"); console.error("err")', {}],
  ['nonzero', 'process.exit(7)', { encoding: 'utf8' }],
  ['signal', 'process.kill(process.pid, "SIGTERM")', {}],
  ['utf8', 'process.stdout.write("雪🙂".repeat(50000))', { encoding: 'utf8' }],
  ['buffer input', 'process.stdin.pipe(process.stdout)', { input: Buffer.from([0, 255, 128]) }],
  ['large binary input', 'process.stdin.pipe(process.stdout)', { input: Buffer.alloc(1048576, 255) }],
  ['typed input', 'process.stdin.pipe(process.stdout)', { input: new Uint8Array([255, 0, 128]) }],
  [
    'wide typed input',
    'process.stdin.pipe(process.stdout)',
    { input: new Uint16Array([0, 0x1234, 0xffff, 0]).subarray(1, 3) },
  ],
  [
    'data view input',
    'process.stdin.pipe(process.stdout)',
    { input: new DataView(new Uint8Array([9, 0, 255, 128, 9]).buffer, 1, 3) },
  ],
  ['ignored input', 'process.exit(0)', { input: Buffer.alloc(2097152) }],
]) {
  test(`fixture matches spawnSync: ${name}`, () => {
    const args = ['-e', source];
    const expected = spawnSync(process.execPath, args, { ...options, maxBuffer: 8388608 });
    const actual = fixtureProcess(process.execPath, args, options);
    const fields = ({ status, signal, stdout, stderr }) => ({ status, signal, stdout, stderr });
    assert.deepEqual(fields(actual), fields(expected));
  });
}
test('missing command returns error', () => {
  const result = fixtureProcess('/nonexistent-styleproof-command', []);
  assert.equal(result.error.code, 'ENOENT');
  assert.equal(result.status, null);
});
test('explicit environment excludes parent Git variables', () => {
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = '/leaked/outer';
  try {
    const result = fixtureProcess(process.execPath, ['-e', 'console.log(JSON.stringify(process.env))'], {
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
    });
    const actual = JSON.parse(result.stdout);
    delete actual.__CF_USER_TEXT_ENCODING;
    // Node adds this to child processes when coverage is enabled.
    delete actual.NODE_V8_COVERAGE;
    assert.deepEqual(actual, { PATH: process.env.PATH, GIT_TERMINAL_PROMPT: '0' });
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
});
