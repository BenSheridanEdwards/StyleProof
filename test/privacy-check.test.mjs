import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { findPrivacyFindings, denylist } from '../scripts/privacy-check.mjs';

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
    { file: 'report.md', text: 'see /Users/example/secret and file:///tmp/crop.png' },
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
        'https://github.com/acme/internal-dashboard/pull/1',
        'http://10.0.0.5/report',
        'https://ci.internal/build/123',
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

test('the shipped denylist file is loaded and blocks the private project names', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const tokens = denylist(root);
  for (const name of ['Fleet', 'F.L.E.E.T']) {
    assert.ok(tokens.includes(name), `denylist must list ${name}`);
    // and the loaded token actually flags a doc that mentions it
    assert.equal(findPrivacyFindings([{ file: 'docs/x.md', text: `see ${name} HUD` }], tokens).length >= 1, true);
  }
});
