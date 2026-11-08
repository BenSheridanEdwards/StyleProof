import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classLiterals } from '../dist/class-join-literals.js';
import { classifyClassReach, combineClassReach } from '../dist/class-join.js';
import { changedScriptRanges } from '../dist/script-join-git.js';
import { assertLinearScaling } from './linearity-helper.mjs';

for (const source of [
  "function f(e: { class: 'old'; id: string }) {}",
  "const p: { className: 'old' } = value;",
  "(p: { className: 'old' }) => p;",
  "let cols: { class: 'old' }[];",
  "(r): { class: 'old' } => r;",
  "function f(e?: { class: 'old' }) {}",
  "const f = (e?: { className: 'old' }) => e;",
  "let p!: { class: 'old' };",
  "function f({id}: { class: 'old' }) {}",
  "const cfg = { method(r): { class: 'old' } { return r; } };",
  "function f<T extends { class: 'old' }>(p: T) {}",
  "const p = value as { class: 'old' };",
  "const p = value satisfies { class: 'old' };",
])
  test(`inline type has no positive class role: ${source}`, () => {
    const literals = classLiterals(source, 'app.ts').filter((l) => l.words.some((w) => w.token === 'old'));
    assert.equal(literals.length, 1);
    assert.ok(
      literals.every((l) => !l.explicit),
      JSON.stringify(literals),
    );
  });

for (const source of [
  "const cfg = { row: { class: 'old' } };",
  "const cfg = on ? value : { class: 'old' };",
  "const cfg = on ? get() : { class: 'old' };",
  "const cfg = { row: on ? value : { class: 'old' } };",
  "h('div', { class: 'old' });",
  "const cfg = { [key]: { class: 'old' } };",
])
  test(`runtime property/ternary colon keeps class values: ${source}`, () => {
    assert.ok(classLiterals(source, 'app.ts').some((l) => l.explicit && l.words.some((w) => w.token === 'old')));
  });

test('a bracket cap preserves completed positive roots before the incomplete frame', () => {
  const source =
    "el.className='old';\nconst deep=" + '('.repeat(6000) + 'x' + ')'.repeat(6000) + ";\nel.className='new';";
  const literals = classLiterals(source, 'app.ts');
  assert.ok(literals.some((l) => l.explicit && l.words.some((w) => w.token === 'old')));
  const gap = literals.find((l) => l.extractionGap && /depth.*limit/.test(l.residual));
  assert.ok(gap);
  assert.equal(gap.range.start.line, 2);
  assert.equal(gap.range.end.line, 3);
});

test('the depth gap covers unread words in an incomplete enclosing helper', () => {
  const source = "cn('old', " + '('.repeat(6000) + 'x' + ')'.repeat(6000) + ');';
  const literals = classLiterals(source, 'app.ts');
  const gap = literals.find((l) => l.extractionGap && /depth.*limit/.test(l.residual));
  assert.ok(gap);
  assert.ok(gap.range.start.column <= source.indexOf("'old'"), JSON.stringify(gap));
});

test('flat else-if arms scale linearly to eighty thousand without a depth gap', (t) => {
  assertLinearScaling(t, {
    name: 'flat else-if extraction',
    n: 20000,
    make: (count) => 'el.className=' + Array.from({ length: count }, (_, i) => `a${i}?'old':`).join('') + "'new';",
    run: (source) => classLiterals(source, 'app.ts'),
    check: (literals, source, count) => {
      assert.equal(literals.filter((l) => l.explicit && l.words.length).length, count + 1);
      assert.ok(!literals.some((l) => l.extractionGap));
    },
  });
});

function residual(base, head) {
  const changes = changedScriptRanges(`@@ -1 +1 @@\n-${base}\n+${head}\n`, { base, head }, 'app.ts');
  const map = {
    defaults: {},
    states: {},
    elements: {},
    classPresence: {
      version: 2,
      ignored: false,
      shadowHosts: 0,
      frames: 0,
      outsideBody: 0,
      shadowRootsVerified: true,
      documentBoundsVerified: true,
    },
    reach: {
      version: 2,
      scope: 'compared',
      sheets: ['app.css'],
      rules: [{ key: '.old.new.card', hash: 'x', sheet: 0 }],
    },
  };
  const result = classifyClassReach([map], [map], changes, [{ base: map, head: map }]);
  assert.deepEqual(result.units, []);
  assert.deepEqual(result.gaps, []);
  const scripts = changes.map(({ sourceKey, side, range }) => ({
    sourceKey,
    side,
    range,
    execution: 'ran',
    status: 'unknown',
    why: 'value; rendering not proved',
    level: 'warn',
  }));
  assert.ok(combineClassReach(scripts, result.units).every((u) => u.status === 'unknown'));
}

test('pinned residual: receiver-only changes retain no J3 occurrence', () => {
  residual("el1.className='card';", "el2.className='card';");
});

test('pinned QA residual: unchanged neighbouring words can mask changed occurrences', () => {
  residual("el.className='old'; other.className='old new';", "el.className='new'; other.className='old new';");
});

test('a substitution bracket cap covers its unread positive prefix', () => {
  const source = "el.className=`${on?'old':fn(" + '('.repeat(6000) + 'x' + ')'.repeat(6000) + ')}`;';
  const gap = classLiterals(source, 'app.ts').find((l) => l.extractionGap && /depth.*limit/.test(l.residual));
  assert.ok(gap);
  assert.ok(gap.range.start.column <= source.indexOf("'old'"), JSON.stringify(gap));
});
