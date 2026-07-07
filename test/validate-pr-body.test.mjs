import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePullRequest } from '../scripts/validate-pr-body.mjs';

// A complete, well-formed body every section filled in — the baseline "good" input.
const GOOD_BODY = [
  '# Why does this feature exist?',
  '',
  '- To gate PRs on a complete, proof-carrying body.',
  '',
  '# What changed?',
  '',
  '- Added a machine validator and a workflow that runs it.',
  '',
  '# Behavioural Proof (with video and screenshots)',
  '',
  '- Not applicable: this is a CLI/infra change with no rendered UI.',
  '',
  '# Verification Summary',
  '',
  '- Definition of Done: followed.',
  '- Commands run: npm test.',
].join('\n');

const GOOD_TITLE = 'feat(gates): add machine PR-body validation';

test('a complete body with a Conventional title passes', () => {
  const result = validatePullRequest({ title: GOOD_TITLE, body: GOOD_BODY });
  assert.deepEqual(result, { valid: true, errors: [] });
});

test('a body embedding an inline screenshot passes the proof rule', () => {
  const body = GOOD_BODY.replace(
    '- Not applicable: this is a CLI/infra change with no rendered UI.',
    '![screenshot](https://github.com/BenSheridanEdwards/StyleProof/blob/main/docs/proof/x.png?raw=1)',
  );
  assert.equal(validatePullRequest({ title: GOOD_TITLE, body }).valid, true);
});

test('a missing required section fails', () => {
  const body = GOOD_BODY.replace(/# What changed\?[\s\S]*?(?=# Behavioural)/, '');
  const result = validatePullRequest({ title: GOOD_TITLE, body });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('What changed?')));
});

test('a placeholder-only section fails', () => {
  const body = GOOD_BODY.replace('- Added a machine validator and a workflow that runs it.', '-');
  const result = validatePullRequest({ title: GOOD_TITLE, body });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('placeholders')));
});

test('a Behavioural Proof section with no image and no "Not applicable" fails', () => {
  const body = GOOD_BODY.replace(
    '- Not applicable: this is a CLI/infra change with no rendered UI.',
    '- Some prose but no screenshot and no exemption.',
  );
  const result = validatePullRequest({ title: GOOD_TITLE, body });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('Behavioural Proof must embed')));
});

test('a non-Conventional-Commits title fails', () => {
  const result = validatePullRequest({ title: 'add some gates', body: GOOD_BODY });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('Conventional Commits')));
});

test('sections in the wrong order fail', () => {
  const body = [
    '# What changed?',
    '- swapped ahead of Why.',
    '# Why does this feature exist?',
    '- reason.',
    '# Behavioural Proof (with video and screenshots)',
    '- Not applicable: infra change.',
    '# Verification Summary',
    '- ran the suite.',
  ].join('\n');
  const result = validatePullRequest({ title: GOOD_TITLE, body });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('out of order')));
});
