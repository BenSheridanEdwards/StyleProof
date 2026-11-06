import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { runtimeForms } from './class-join-round8-cases.mjs';
import { classLiterals } from '../dist/class-join-literals.js';
import { classifyClassReach, combineClassReach } from '../dist/class-join.js';
import { changedScriptRanges } from '../dist/script-join-git.js';

const qaForms = [
  "type C<T> = T extends {class:'old'} ? {className:'old'} : never;",
  "let p: string extends unknown ? {class:'old'} : {className:'old'};",
  "const p=value as ({class:'old'} & {inner:{className:'old'}});",
  "const p:readonly [{class:'old'},{className:'old'}?]=value;",
  "function f<T={inner:{class:'old'}}>(p:T) {}",
  "function f<X,Y,T extends (X extends Y ? {class:'old'} : {className:'old'})>() {}",
];
const typeForms = [
  "type X = () => A extends B ? { class: 'old' } : C;",
  "let f: () => A extends B ? { class: 'old' } : C;",

  "let f: () => { class: 'old' };",
  "function f(e: () => { class: 'old' }) {}",
  "type X = () => { class: 'old' };",
  "const f = value as () => { class: 'old' };",
  "function f(): () => { class: 'old' } { return value; }",
  "function f(x: unknown): x is { class: 'old' } { return true; }",

  "let m: Record<string, { className: 'old' }>;",
  "function f(e: Record<K, { class: 'old' }>) {}",
  "new Map<string, { class: 'old' }>();",
  "foo<A, { class: 'old' }>(x);",
  "function f(e: [{ class: 'old' }]) {}",
  "let t: [A, { class: 'old' }];",
  "let t: [a: string, b?: { class: 'old' }];",
  "const t = x as ({ class: 'old' });",
  "const t = x as [{ class: 'old' }];",
  "const t = x as Map<K, { class: 'old' }>;",
  "const t = x satisfies Record<K, { class: 'old' }>;",
  "let x: A extends B ? { class: 'old' } : C;",
  "let x: A extends B ? C : { class: 'old' };",
  "function f<G = { class: 'old' }>() {}",
  "const [a]: [{ class: 'old' }] = v;",
  "type X = [{ class: 'old' }];",
  "type X = ({ class: 'old' });",
  "interface X { prop: Record<K, { class: 'old' }> }",
  "class X implements Record<K, { class: 'old' }> {}",
  "const f = <T extends { class: 'old' }>(x: T) => x;",
  "function f(): Record<K, { class: 'old' }> { return value; }",
  "let a: ({ class: 'old' } | [{ className: 'old' }]) & A;",
];
for (const source of [...typeForms, ...qaForms])
  test(`nested type has no positive role: ${source}`, () => {
    const found = classLiterals(source, 'app.ts').filter((l) => l.words.some((w) => w.token === 'old'));
    assert.ok(found.length);
    assert.ok(
      found.every((l) => !l.explicit),
      JSON.stringify(found),
    );
  });

for (const source of [
  ...runtimeForms.map((source) => source.replaceAll('tk-old js-hook', 'old')),
  "switch(k) { default: { el.className='old'; } }",
  "switch(k) { case A: { el.className='old'; } }",
  "switch(k) { case K.A: { el.className='old'; } }",
  "outer: { el.className='old'; }",
  "$: { el.className='old'; }",
  "let x: Record<K, { class: 'type' }> = { class: 'old' };",
  "function f(e: Record<K, { class: 'type' }>) { el.className='old'; }",
  "function f(): Record<K, { class: 'type' }> { el.className='old'; return value; }",
  "const f = (e: Record<K, { class: 'type' }>) => ({ class: 'old' });",
  "const cfg = { as: { class: 'old' } };",
  "const cfg = { implements: { class: 'old' } };",
  "type X = { class: 'type' }\nel.className='old';",
  "let p: Record<K, { class: 'type' }>\nel.className='old';",
  "const p = value as { class: 'type' }\nel.className='old';",
  "const f = (r): { class: 'type' } => { el.className='old'; return value; };",
  "const cfg = on ? value : { class: 'old' };",
])
  test(`runtime boundary keeps positive values: ${source}`, () => {
    assert.ok(classLiterals(source, 'app.ts').some((l) => l.explicit && l.words.some((w) => w.token === 'old')));
  });

test('a bracket cap drops the entire unfinished statement but keeps earlier statements', () => {
  const source = "el.className='kept';\nel.className = 'old'[" + '('.repeat(200) + 'x' + ')'.repeat(200) + '];';
  const literals = classLiterals(source, 'app.ts');
  assert.ok(literals.some((l) => l.explicit && l.words.some((w) => w.token === 'kept')));
  assert.ok(!literals.some((l) => l.explicit && l.words.some((w) => w.token === 'old')));
  const gap = literals.find((l) => l.extractionGap && /depth.*limit/.test(l.residual));
  assert.ok(gap);
  assert.deepEqual(gap.range.start, { line: 2, column: 0 });
});

function assertTypeJoin(base, head = base.replaceAll('old', 'new')) {
  const result = join(base, head);
  assert.ok(
    result.units.every((u) => !u.explicit),
    JSON.stringify(result),
  );
}

