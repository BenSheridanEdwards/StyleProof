import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classLiterals } from '../dist/class-join-literals.js';
import { classifyClassReach, combineClassReach } from '../dist/class-join.js';
import { changedScriptRanges } from '../dist/script-join-git.js';
import { runtimeForms, tsxForms } from './class-join-round8-cases.mjs';

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
    rules: [{ key: '.tk-old.tk-new.ty-old.ty-new', hash: 'x', sheet: 0 }],
  },
};
function changes(base, head, key) {
  const before = base.split('\n'),
    after = head.split('\n');
  const patch =
    `@@ -1,${before.length} +1,${after.length} @@\n` +
    before.map((l) => `-${l}\n`).join('') +
    after.map((l) => `+${l}\n`).join('');
  return changedScriptRanges(patch, { base, head }, key);
}
function join(base, head, key) {
  const edits = changes(base, head, key);
  return { ...classifyClassReach([map], [map], edits, [{ base: map, head: map }]), edits };
}
function wrap(source, kind) {
  return kind === 'vue' || kind === 'svelte' ? `<script lang="ts">\n${source}\n</script>` : source;
}
for (const [index, source] of runtimeForms.entries())
  for (const kind of ['ts', 'tsx', 'vue', 'svelte'])
    test(`runtime role and occurrence survive type boundaries: ${index} ${kind}`, () => {
      const key = `app.${kind}`,
        base = wrap(source, kind),
        head = base.replaceAll('tk-old', 'tk-new');
      for (const [text, token] of [
        [base, 'tk-old'],
        [head, 'tk-new'],
      ])
        assert.ok(
          classLiterals(text, key).some((l) => l.explicit && l.words.some((w) => w.token === token)),
          text,
        );
      const result = join(base, head, key);
      assert.deepEqual(
        result.units.map((u) => [u.side, u.token, u.explicit, u.status]),
        [
          ['base', 'tk-old', true, 'never-rendered'],
          ['head', 'tk-new', true, 'never-rendered'],
        ],
      );
    });

for (const source of tsxForms.slice(0, 2))
  test(`parenthesized JSX return type preserves runtime values: ${source}`, () => {
    const result = join(source, source.replaceAll('tk-old', 'tk-new'), 'app.tsx');
    assert.equal(result.units.length, 2);
    assert.ok(result.units.every((u) => u.explicit && u.status === 'never-rendered'));
  });

test('TSX extends never enters markup mode inside generic type parameters', () => {
  const source = tsxForms[2],
    result = join(source, source.replace('ty-old', 'ty-new'), 'app.tsx');
  assert.ok(
    classLiterals(source, 'app.tsx')
      .filter((l) => l.words.some((w) => w.token === 'ty-old'))
      .every((l) => !l.explicit),
  );
  const scripts = result.edits.map(({ sourceKey, side, range }) => ({
    sourceKey,
    side,
    range,
    execution: 'unmeasured',
    status: 'unmeasured',
    why: 'type erased',
    level: 'warn',
  }));
  assert.deepEqual(combineClassReach(scripts, result.units), scripts);
});

test('parenthesized arrow return keeps both dynamic-fragment gaps', () => {
  const source = 'const f = (): (() => void) => { el.className=`tk-old${x}`; return f; };';
  const result = join(source, source.replace('tk-old', 'tk-new'), 'app.ts');
  assert.equal(result.gaps.length, 2);
  assert.ok(result.gaps.every((g) => /fragment/.test(g.reason)));
});

for (const source of [
  "export default function f(): { class: 'ty-old' } { el.className='tk-old js-hook'; return value; }",
  "export default {data:1}; let p: { class: 'ty-old' };",
])
  test(`export default is not a switch label: ${source}`, () => {
    const literals = classLiterals(source, 'app.ts');
    assert.ok(literals.filter((l) => l.words.some((w) => w.token === 'ty-old')).every((l) => !l.explicit));
  });

test('reviewer AST sample bounds type positives and runtime misses in all four languages', (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const child = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./class-join-review-oracle.mjs', import.meta.url)),
      '1',
      '1000',
      'ts',
      'tsx',
      'vue',
      'svelte',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, R: root.replace(/\/$/, '') },
      timeout: 30000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const { summary } = JSON.parse(child.stdout);
  const limits = { ts: 0, tsx: 0.06, vue: 0.01, svelte: 0.01 };
  const expectedMisses = {
    ts: { hiddenWithGap: 0, hiddenNoGap: 0, nonExplicit: 0 },
    tsx: { hiddenWithGap: 61, hiddenNoGap: 77, nonExplicit: 95 },
    vue: { hiddenWithGap: 19, hiddenNoGap: 5, nonExplicit: 0 },
    svelte: { hiddenWithGap: 16, hiddenNoGap: 5, nonExplicit: 0 },
  };
  const failed = [];
  for (const [kind, result] of Object.entries(summary)) {
    assert.ok(result.typeLits > 0 && result.rtLits > 0);
    const hidden = { hiddenWithGap: result.hiddenWithGap, hiddenNoGap: result.hiddenNoGap };
    assert.deepEqual(
      hidden,
      { hiddenWithGap: expectedMisses[kind].hiddenWithGap, hiddenNoGap: expectedMisses[kind].hiddenNoGap },
      kind,
    );
    assert.equal(result.nonExplicit, expectedMisses[kind].nonExplicit, kind);
    assert.equal(result.fn, result.hiddenWithGap + result.hiddenNoGap + result.nonExplicit);
    if (result.errors || result.fp || result.fn / result.rtLits > limits[kind]) failed.push(kind);
    t.diagnostic(
      JSON.stringify({
        kind,
        typeLiterals: result.typeLits,
        falsePositives: result.fp,
        runtimeLiterals: result.rtLits,
        falseNegatives: result.fn,
        hiddenWithGap: result.hiddenWithGap,
        hiddenNoGap: result.hiddenNoGap,
        nonExplicit: result.nonExplicit,
        maximumMissRate: limits[kind],
      }),
    );
  }
  assert.deepEqual(failed, []);
});
