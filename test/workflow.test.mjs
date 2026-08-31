import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const ci = fs.readFileSync(path.join(here, '..', '.github/workflows/ci.yml'), 'utf8');
const release = fs.readFileSync(path.join(here, '..', '.github/workflows/release.yml'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));

test('CI runs E2E in parallel without deleting unit, platform, or determinism evidence', () => {
  const buildJob = ci.match(/ {2}build:[\s\S]*?(?=\n {2}e2e:)/)?.[0] ?? '';
  const e2eJob = ci.match(/ {2}e2e:[\s\S]*?(?=\n {2}cli-smoke:)/)?.[0] ?? '';
  const cliSmoke = ci.match(/ {2}cli-smoke:[\s\S]*?(?=\n {2}required:)/)?.[0] ?? '';
  const required = ci.match(/ {2}required:[\s\S]*$/)?.[0] ?? '';

  assert.equal(packageJson.scripts['test:unit'], 'node --test test/*.test.mjs');
  assert.match(buildJob, /matrix:\n[\s\S]*node: \['18', '20', '22'\]/);
  assert.match(buildJob, /npm run build/);
  assert.match(buildJob, /npm run test:unit/);
  assert.doesNotMatch(buildJob, /playwright|determinism-oracle/);
  assert.doesNotMatch(buildJob, /npm test|npm run test:e2e|npm run typecheck/);

  assert.match(e2eJob, /name: e2e \(node 22\)/);
  assert.match(e2eJob, /node-version: '22'/);
  assert.match(e2eJob, /run: npm ci/);
  assert.match(e2eJob, /run: npm run build/);
  assert.match(e2eJob, /run: npx playwright test\n/);
  assert.doesNotMatch(e2eJob, /--grep|--shard|needs:/);
  assert.match(e2eJob, /missing determinism oracle receipt/);
  assert.match(e2eJob, /name: determinism-oracle-node-22/);
  assert.match(e2eJob, /if-no-files-found: error/);

  assert.match(cliSmoke, /npm run build/);
  assert.match(cliSmoke, /node --test test\/package-smoke\.test\.mjs/);
  assert.doesNotMatch(cliSmoke, /npm run typecheck|playwright/);

  assert.match(required, /name: required/);
  assert.match(required, /if: always\(\)/);
  assert.match(required, /needs: \[build, e2e, cli-smoke\]/);
  assert.match(required, /BUILD_RESULT: \$\{\{ needs\.build\.result \}\}/);
  assert.match(required, /E2E_RESULT: \$\{\{ needs\.e2e\.result \}\}/);
  assert.match(required, /CLI_SMOKE_RESULT: \$\{\{ needs\.cli-smoke\.result \}\}/);
  assert.match(required, /set -euo pipefail/);
  assert.match(required, /test "\$BUILD_RESULT" = success/);
  assert.match(required, /test "\$E2E_RESULT" = success/);
  assert.match(required, /test "\$CLI_SMOKE_RESULT" = success/);
  assert.doesNotMatch(required, /actions\/checkout/);
});

test('CI runs a small non-Linux CLI smoke without the browser suite', () => {
  assert.match(ci, /cli-smoke:/);
  assert.match(ci, /os: \[macos-latest, windows-latest\]/);
  assert.match(ci, /node-version: '22'/);
  assert.match(ci, /node --test test\/package-smoke\.test\.mjs/);
  assert.doesNotMatch(ci.match(/cli-smoke:[\s\S]*$/)?.[0] ?? '', /npm run test:e2e/);
});

test('release runs serialize without cancelling an in-flight publish', () => {
  assert.match(
    release,
    /concurrency:\n {2}group: styleproof-release\n {2}cancel-in-progress: false/,
    'main pushes must queue behind an active release so one version cannot publish and tag concurrently',
  );
});

test('release completion requires npm, tag, and GitHub Release receipts', () => {
  assert.match(release, /npm view "styleproof@\$\{VERSION\}" version/);
  assert.match(release, /TAG_SHA="\$\(git rev-list -n 1 "v\$VERSION"/);
  assert.match(release, /gh release view "v\$VERSION"/);
  assert.match(
    release,
    /\[ "\$PUBLISHED" = "\$VERSION" \].*\[ -n "\$TAG_SHA" \].*\[ "\$RELEASE_TAG" = "v\$VERSION" \]/s,
  );
});

test('release repair preserves an existing version tag and names the GitHub Release from notes', () => {
  const tagStep = release.match(/- name: Tag the release[\s\S]*?(?=\n {6}- name:|\n {2}# Mirror)/)?.[0] ?? '';
  assert.match(tagStep, /if git rev-parse "v\$VERSION"/);
  assert.match(tagStep, /already exists/);
  assert.match(release, /release_name=/);
  assert.match(release, /name: \$\{\{ steps\.notes\.outputs\.release_name \}\}/);
  assert.match(release, /git tag -f "\$MAJOR" "v\$\{\{ steps\.check\.outputs\.version \}\}"/);
});
