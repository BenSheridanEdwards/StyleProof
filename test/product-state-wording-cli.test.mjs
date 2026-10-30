import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COVERAGE_LEDGER } from '../dist/coverage.js';
import { makeMap, mkTmp, rmTmp, writeCapture } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIFF = path.join(ROOT, 'bin/styleproof-diff.mjs');
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);

function stampManifest(dir, sha) {
  fs.writeFileSync(
    path.join(dir, 'styleproof-manifest.json'),
    JSON.stringify({
      version: 1,
      packageVersion: 'test',
      sha,
      dirty: false,
      spec: 'e2e/styleproof.spec.ts',
      specHash: '1'.repeat(64),
      platform: process.platform,
      arch: process.arch,
      nodeMajor: process.versions.node.split('.')[0],
      screenshots: true,
      har: false,
      compatibilityKey: '0000000000000000',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  fs.writeFileSync(
    path.join(dir, COVERAGE_LEDGER),
    JSON.stringify({ version: 1, expected: ['home'], exclude: {}, determinism: 'self-checked' }),
  );
}

function fixture({ productState } = {}) {
  const root = mkTmp('styleproof-legacy-pairs-cli-');
  const before = path.join(root, 'before');
  const after = path.join(root, 'after');

  const map = {
    ...makeMap({
      elements: {
        'body > button:nth-child(1)': { tag: 'button', style: { color: 'black' } },
      },
    }),
  };

  if (productState) map.metadata = { productState };

  writeCapture(before, 'home@1280', map, null);
  writeCapture(after, 'home@1280', map, null);
  stampManifest(before, BASE_SHA);
  stampManifest(after, HEAD_SHA);

  return { root, before, after };
}

function runDiff(capture, extra = [], env = {}) {
  const json = path.join(capture.root, `diff-${extra.join('-') || 'default'}.json`);
  const childEnv = { ...process.env, ...env };

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
  }

  const result = spawnSync(
    process.execPath,
    [
      DIFF,
      capture.before,
      capture.after,
      '--json',
      json,
      '--expected-before-sha',
      BASE_SHA,
      '--expected-after-sha',
      HEAD_SHA,
      ...extra,
    ],
    { cwd: capture.root, encoding: 'utf8', env: childEnv },
  );

  return {
    ...result,
    json: fs.existsSync(json) ? JSON.parse(fs.readFileSync(json, 'utf8')) : null,
  };
}

// #1151: a brand-new capture pair that simply declares no productState must not be called "legacy".
test('#1151 fresh captures without a declared productState are not reported as legacy pairs', () => {
  const capture = fixture();

  try {
    const result = runDiff(capture);
    const said = `${result.stdout}\n${result.stderr}`;
    assert.doesNotMatch(said, /legacy/i, said);
    assert.match(said, /no product-?state (is )?declared/i, said);
  } finally {
    rmTmp(capture.root);
  }
});
