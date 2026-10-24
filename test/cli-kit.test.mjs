import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineCli } from '../bin/cli.mjs';
import { spawnSyncBounded } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI_KIT = path.join(here, '..', 'bin', 'cli.mjs');

const cli = defineCli({
  name: 'kit',
  usage: ['kit [options] [args]'],
  positionals: true,
  flags: {
    ref: { value: 'ref', help: 'a ref', allowEmpty: true },
    out: { value: 'dir', help: 'an output dir' },
    list: { value: 'item', help: 'repeatable', repeat: true },
    upload: { help: 'boolean with negate', negate: true },
  },
});

test('cli kit: an explicit empty value is consumed, not re-read as a positional', () => {
  assert.deepEqual(cli.parse(['--ref', '', 'pos']), { opts: { list: [], ref: '' }, args: ['pos'], passthrough: [] });
  assert.deepEqual(cli.parse(['--ref=', 'pos']), { opts: { list: [], ref: '' }, args: ['pos'], passthrough: [] });
});

test('cli kit: an allowEmpty flag followed by another flag reads as empty and keeps the flag', () => {
  assert.deepEqual(cli.parse(['--ref', '--no-upload']).opts, { list: [], ref: '', upload: false });
});

test('cli kit: --k v, --k=v, repeatable flags, and --no-k all parse', () => {
  const { opts, args } = cli.parse(['--out', 'x', '--list=a', '--list', 'b', '--no-upload', 'p1', 'p2']);
  assert.deepEqual(opts, { out: 'x', list: ['a', 'b'], upload: false });
  assert.deepEqual(args, ['p1', 'p2']);
});

test('cli kit: a boolean flag honours an inline true/false/1/0 value, including --no-k=', () => {
  const upload = (argv) => cli.parse(argv).opts.upload;
  assert.equal(upload(['--upload=false']), false);
  assert.equal(upload(['--upload=FALSE']), false);
  assert.equal(upload(['--upload=0']), false);
  assert.equal(upload(['--upload=true']), true);
  assert.equal(upload(['--upload=1']), true);
  assert.equal(upload(['--no-upload=true']), false);
  assert.equal(upload(['--no-upload=false']), true);
});

test('cli kit: tokens after -- are passthrough and never trigger help', () => {
  const parsed = cli.parse(['--out', 'x', '--', '--help', '-h', '--nope']);
  assert.deepEqual(parsed.opts, { list: [], out: 'x' });
  assert.deepEqual(parsed.passthrough, ['--help', '-h', '--nope']);
});

test('cli kit: a missing value and an unknown flag are usage errors (exit 2)', () => {
  const script = (argv) =>
    spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { defineCli } from ${JSON.stringify(CLI_KIT)};
         defineCli({ name: 'kit', usage: ['kit'], flags: { out: { value: 'dir', help: 'x' }, dry: { help: 'y' } } }).parse(${JSON.stringify(argv)});`,
      ],
      { encoding: 'utf8' },
    );
  const missing = script(['--out']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--out requires a value/);
  const badBoolean = script(['--dry=maybe']);
  assert.equal(badBoolean.status, 2);
  assert.match(badBoolean.stderr, /--dry expects true or false, got "maybe"/);
  const unknown = script(['--zzz']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown flag: --zzz/);
});

test('cli kit: run() with annotate prints a GitHub Actions error annotation', () => {
  const res = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { run } from ${JSON.stringify(CLI_KIT)};
       await run('kit', async () => { throw new Error('boom'); }, { annotate: true });`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(res.status, 1);
  assert.match(res.stderr, /^::error::StyleProof: boom$/m);
});

// Reports every process.exit() call on stderr, then exits as asked.
const EXIT_SPY = `const exit = process.exit;
  process.exit = (code) => { process.stderr.write('process.exit(' + code + ') called\\n'); exit(code); };`;

test('cli kit: exitWhenDrained exits with the code once work drains, never through process.exit()', () => {
  const started = Date.now();
  const res = spawnSyncBounded(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { exitWhenDrained } from ${JSON.stringify(CLI_KIT)};
       ${EXIT_SPY}
       exitWhenDrained(4);
       setTimeout(() => console.log('pending work finished'), 50);`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(res.status, 4, res.stderr);
  assert.match(res.stdout, /pending work finished/);
  assert.doesNotMatch(res.stderr, /process\.exit/);
  assert.ok(Date.now() - started < 5_000, 'a drained loop exits at once, not at the fallback');
});

test('cli kit: exitWhenDrained forces the exit when a leaked handle holds the loop open', () => {
  const started = Date.now();
  const res = spawnSyncBounded(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { exitWhenDrained } from ${JSON.stringify(CLI_KIT)};
       ${EXIT_SPY}
       setInterval(() => {}, 1_000);
       exitWhenDrained(5, 300);`,
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
  assert.equal(res.status, 5, res.stderr || res.error?.message);
  assert.match(res.stderr, /process\.exit\(5\) called/);
  assert.ok(Date.now() - started < 5_000, `fallback exit took ${Date.now() - started}ms`);
});

test('cli kit: run() ends a failed command with its exit code by draining, never through process.exit()', () => {
  for (const [annotate, line] of [
    [false, /^kit: boom$/m],
    [true, /^::error::StyleProof: boom$/m],
  ]) {
    const res = spawnSyncBounded(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { run } from ${JSON.stringify(CLI_KIT)};
         ${EXIT_SPY}
         await run('kit', async () => { throw Object.assign(new Error('boom'), { exitCode: 5 }); }, { annotate: ${annotate} });`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(res.status, 5, res.stderr);
    assert.match(res.stderr, line);
    assert.doesNotMatch(res.stderr, /process\.exit/);
  }
});

test('the publish and report-prune commands keep the ::error:: annotation on failure', async () => {
  const fs = await import('node:fs');
  for (const bin of ['styleproof-publish-report.mjs', 'styleproof-prune-reports.mjs']) {
    const src = fs.readFileSync(path.join(here, '..', 'bin', bin), 'utf8');
    assert.match(src, /annotate: true/, `${bin} must annotate failures`);
  }
});
