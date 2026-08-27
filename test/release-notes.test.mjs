import assert from 'node:assert/strict';
import test from 'node:test';

import { extractReleaseNotes } from '../scripts/release-notes.mjs';

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
