import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { classLiterals } from '../dist/class-join-literals.js';
import { classifyClassReach, combineClassReach } from '../dist/class-join.js';
import { changedScriptRanges } from '../dist/script-join-git.js';

const types = [
  "function f<T extends A<B>={class:'tk-old'}>() {}",
  "type C<T>=T extends {class:'tk-old'}?{className:'tk-old'}:never;",
  "type C<T=A<B>>=T extends {class:'tk-old'}?{className:'tk-old'}:never;",
  "type C<T=A<B<C>>>=T extends {class:'tk-old'}?{className:'tk-old'}:never;",
  "let x: A<{class:'tk-old'}>=v;",
  "function f<T>(x:A<{class:'tk-old'}>=v) {}",
  "const f = <T,>(x:A<{class:'tk-old'}>=v) => x;",
];
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
    rules: [{ key: '.tk-old.tk-new.runtime', hash: 'x', sheet: 0 }],
  },
};
for (const source of types)
  for (const kind of ['ts', 'tsx', 'vue', 'svelte'])
    test(`compact type stays non-explicit: ${kind} ${source}`, () => {
      const tree = ts.createSourceFile(
        'app.ts',
        source,
        ts.ScriptTarget.Latest,
        true,
        kind === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      assert.equal(tree.parseDiagnostics.length, 0, source);
      const prefix = kind === 'vue' || kind === 'svelte' ? '<script lang="ts">\n' : '';
      const base =
        prefix + source + " document.querySelector('main')!.style.color='red';" + (prefix ? '\n</script>' : '');
      const head = base.replaceAll('tk-old', 'tk-new').replace("color='red'", "color='blue'");
      const key = `app.${kind}`,
        before = base.split('\n'),
        after = head.split('\n');
      const patch =
        `@@ -1,${before.length} +1,${after.length} @@\n` +
        before.map((l) => `-${l}\n`).join('') +
        after.map((l) => `+${l}\n`).join('');
      const changes = changedScriptRanges(patch, { base, head }, key);
      const result = classifyClassReach([map], [map], changes, [{ base: map, head: map }]);
      assert.ok(
        result.units.every((u) => !u.explicit),
        JSON.stringify(result),
      );
      const scripts = changes.map(({ sourceKey, side, range }) => ({
        sourceKey,
        side,
        range,
        execution: 'ran',
        status: 'unknown',
        why: 'rendering unproven',
        level: 'warn',
      }));
      assert.deepEqual(combineClassReach(scripts, result.units), scripts);
    });

for (const source of [
  "let x:A<B>={class:'runtime'};",
  "function f<T>(x:A<B>={class:'runtime'}) {}",
  "const f=<T,>(x:A<B>={class:'runtime'})=>x;",
  "function f<T extends A<B>=C>() { el.className='runtime'; }",
  "const n = x>=1; const s=x>>=1; el.className='runtime';",
  "const n = x<y; const s=x>=1; el.className='runtime';",
])
  test(`compact boundary preserves runtime values: ${source}`, () => {
    assert.ok(classLiterals(source, 'app.tsx').some((l) => l.explicit && l.words.some((w) => w.token === 'runtime')));
  });

for (const start of [
  "abstract class X { m() { el.className='runtime'; } }",
  "declare namespace X { const p: {class:'tk-old'}; }\nel.className='runtime';",
  "enum X { A=(el.className='runtime',1) }",
  "namespace X { el.className='runtime'; }",
])
  test(`ASI alias terminates before declaration starter: ${start}`, () => {
    const source = "type C = {class:'tk-old'}\n" + start;
    assert.ok(classLiterals(source, 'app.ts').some((l) => l.explicit && l.words.some((w) => w.token === 'runtime')));
    assert.ok(
      classLiterals(source, 'app.ts')
        .filter((l) => l.words.some((w) => w.token === 'tk-old'))
        .every((l) => !l.explicit),
    );
  });

test('four megabytes of template occurrences complete without an argument-stack overflow', { timeout: 30000 }, (t) => {
  const row = 'el.className=`btn ${on?"old":"new"}`;\n';
  const count = Math.ceil((4 * 1024 * 1024) / row.length),
    source = row.repeat(count);
  const start = performance.now(),
    literals = classLiterals(source, 'app.ts');
  assert.equal(literals.filter((l) => l.explicit && l.words.some((w) => w.token === 'old')).length, count);
  assert.equal(literals.filter((l) => l.explicit && l.words.some((w) => w.token === 'new')).length, count);
  t.diagnostic(
    JSON.stringify({ bytes: source.length, lines: count, literals: literals.length, ms: performance.now() - start }),
  );
});
