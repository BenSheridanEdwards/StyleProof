import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeMap, pairFixture, rmTmp } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cli = path.join(root, 'bin', 'styleproof.mjs');

function writeTrust(directory, sha) {
  fs.writeFileSync(
    path.join(directory, 'styleproof-manifest.json'),
    JSON.stringify({
      version: 1,
      packageVersion: '6.1.0',
      sha,
      dirty: false,
      spec: 'e2e/styleproof.spec.ts',
      specHash: '1'.repeat(64),
      platform: 'darwin',
      arch: 'arm64',
      nodeMajor: '22',
      screenshots: false,
      har: false,
      compatibilityKey: '0000000000000000',
      createdAt: '2026-08-26T00:00:00.000Z',
    }),
  );
  fs.writeFileSync(
    path.join(directory, 'styleproof-coverage.json'),
    JSON.stringify({ version: 1, expected: ['home'], exclude: {}, determinism: 'self-checked' }),
  );
}

test('styleproof report generates review and machine artifacts on command', () => {
  const before = makeMap({ elements: { '#title': { tag: 'h1', style: { color: 'rgb(0, 0, 0)' } } } });
  const after = makeMap({ elements: { '#title': { tag: 'h1', style: { color: 'rgb(255, 0, 0)' } } } });
  const fixture = pairFixture({ surface: 'home@1280', before, after });
  try {
    writeTrust(fixture.beforeDir, 'a'.repeat(40));
    writeTrust(fixture.afterDir, 'b'.repeat(40));
    const result = spawnSync(
      process.execPath,
      [cli, 'report', fixture.beforeDir, fixture.afterDir, '--out', fixture.outDir],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.equal(fs.existsSync(path.join(fixture.outDir, 'report.md')), true);
    assert.equal(fs.existsSync(path.join(fixture.outDir, 'report.json')), true);
    const report = JSON.parse(fs.readFileSync(path.join(fixture.outDir, 'report.json'), 'utf8'));
    assert.equal(report.surfaces.length, 1);
    assert.equal(report.surfaces[0].representative, 'home@1280');
  } finally {
    rmTmp(fixture.root);
  }
});
