import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineCli } from '../bin/cli.mjs';

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
         defineCli({ name: 'kit', usage: ['kit'], flags: { out: { value: 'dir', help: 'x' } } }).parse(${JSON.stringify(argv)});`,
      ],
      { encoding: 'utf8' },
    );
  const missing = script(['--out']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--out requires a value/);
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

test('the publish and report-prune commands keep the ::error:: annotation on failure', async () => {
  const fs = await import('node:fs');
  for (const bin of ['styleproof-publish-report.mjs', 'styleproof-prune-reports.mjs']) {
    const src = fs.readFileSync(path.join(here, '..', 'bin', bin), 'utf8');
    assert.match(src, /annotate: true/, `${bin} must annotate failures`);
  }
});
