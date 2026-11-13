import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { visibleText } from './visible-text.mjs';

// QA1-02: gate codes are machine output (report.json, status contexts, Action
// outputs). A reader of report.md, report.html, the demo or the PR comment gets
// plain English instead.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// The codes come from the verdict's own type, so a new trust state is guarded too.
const trustStates = [...read('src/verdict.ts').matchAll(/\| '([A-Z_]+)'/g)].map((m) => m[1]);
const CODES = [...trustStates, 'REPORT_PUBLICATION_FAILED', 'base-capture-failed'];

function assertNoCodes(label, text) {
  const shown = visibleText(text);
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
  assert.match(
    md,
    /🧱 \*\*2 visible element addition\(s\)\/removal\(s\)\*\* need review — approve them with the other changes\./,
  );
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
  const heading = md.search(/^### /m);
  assert.ok(heading > 0, 'the report has a detail heading after its summary');
  assertNoCodes('PR comment prefix', md.slice(0, heading));
});
