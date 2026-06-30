import assert from 'node:assert/strict';
import test from 'node:test';
import { findPrivacyFindings } from '../scripts/privacy-check.mjs';

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
