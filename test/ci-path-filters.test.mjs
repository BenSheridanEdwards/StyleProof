import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DOGFOOD_PATH_GLOBS, E2E_PATH_GLOBS, shouldRunDogfood, shouldRunE2e } from '../scripts/ci-path-filters.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

test('docs-only and changelog-only PRs skip dogfood and e2e (audit #788 / #800)', () => {
  assert.equal(shouldRunDogfood(['docs/NORTH_STAR.md']), false);
  assert.equal(shouldRunE2e(['docs/NORTH_STAR.md']), false);
  assert.equal(shouldRunDogfood(['CHANGELOG.md', 'test/release-notes.test.mjs']), false);
  assert.equal(shouldRunE2e(['CHANGELOG.md', 'test/release-notes.test.mjs']), false);
});

test('pure unit-test PRs skip dogfood and e2e (audit #790 / #809)', () => {
  assert.equal(shouldRunDogfood(['test/check-coverage.test.mjs']), false);
  assert.equal(shouldRunE2e(['test/check-coverage.test.mjs']), false);
  assert.equal(shouldRunDogfood(['test/foo.test.mjs', 'test/bar.test.mjs']), false);
});

test('capture engine and example surfaces still schedule dogfood and e2e', () => {
  assert.equal(shouldRunDogfood(['src/capture/index.ts']), true);
  assert.equal(shouldRunE2e(['src/runner/play.ts']), true);
  assert.equal(shouldRunDogfood(['example/demo/index.html']), true);
  assert.equal(shouldRunE2e(['test/smoke.e2e.spec.ts']), true);
  assert.equal(shouldRunDogfood(['action.yml']), true);
});

test('dogfood workflows declare pull_request paths that cover product surfaces', () => {
  for (const name of [
    'styleproof-dogfood.yml',
    'action-dogfood.yml',
    'store-dogfood.yml',
    'phase1-advisory-dogfood.yml',
  ]) {
    const yml = fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8');
    assert.match(yml, /pull_request:\n(?: {4}.+\n)* {4}paths:/, `${name} must use pull_request.paths`);
    assert.match(yml, /- 'src\/\*\*'/, `${name} includes src/**`);
    assert.match(yml, /- 'package\.json'/, `${name} includes package.json`);
    assert.match(yml, /- 'example\/\*\*'/, `${name} includes example/**`);
    // Must NOT fire on docs-only: paths filter means docs-only PRs never start the workflow.
    assert.doesNotMatch(yml, /- 'docs\/\*\*'/, `${name} must not list docs/** as a trigger`);
  }
});

test('CI path-filters e2e and detection; required accepts skipped browser lanes', () => {
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, / {2}changes:\n[\s\S]*dorny\/paths-filter@/);
  assert.match(ci, /outputs:\n(?: {6}.+\n)* {6}e2e: \$\{\{ steps\.filter\.outputs\.e2e \}\}/);
  assert.match(ci, / {2}e2e:\n(?: {4}.+\n)* {4}if: needs\.changes\.outputs\.e2e == 'true'/);
  assert.match(ci, / {2}detection-corpus:\n(?: {4}.+\n)* {4}if: needs\.changes\.outputs\.e2e == 'true'/);
  assert.match(ci, / {2}required:\n(?: {4}.+\n)* {4}if: always\(\)/);
  assert.match(ci, /E2E_RESULT:/);
  assert.match(ci, /want success or skipped/);
  // Pin every e2e glob from the module into the workflow filters block.
  for (const glob of E2E_PATH_GLOBS) {
    assert.match(ci, new RegExp(`- '${glob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`), `ci.yml pins ${glob}`);
  }
});

test('DOGFOOD_PATH_GLOBS stay the shared contract for workflow path lists', () => {
  assert.ok(DOGFOOD_PATH_GLOBS.includes('src/**'));
  assert.ok(DOGFOOD_PATH_GLOBS.includes('action.yml'));
  assert.ok(E2E_PATH_GLOBS.includes('src/capture/**'));
  assert.ok(E2E_PATH_GLOBS.includes('test/**/*.e2e.spec.ts'));
});
