import assert from 'node:assert/strict';
import test from 'node:test';
import { EIGHT_SECTION_HEADINGS, missingEightSections } from '../scripts/eight-section-pr-body.mjs';
import { REQUIRED_SECTIONS } from '../scripts/validate-pr-body.mjs';

test('canonical eight-section headings are stable', () => {
  assert.deepEqual(
    [...EIGHT_SECTION_HEADINGS],
    [
      'Why',
      'What changed',
      'Reviewer view',
      'Proof',
      'Behaviour changes',
      'Not asked for',
      'Review guide',
      'Verification summary',
    ],
  );
});

test('missingEightSections reports gaps in order', () => {
  const body = '## Why\n\nx\n\n## What changed\n\ny\n';
  assert.deepEqual(missingEightSections(body), [
    'Reviewer view',
    'Proof',
    'Behaviour changes',
    'Not asked for',
    'Review guide',
    'Verification summary',
  ]);
});

test('StyleProof validate-pr-body REQUIRED_SECTIONS matches the shared contract', () => {
  assert.deepEqual(REQUIRED_SECTIONS, [...EIGHT_SECTION_HEADINGS]);
});
