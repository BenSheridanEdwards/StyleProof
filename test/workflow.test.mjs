import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const ci = fs.readFileSync(path.join(here, '..', '.github/workflows/ci.yml'), 'utf8');
const release = fs.readFileSync(path.join(here, '..', '.github/workflows/release.yml'), 'utf8');

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