function join(base, head) {
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
    reach: { version: 2, scope: 'compared', sheets: ['app.css'], rules: [{ key: '.old.new', hash: 'x', sheet: 0 }] },
  };
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
    why: 'value; rendering not proved',
    level: 'warn',
  }));
  assert.ok(combineClassReach(scripts, result.units).every((u) => u.status === 'unknown'));
  return result;
}

test('nested inline type evidence cannot lower a same-line visual-change J2 range', () => {
  const base = "type Ev = { class: 'old' }; function f(e: Record<string, Ev>) { main.style.color='red'; }";
  const head = "function f(e: Record<string, { class: 'old' }>) { main.style.color='blue'; }";
  assertTypeJoin(base, head);
});

test('dev-only two-way TS oracle: nested types stay negative and supported runtime roles stay positive', (t) => {
  const wrappers = [
    (v) => `let p: ${v} = value;`,
    (v) => `function f(e: ${v}) {}`,
    (v) => `const f = (e?: ${v}) => e;`,
    (v) => `function f(): ${v} { return value; }`,
    (v) => `const p = value as ${v};`,
    (v) => `const p = value satisfies ${v};`,
    (v) => `type X = ${v};`,
    (v) => `interface X { prop: ${v} }`,
    (v) => `function f<T extends ${v}>() {}`,
    (v) => `function f<T = ${v}>() {}`,
    (v) => `new Map<string, ${v}>();`,
    (v) => `foo<A, ${v}>(x);`,
    (v) => `const [a]: [${v}] = value;`,
    (v) => `class X implements Record<K, ${v}> {}`,
    (v) => `const f = <T extends ${v}>(e: T) => e;`,
    (v) => `let p!: ${v};`,
  ];
  const nests = [
    (v) => v,
    (v) => `(${v})`,
    (v) => `[${v}]`,
    (v) => `Record<K, ${v}>`,
    (v) => `A | ${v}`,
    (v) => `A & ${v}`,
    (v) => `A extends B ? ${v} : C`,
    (v) => `A extends B ? C : ${v}`,
    (v) => `[a: A, b?: ${v}]`,
    (v) => `{ nested: ${v} }`,
    (v) => `(() => ${v})`,
  ];
  const failures = [];
  let checked = 0;
  let falsePositives = 0;
  let runtimeChecked = 0;
  let falseNegatives = 0;
  const missed = [];
  for (let i = 0; i < 8000 + qaForms.length; i++) {
    const leaf = i % 2 ? "{ class: 'old' }" : "{ className: 'old' }";
    const value = nests[Math.floor(i / 16) % nests.length](nests[Math.floor(i / 160) % nests.length](leaf));
    const typeSource = i < 8000 ? wrappers[i % wrappers.length](value) : qaForms[i - 8000];
    const kind = ['ts', 'tsx', 'vue', 'svelte'][i % 4];
    const jsx = [
      `const view = <div className="rt${i} js-hook"/>;`,
      `const view = <div className={on ? 'rt${i}' : 'rt${i}-else'}/>;`,
      `const view = <div className={cn('rt${i}')}/>;`,
    ];
    const source =
      typeSource +
      '\n' +
      runtimeForms[i % runtimeForms.length].replaceAll('tk-old', `rt${i}`) +
      (kind === 'tsx' ? '\n' + jsx[i % jsx.length] : '');
    const tree = ts.createSourceFile(
      'app.ts',
      source,
      ts.ScriptTarget.Latest,
      true,
      kind === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    assert.equal(tree.parseDiagnostics.length, 0, source);
    const typePositions = new Set();
    const runtimePositions = new Set();
    const pending = [{ node: tree, type: false }];
    while (pending.length) {
      const { node, type } = pending.pop();
      const inType = type || ts.isTypeNode(node);
      if (ts.isStringLiteral(node) && node.text === 'old' && inType) typePositions.add(node.getStart(tree));
      if (ts.isStringLiteral(node) && node.text.startsWith(`rt${i}`) && !inType)
        runtimePositions.add(node.getStart(tree));
      ts.forEachChild(node, (child) => {
        pending.push({ node: child, type: inType });
      });
    }
    assert.ok(typePositions.size >= 1, source);
    checked += typePositions.size;
    const prefix = kind === 'vue' || kind === 'svelte' ? '<script lang="ts">\n' : '';
    const text = prefix ? prefix + source + '\n</script>' : source;
    const lines = [0];
    for (const match of text.matchAll(/\n/g)) lines.push(match.index + 1);
    const explicit = new Set(
      classLiterals(text, `app.${kind}`)
        .filter((l) => l.explicit)
        .map((l) => lines[l.range.start.line - 1] + l.range.start.column - prefix.length),
    );
    for (const position of typePositions)
      if (explicit.has(position)) {
        falsePositives++;
        if (failures.length < 10) failures.push(source);
      }
    assert.ok(runtimePositions.size, source);
    runtimeChecked += runtimePositions.size;
    for (const position of runtimePositions)
      if (!explicit.has(position)) {
        falseNegatives++;
        if (missed.length < 10) missed.push(source);
      }
  }
  t.diagnostic(
    JSON.stringify({
      checkedTypeLiterals: checked,
      falsePositives,
      runtimeChecked,
      falseNegatives,
      falsePositiveExamples: failures,
      falseNegativeExamples: missed,
    }),
  );
  assert.deepEqual(failures, []);
  assert.deepEqual(missed, []);
});
