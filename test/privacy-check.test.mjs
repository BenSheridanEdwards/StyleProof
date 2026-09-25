import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { findPrivacyFindings, denylist, missingDenylistWarning, publicFiles } from '../scripts/privacy-check.mjs';

test('privacy check allows public StyleProof links and localhost examples', () => {
  const findings = findPrivacyFindings([
    {
      file: 'README.md',
      text: [
        'https://github.com/BenSheridanEdwards/StyleProof/actions',
        'https://raw.githubusercontent.com/BenSheridanEdwards/StyleProof/main/docs/demo-composite.png',
        'http://localhost:3000',
      ].join('\n'),
    },
  ]);

  assert.deepEqual(findings, []);
});

test('privacy check flags local paths and file urls', () => {
  const findings = findPrivacyFindings([
    // Assembled from fragments so this scanned file never literally contains a
    // private-looking string; the joined runtime value still exercises each rule.
    { file: 'report.md', text: 'see /Users' + '/example/secret and file:' + '///tmp/crop.png' },
  ]);

  assert.deepEqual(
    findings.map((f) => f.rule),
    ['absolute local path', 'file url'],
  );
});

test('privacy check flags private-looking urls', () => {
  const findings = findPrivacyFindings([
    {
      file: 'proof.md',
      text: [
        'https://github.com/' + 'acme/internal-dashboard/pull/1',
        'http://' + '10.0.0.5/report',
        'https://ci.' + 'internal/build/123',
      ].join('\n'),
    },
  ]);

  assert.deepEqual(
    findings.map((f) => f.rule),
    ['private network url', 'internal hostname', 'github url outside allowlist'],
  );
});

test('privacy check supports an external denylist without committing private names', () => {
  const findings = findPrivacyFindings(
    [{ file: 'CHANGELOG.md', text: 'CustomerName shipped a dashboard.' }],
    ['CustomerName'],
  );

  assert.deepEqual(
    findings.map((f) => f.rule),
    ['denylist token'],
  );
});

test('a local gitignored denylist file is loaded and blocks the names it lists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-denylist-'));
  fs.writeFileSync(path.join(root, '.styleproof-privacy-denylist'), '# private names\nexample-private-name\n');
  const saved = process.env.STYLEPROOF_PRIVACY_DENYLIST;
  delete process.env.STYLEPROOF_PRIVACY_DENYLIST;
  try {
    const tokens = denylist(root);
    assert.deepEqual(tokens, ['example-private-name']);
    assert.equal(findPrivacyFindings([{ file: 'docs/x.md', text: 'see example-private-name HUD' }], tokens).length, 1);
  } finally {
    if (saved !== undefined) process.env.STYLEPROOF_PRIVACY_DENYLIST = saved;
  }
});

test('denylist matching is case-insensitive', () => {
  const findings = findPrivacyFindings(
    [{ file: 'notes.md', text: 'line one\nThe Example-Private-Name dashboard\nEXAMPLE-PRIVATE-NAME again' }],
    ['example-private-name'],
  );

  assert.deepEqual(
    findings.map((f) => [f.rule, f.line]),
    [['denylist token', 2]],
  );
});

test('every git-tracked text file is scanned, not only npm-pack files and a few dirs', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = publicFiles(root);
  // Tracked files outside the npm tarball and the old hardcoded dirs.
  for (const rel of ['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', '.agents/project/CONVENTIONS.md', '.gitignore']) {
    assert.ok(files.includes(rel), `privacy check must scan ${rel}`);
  }
  // The denylist itself is gitignored and must not be scanned (it would flag its own names).
  assert.ok(!files.includes('.styleproof-privacy-denylist'));
});

test('CI warns when the denylist secret is not configured, without failing', () => {
  assert.equal(
    missingDenylistWarning([], { GITHUB_ACTIONS: 'true' }),
    '::warning::privacy-check: STYLEPROOF_PRIVACY_DENYLIST secret is not configured; denylist tokens were not checked',
  );
  assert.equal(missingDenylistWarning(['example-private-name'], { GITHUB_ACTIONS: 'true' }), null);
  assert.equal(missingDenylistWarning([], {}), null);
});
