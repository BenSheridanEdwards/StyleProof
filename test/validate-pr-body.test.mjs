import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePullRequest, REQUIRED_SECTIONS } from '../scripts/validate-pr-body.mjs';

// A complete, well-formed body every section filled in - the baseline "good" input.
const GOOD_BODY = [
  '## Why',
  '',
  '- Moves StyleProof\'s North Star by making every PR carry a show-me reviewer view.',
  '',
  '## What changed',
  '',
  '- Replaced the PR template with the eight-section shape and updated the body validator.',
  '',
  '## Reviewer view',
  '',
  '- Mermaid of the eight PR sections (see this PR body).',
  '',
  '## Proof',
  '',
  '- Not applicable: docs and validator-only change with no rendered UI.',
  '',
  '## Behaviour changes',
  '',
  '- None - documentation and CI body rules only.',
  '',
  '## Not asked for',
  '',
  '- None.',
  '',
  '## Review guide',
  '',
  '- Start with `.github/PULL_REQUEST_TEMPLATE.md`, then `scripts/validate-pr-body.mjs`.',
  '',
  '## Verification summary',
  '',
  '- Commands run: node --test test/validate-pr-body.test.mjs',
  '- Results: pass',
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
  const body = GOOD_BODY.replace(/## What changed[\s\S]*?(?=## Reviewer view)/, '');
  const result = validatePullRequest({ title: GOOD_TITLE, body });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('What changed')));
});

test('a placeholder-only section fails', () => {
  const body = GOOD_BODY.replace('- Replaced the PR template with the eight-section shape and updated the body validator.', '-');
  const result = validatePullRequest({ title: GOOD_TITLE, body });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('placeholders')));
});

test('a Proof section with no image and no "Not applicable" fails', () => {
  const body = GOOD_BODY.replace(
    '- Not applicable: docs and validator-only change with no rendered UI.',
    '- Some prose but no screenshot and no exemption.',
  );
  const result = validatePullRequest({ title: GOOD_TITLE, body });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('Proof must embed')));
});

test('a non-Conventional-Commits title fails', () => {
  const result = validatePullRequest({ title: 'add some gates', body: GOOD_BODY });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('Conventional Commits')));
});

// The shipped template and the validator must never drift: every REQUIRED_SECTIONS
// heading has to exist in the template, spelled identically and in the same order,
// or an author who follows the template verbatim still fails CI. This locks them
// together - rename a heading on either side and this test goes red.
test('the shipped PR template carries every required section, verbatim and in order', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const template = fs.readFileSync(path.join(here, '..', '.github', 'PULL_REQUEST_TEMPLATE.md'), 'utf8');
  const headings = [...template.matchAll(/^#{1,6}\s+(.*?)\s*$/gm)].map((m) => m[1]);
  let last = -1;
  for (const section of REQUIRED_SECTIONS) {
    const index = headings.indexOf(section);
    assert.notEqual(index, -1, `template is missing required heading: "${section}"`);
    assert.ok(index > last, `template heading out of order: "${section}"`);
    last = index;
  }
});

test('sections in the wrong order fail', () => {
  const body = [
    '## What changed',
    '- swapped ahead of Why.',
    '## Why',
    '- reason.',
    '## Reviewer view',
    '- Not needed: fixture.',
    '## Proof',
    '- Not applicable: infra change.',
    '## Behaviour changes',
    '- None.',
    '## Not asked for',
    '- None.',
    '## Review guide',
    '- Start here.',
    '## Verification summary',
    '- ran the suite.',
  ].join('\n');
  const result = validatePullRequest({ title: GOOD_TITLE, body });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('out of order')));
});

// ────────────────────────────────────────────────────────────────────────────────
// Ticket-dump opening detection (TDD fixtures for #526)
// ────────────────────────────────────────────────────────────────────────────────

// Ticket-dump openings that MUST fail - they start with issue refs, not buyer-legible prose.
const BAD_OPENINGS = [
  'Fixes #517, #518, #519 in the v2 import pipeline.',
  'Implements [#520](url) - TDD fixture coverage plan.',
  'Part of parent chain #491. Closes #513, #514.',
  '1. Propagate baseline capture failures into DiffResult (#513)\n2. Distinguish new surfaces (#514)',
  'Closes #500. The system needed this change.',
  '(#521) This PR addresses the linked issue.',
  'Resolves #100 by updating the config.',
];

// Buyer-legible openings that MUST pass - prose motivation first, then ticket refs.
const GOOD_OPENINGS = [
  'Users importing oracle-proven bundles into the v2 store lost their proven status, degrading trust without warning. This broke adopters who relied on proven status for CI gating. Fixes #517.',
  'When a baseline capture fails, reviewers cannot distinguish genuine new surfaces from repair debt. This PR adds classification so reviewers know what requires action. Part of #491.',
  'The README claimed the embedded report was unmodified, but the script reorders sections and injects CSS. This PR fixes the documentation to match reality. Closes #479.',
  'Reviewers opening a PR could not immediately understand why it mattered - they saw ticket numbers, not user pain. This change gates PR bodies on buyer-legible prose before any issue references.',
];

function makeBodyWithWhyOpening(opening) {
  return [
    '## Why',
    '',
    opening,
    '',
    '## What changed',
    '',
    '- Updated the relevant files.',
    '',
    '## Reviewer view',
    '',
    '- Not needed: fixture for Why-opening validation.',
    '',
    '## Proof',
    '',
    '- Not applicable: infra change.',
    '',
    '## Behaviour changes',
    '',
    '- None.',
    '',
    '## Not asked for',
    '',
    '- None.',
    '',
    '## Review guide',
    '',
    '- Start here.',
    '',
    '## Verification summary',
    '',
    '- Commands run: npm test.',
    '- Results: pass.',
  ].join('\n');
}

for (const opening of BAD_OPENINGS) {
  test(`ticket-dump opening fails: "${opening.slice(0, 50)}..."`, () => {
    const body = makeBodyWithWhyOpening(opening);
    const result = validatePullRequest({ title: GOOD_TITLE, body });
    assert.equal(result.valid, false, `Expected failure for: ${opening}`);
    assert.ok(
      result.errors.some((e) => e.includes('buyer-legible') || e.includes('ticket')),
      `Expected ticket-dump error for: ${opening}`,
    );
  });
}

for (const opening of GOOD_OPENINGS) {
  test(`buyer-legible opening passes: "${opening.slice(0, 50)}..."`, () => {
    const body = makeBodyWithWhyOpening(opening);
    const result = validatePullRequest({ title: GOOD_TITLE, body });
    assert.equal(result.valid, true, `Expected pass for: ${opening}`);
  });
}
