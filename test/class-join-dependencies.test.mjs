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

for (const key of ['app.ts', 'app.tsx'])
  test(`a generic type parameter is not a class attribute: ${key}`, () => {
    const literals = classLiterals("function f<T extends unknown, className = 'old'>(){}", key);
    assert.ok(literals.every((l) => !l.explicit));
  });

for (const key of ['app.ts', 'app.tsx'])
  test(`a generic arrow parameter is not a class attribute: ${key}`, () => {
    const literals = classLiterals("const f = <T extends unknown, className = 'old'>() => null;", key);
    assert.ok(literals.every((l) => !l.explicit));
  });

for (const source of [
  'function cn({ old: x }) {}',
  "function cn(x?: 'old') {}",
  'class C { cn({ old: x }); }',
  "interface M { cn({ old: x }); class: 'old' }",
  "type M = { cn({ old: x }); class: 'old' }",
])
  test(`declarations do not supply class-helper arguments: ${source}`, () => {
    assert.ok(classLiterals(source, 'app.ts').every((l) => !l.explicit));
  });

for (const source of [
  'function render() { return cn({ old: on }); }',
  'class C { render() { return cn({ old: on }); } }',
  'class C { classes = cn({ old: on }); }',
])
  test(`helper values inside runtime bodies remain positive: ${source}`, () => {
    assert.ok(classLiterals(source, 'app.ts').some((l) => l.explicit && l.words.some((w) => w.token === 'old')));
  });
