import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { reportCommentSummary } from '../dist/report-comment.js';

// QA1-02: gate codes are machine output (report.json, status contexts, Action
// outputs). A reader of report.md, report.html, the demo or the PR comment gets
// plain English instead.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// The codes come from the verdict's own type, so a new trust state is guarded too.
const trustStates = [...read('src/verdict.ts').matchAll(/\| '([A-Z_]+)'/g)].map((m) => m[1]);
const CODES = [...trustStates, 'REPORT_PUBLICATION_FAILED', 'base-capture-failed'];

/** What a reader sees: no hidden comments, scripts, styles or embedded image data. */
function visible(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[\s\S]*?<\/script>/g, '')
    .replace(/<style\b[\s\S]*?<\/style>/g, '')
    .replace(/data:[^"'\s)]+/g, '');
}

function assertNoCodes(label, text) {
  const shown = visible(text);
  for (const code of CODES) assert.ok(!shown.includes(code), `${label} shows the internal code ${code}`);
}

test('the guard knows every trust state', () => {
  assert.ok(trustStates.includes('STYLE_REVIEW_REQUIRED'));
  assert.ok(trustStates.includes('CERTIFICATION_FAILED'));
  assert.ok(trustStates.length >= 7, trustStates.join(', '));
});

test('the demo report shows no internal gate code (QA1-02)', () => {
  const md = read('docs/demo/report.md');
  // The demo has visible additions/removals, which used to name STYLE_REVIEW_REQUIRED.
  assert.match(md, /visible elements were added or removed\*\* — they need review\./);
  assertNoCodes('docs/demo/report.md', md);
  assertNoCodes('docs/demo/report.html', read('docs/demo/report.html'));
});

test('the README live report and its PR comment show no internal gate code (QA1-02)', () => {
  for (const file of ['report.md', 'report.html', 'comment.md']) {
    assertNoCodes(`docs/readme/live-report/${file}`, read(`docs/readme/live-report/${file}`));
  }
  const readme = read('README.md');
  const embedded = readme.slice(
    readme.indexOf('<!-- styleproof-report -->'),
    readme.indexOf('_Tick **Approve all changes**'),
  );
  assert.ok(embedded.length > 100, 'README embeds the live report comment');
  assertNoCodes('README report block', embedded);
});

test('the PR comment built from the demo report shows no internal gate code (QA1-02)', () => {
  const md = read('docs/demo/report.md');
  const base = 'https://github.com/BenSheridanEdwards/StyleProof/blob/' + 'a'.repeat(40) + '/pr-1/';
  assertNoCodes('text-only comment', reportCommentSummary(md));
  assertNoCodes('image comment', reportCommentSummary(md, { imageBase: base }));
});
