import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp, rmTmp, writeCapture, makeMap, spawnSyncBounded } from './helpers.mjs';
const DIFF = path.resolve('bin/styleproof-diff.mjs');
const REPORT = path.resolve('bin/styleproof-report.mjs');
const run = (script, args) =>
  spawnSyncBounded(process.execPath, [script, ...args], { encoding: 'utf8', cwd: process.env.TMPDIR });
function identicalPair() {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  for (const dir of [A, B]) {
    writeCapture(dir, 'home@1280', makeMap(), null);
    fs.writeFileSync(
      path.join(dir, 'styleproof-manifest.json'),
      JSON.stringify({
        version: 1,
        packageVersion: 'test',
        sha: '1'.repeat(40),
        dirty: false,
        spec: 'test.spec.ts',
        specHash: '1'.repeat(64),
        platform: process.platform,
        arch: process.arch,
        nodeMajor: process.versions.node.split('.')[0],
        screenshots: true,
        har: false,
        compatibilityKey: '1'.repeat(16),
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    );
  }
  return { root, A, B };
}

test('capture directories ignore stray JSON and permit diff output beside maps', () => {
  const { root, A, B } = identicalPair();
  try {
    for (const name of ['notes.json', 'package.json', 'notes.json.gz', 'page@wide.json', '@800.json']) {
      fs.writeFileSync(path.join(B, name), 'not a map');
    }
    const first = run(DIFF, [A, B, '--allow-unasserted', '--json', path.join(B, 'diff.json')]);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const second = run(DIFF, [A, B, '--allow-unasserted', '--audit-json', path.join(B, 'audit.json')]);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    const report = run(REPORT, [A, B, '--out', path.join(root, 'report')]);
    assert.equal(report.status, 1, report.stdout + report.stderr);
    assert.match(report.stdout + report.stderr, /UNVERIFIED DIAGNOSTIC/);
  } finally {
    rmTmp(root);
  }
});
