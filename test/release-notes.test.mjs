import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
  ['Changed', [1083, 1179]],
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

function assertMigrationLink(changelog, readme, packageVersion) {
  const version = `${packageVersion.split('.')[0]}.0.0`;
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
}

test('the README migration link targets the major version CHANGELOG heading', () => {
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assertMigrationLink(changelog, readme, version);
});

for (const version of ['9.0.1', '9.1.0']) {
  test(`the ${version} README migration link still targets 9.0.0`, () => {
    const changelog = '## [9.0.0] - 2026-10-29\n';
    const readme = '[9.0.0 changelog](CHANGELOG.md#900---2026-10-29)';
    assertMigrationLink(changelog, readme, version);
    assert.throws(() => assertMigrationLink(changelog, readme.replace('#900', '#901'), version));
    assert.throws(() => assertMigrationLink(changelog, '', version));
  });
}

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

// Compare every sentence across wrapping and PR-reference-only edits.
function bulletKeys(notes) {
  return [...notes.matchAll(/^- (.*(?:\n[ \t]+[^\n]+)*)/gm)].flatMap(([, text]) =>
    text
      .replace(/\s*\(#\d+(?:, #\d+)*\)/g, '')
      .replace(/\*\*/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .split(/\.(?:\s+|$)/)
      .map((sentence) => sentence.trim())
      .filter(Boolean),
  );
}

test('the release notes command warns about Unreleased bullets and still writes the release', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-release-cut-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const output = path.join(directory, 'notes.md');
  const changelog = '## [Unreleased]\n\n- Future change.\n\n## [9.0.0]\n\n- Shipped change.\n';
  fs.writeFileSync(path.join(directory, 'CHANGELOG.md'), changelog);

  const pending = spawnSync(
    process.execPath,
    [path.join(root, 'scripts/release-notes.mjs'), '--version', '9.0.0', '--out', output],
    { cwd: directory, encoding: 'utf8' },
  );

  assert.equal(pending.status, 0, pending.stderr);
  assert.equal(pending.stderr, '::warning::the release cut left shipped bullets under [Unreleased]\n');
  assert.equal(pending.stdout, 'v9.0.0');
  assert.equal(fs.readFileSync(output, 'utf8'), '- Shipped change.\n');

  fs.writeFileSync(path.join(directory, 'CHANGELOG.md'), changelog.replace('- Future change.\n', ''));

  const ready = spawnSync(
    process.execPath,
    [path.join(root, 'scripts/release-notes.mjs'), '--version', '9.0.0', '--out', output],
    { cwd: directory, encoding: 'utf8' },
  );

  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(ready.stderr, '');
  assert.equal(ready.stdout, 'v9.0.0');
  assert.equal(fs.readFileSync(output, 'utf8'), '- Shipped change.\n');
});

test('sentence keys preserve later sentences and ignore wrapping and PR references', () => {
  assert.deepEqual(bulletKeys('- First sentence (#1). Later\n  sentence (#2, #3).'), [
    'First sentence',
    'Later sentence',
  ]);
});

test('release bullets are unique within and across Unreleased and 9.0.0', () => {
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const unreleased = changelog.split('## [Unreleased]')[1].split('\n## ')[0];
  const released = extractReleaseNotes(changelog, '9.0.0').body;
  const keys = [...bulletKeys(unreleased), ...bulletKeys(released)];
  const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
  assert.deepEqual(duplicates, [], 'duplicate release sentences (including PR-reference variants)');
});
