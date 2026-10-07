import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { extractReleaseNotes } from '../scripts/release-notes.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('extracts one version body and its explicit release title', () => {
  const changelog = `# Changelog

## [Unreleased]

## [6.2.0] - 2026-08-27

> **StyleProof 6.2.0: Release Confidence**

### Added

- Exact proof.

## [6.1.1] - 2026-08-27

- Older.
`;
  assert.deepEqual(extractReleaseNotes(changelog, '6.2.0'), {
    title: 'StyleProof 6.2.0: Release Confidence',
    body: '> **StyleProof 6.2.0: Release Confidence**\n\n### Added\n\n- Exact proof.',
  });
});

test('falls back to the version tag when a section or explicit title is absent', () => {
  assert.deepEqual(extractReleaseNotes('# Changelog\n', '6.2.0'), {
    title: 'v6.2.0',
    body: '',
  });
  assert.deepEqual(extractReleaseNotes('## [6.2.0]\n\n- Notes.\n', '6.2.0'), {
    title: 'v6.2.0',
    body: '- Notes.',
  });
});

test('rejects malformed versions and unsafe release titles', () => {
  assert.throws(() => extractReleaseNotes('', '6.2.0\nINJECTED=1'), /invalid release version/);
  assert.throws(() => extractReleaseNotes('## [6.2.0]\n\n> **Unsafe\u2028title**\n', '6.2.0'), /one safe line/);
});

// The release workflow publishes the package version's section as the GitHub
// release notes. Renaming the previous release's heading instead of adding a
// new one dropped [7.4.0] and published its entry again under 7.5.0 (#797).
test('the package version owns the newest CHANGELOG section, right after the previous release', () => {
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const [newest, previous] = [...changelog.matchAll(/^## \[(\d+)\.(\d+)\.(\d+)\]/gm)].map((match) =>
    match.slice(1, 4).map(Number),
  );
  assert.equal(newest.join('.'), version, 'the newest CHANGELOG section must be the package version');

  const [major, minor, patch] = newest;
  const [previousMajor, previousMinor, previousPatch] = previous;
  const followsPrevious =
    major === previousMajor
      ? minor === previousMinor
        ? patch === previousPatch + 1
        : minor === previousMinor + 1 && patch === 0
      : major === previousMajor + 1 && minor === 0 && patch === 0;
  assert.ok(
    followsPrevious,
    `[${version}] is followed by [${previous.join('.')}]: a released section was renamed or dropped`,
  );

  const subsections = extractReleaseNotes(changelog, version)
    .body.split('\n')
    .filter((line) => line.startsWith('### '));
  assert.equal(
    new Set(subsections).size,
    subsections.length,
    `the ${version} release notes repeat a subsection: ${subsections.join(', ')}`,
  );
});
