import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('every explicitly published documentation file exists', () => {
  const root = new URL('../', import.meta.url);
  const pkg = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'));
  for (const entry of pkg.files.filter((entry) => entry.startsWith('docs/'))) {
    assert.ok(fs.existsSync(new URL(entry, root)), `Missing published documentation: ${entry}`);
  }
});
