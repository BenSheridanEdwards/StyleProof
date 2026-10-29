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

for (const [section, prs] of [
  ['Fixed', [1091, 1093, 1094]],
  ['Changed', [1083]],
]) {
  test(`9.0.0 ${section} release notes include the shipped CI and upload changes`, () => {
    const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const { body } = extractReleaseNotes(changelog, '9.0.0');
    const notes = body.split(`### ${section}\n`)[1]?.split('\n### ')[0] ?? '';
    for (const pr of prs) {
      assert.ok(notes.includes(`#${pr}`), `9.0.0 ${section} release notes must include #${pr}`);
    }
  });
}

test('the README migration link targets the package version CHANGELOG heading', () => {
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const heading = changelog.split('\n').find((line) => line.startsWith(`## [${version}]`));
  assert.ok(heading, `the CHANGELOG must have a heading for ${version}`);

  const anchor = heading
    .slice(3)
    .toLowerCase()
    .replace(/[[\].]/g, '')
    .replace(/ /g, '-');

  const migrationLink = [...readme.matchAll(/\[([^\]]+)\]\(CHANGELOG\.md#([^)]+)\)/g)].find(
    ([, label]) => label === `${version} changelog`,
  );

  assert.ok(migrationLink, `the README must link to the ${version} migration list`);
  assert.equal(migrationLink[2], anchor, 'the README migration link must match the release heading anchor');
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

// Compare opening bullet text across wrapping and PR-reference-only edits.
function bulletKeys(notes) {
  return [...notes.matchAll(/^- (.*(?:\n[ \t]+[^\n]+)*)/gm)].map(([, text]) =>
    text
      .split(/\.\s/)[0]
      .replace(/\s*\(#\d+(?:, #\d+)*\)/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

test('9.0.0 includes all changes at the release cut', () => {
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const unreleased = changelog.split('## [Unreleased]')[1].split('\n## ')[0];
  assert.deepEqual(bulletKeys(unreleased), [], 'the release cut must leave no shipped bullets unreleased');
});

test('release bullets are unique within and across Unreleased and 9.0.0', () => {
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const unreleased = changelog.split('## [Unreleased]')[1].split('\n## ')[0];
  const released = extractReleaseNotes(changelog, '9.0.0').body;
  const keys = [...bulletKeys(unreleased), ...bulletKeys(released)];
  assert.equal(new Set(keys).size, keys.length, 'duplicate release bullets (including PR-reference variants)');
});
