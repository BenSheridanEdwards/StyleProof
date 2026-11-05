import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('the reference describes sentence summaries and the additive JSON field', () => {
  const reference = fs.readFileSync(new URL('../docs/REFERENCE.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  assert.match(reference, /one plain-English line per change/);
  assert.match(reference, /sentences/);
  assert.doesNotMatch(reference, /names up to three elements|\+N more element\(s\)/);
});

test('the report-summary entry stays adjacent to the existing Unreleased list', () => {
  const changelog = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const unreleased = changelog.split('## [Unreleased]')[1].split(/^## /m)[0].trim();
  const lines = unreleased.split('\n');
  const summaryIndex = lines.findIndex((line) => line.startsWith('- Report summaries '));
  assert.ok(summaryIndex >= 0);
  assert.match(lines[summaryIndex + 1], /^- /, 'no blank line separating the summary from the next entry');
});
