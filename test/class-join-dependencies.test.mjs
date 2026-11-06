import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { classLiterals } from '../dist/class-join-literals.js';

test('ADR 0009 permits no runtime dependency beyond pngjs', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['pngjs']);
});

test('class role nesting is capped with a named gap through EOF', () => {
  const source = 'el.className = ' + '('.repeat(6000) + "'old'" + ')'.repeat(6000) + ";\nel.className = 'new';";
  const literals = classLiterals(source, 'app.tsx');
  const gap = literals.find((l) => l.extractionGap && /depth.*limit/.test(l.residual));
  assert.ok(gap, JSON.stringify(literals));
  assert.equal(gap.range.end.line, 2);
  assert.ok(literals.every((l) => !l.explicit));
});
