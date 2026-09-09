// #479 — the README's embedded StyleProof block must describe how it was actually made.
//
// The block is not a mockup, but it is not an untouched product report either:
// scripts/live-readme-report.mjs feeds a static demo page a hard-coded CSS change,
// renders the report, reorders its sections, drops report.json, rewrites the crop
// links, and appends the approval box — i.e. it embeds the PR COMMENT. The README
// once called that "the unmodified product report".
//
// AGENTS.md: "If evidence weakens a claim, fix the evidence or qualify/remove the
// claim." These tests pin the qualification to the script, in BOTH directions, so
// neither can drift without the other failing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const script = fs.readFileSync(path.join(root, 'scripts', 'live-readme-report.mjs'), 'utf8');
const comment = fs.readFileSync(path.join(root, 'docs', 'readme', 'live-report', 'comment.md'), 'utf8');

/** The prose that introduces the embedded block — everything before its marker. */
const preamble = readme.slice(0, readme.indexOf('<!-- styleproof-report -->'));

test('the README never calls the embedded block an unmodified product report (#479)', () => {
  assert.doesNotMatch(
    readme,
    /unmodified product report/,
    'the script reorders the report, drops report.json and appends the approval box',
  );
  assert.doesNotMatch(preamble, /\buntouched\b|\bverbatim\b|\bas-is\b/i);
});

test('every edit the script makes is disclosed in the README preamble (#479)', () => {
  // Each entry: [what the script demonstrably does, what the README must therefore say].
  const disclosures = [
    [/const HEAD_CSS = `/, /injecting a\s+fixed CSS change/, 'a hard-coded CSS change is injected'],
    [/example\/demo\/index\.html/, /example\/demo\/index\.html/, 'the input is the static demo page'],
    [/function restingChangesFirst/, /sections reordered/, 'element-level sections are reordered'],
    [/rmSync\(res\.reportJsonPath/, /`report\.json` left out/, 'report.json is dropped from the bundle'],
    [/replaceAll\('\(crops\/'/, /crop links repointed/, 'crop links are rewritten'],
    [/'- \[ \] \*\*Approve all changes\*\*'/, /is that comment/, 'the block is the PR comment, not the report'],
  ];
  for (const [inScript, inReadme, what] of disclosures) {
    assert.match(script, inScript, `the script should still ${what}`);
    assert.match(preamble, inReadme, `the README must disclose that ${what}`);
  }
});

test('the disclosure count matches the edits the script makes to the report (#479)', () => {
  // Reorder, drop report.json, repoint crops. Appending the approval box is covered
  // separately by "the block is that comment". If someone adds a fourth edit, this
  // fails until the prose is updated to match.
  const edits = [/function restingChangesFirst/, /rmSync\(res\.reportJsonPath/, /replaceAll\('\(crops\/'/];
  const applied = edits.filter((pattern) => pattern.test(script)).length;
  assert.equal(applied, 3, 'the script should still make exactly these three edits');
  assert.match(preamble, /three edits for this page/);
});

test('the README still embeds the generated comment verbatim (#479)', () => {
  assert.ok(
    readme.includes(comment.trim()),
    'the embedded block must be the artifact the script wrote, not a hand-edited copy',
  );
  // The claim "every finding, value and crop is what the run produced" is only true
  // while the README carries the generated file unchanged, so pin both together.
  assert.match(preamble, /Every\s+finding, value, and crop is what the run produced/);
});

test('the README does not oversell the demo page as an application (#479)', () => {
  assert.match(preamble, /a real run, not a mockup/, 'the run is genuine and may be described as such');
  assert.doesNotMatch(preamble, /real (application|product|app)\b/i);
});
