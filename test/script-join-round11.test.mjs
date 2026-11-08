import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transform } from 'esbuild';
import { classifyScriptReach } from '../dist/script-join.js';
import { changedScriptRanges } from '../dist/script-join-git.js';
import { scriptTokens } from '../dist/script-join-tokens.js';
import { mapScriptCoverage } from '../dist/script-reach.js';
import { compactScriptEvidence } from '../dist/script-reach-storage.js';
import { tokenDefines } from './script-join-round8-fixture.mjs';
import { patches } from './script-join-round6-fixture.mjs';
import { assertionCases, genericControl, parameterCases } from './script-join-round11-fixture.mjs';

async function classify(before, after, sourceKey, options, idle = false) {
  const maps = [];
  for (const text of [before, after]) {
    const input = text.replace(/<\/?script\b[^>]*>/g, (tag) => ' '.repeat(tag.length));
    const bundle = await transform(input, {
      loader: 'ts',
      sourcemap: 'external',
      sourcefile: sourceKey,
      define: tokenDefines,
      ...options,
    });
    const literal = /"(?:red|orange)"/.exec(bundle.code);
    const ranges = [{ startOffset: 0, endOffset: bundle.code.length, count: 1 }];
    if (idle && literal)
      ranges.push({ startOffset: literal.index, endOffset: literal.index + literal[0].length, count: 0 });
    const sourceMap = JSON.parse(bundle.map);
    sourceMap.sourcesContent = [text];
    const files = mapScriptCoverage(
      { functions: [{ ranges }] },
      bundle.code,
      sourceMap,
      'https://assertion.test/app.js.map',
    );
    maps.push({
      scriptReach: {
        version: 1,
        window: 'navigation',
        status: 'measured',
        scripts: [compactScriptEvidence({ url: '/app.js', status: 'mapped', files })],
      },
    });
  }
  return classifyScriptReach(
    [maps[0]],
    [maps[1]],
    changedScriptRanges(patches(before, after), { base: before, head: after }, sourceKey),
  );
}

for (const options of [{}, { minifySyntax: true }, { minifyWhitespace: true }, { minify: true }]) {
  for (const scenario of assertionCases) {
    test(`${scenario.name} with ${JSON.stringify(options)}`, async () => {
      const result = await classify(scenario.before, scenario.after, 'app.ts', options, true);
      assert.deepEqual(result.gaps, []);
      assert.equal(result.units.length, 2);
      const retainedArm = scenario === assertionCases[1] && !options.minify && !options.minifySyntax;
      assert.ok(result.units.every((unit) => unit.status === (retainedArm ? 'never-rendered' : 'unmeasured')));
    });
  }
  test(`${genericControl.name} with ${JSON.stringify(options)}`, async () => {
    const result = await classify(genericControl.before, genericControl.after, 'app.ts', options);
    assert.equal(result.units.length, 2);
    assert.ok(result.units.every((unit) => unit.execution === 'ran' && unit.status === 'unknown'));
  });
}

for (const extension of ['ts', 'mts', 'cts']) {
  test(`angle assertions in .${extension} never create JSX text tokens`, () => {
    const text = 'window.res = <const>[__DEV__ && "red", 1];';
    assert.ok(scriptTokens(text, `app.${extension}`).some((token) => text.slice(token.index, token.end) === '"red"'));
  });
}

for (const sourceKey of ['App.vue', 'App.svelte', 'app.html']) {
  test(`a TypeScript script block in ${sourceKey} never creates JSX text tokens`, async () => {
    const before = '<script lang="ts">\nwindow.res = <any>[__DEV__ && "red", 1];\n</script>';
    const result = await classify(before, before.replace('"red"', '"orange"'), sourceKey, {});
    assert.equal(result.units.length, 2);
    assert.ok(result.units.every((unit) => unit.execution === 'unmeasured'));
    assert.ok(
      result.units.every((unit) => !('language' in unit)),
      'syntax hints are never persisted',
    );
  });
}

for (const text of ['const f = <T extends unknown>(a: T) => "red";', 'const f = <T,>(a: T) => "red";']) {
  test(`a type-parameter-shaped tag never invents positive JSX text: ${text}`, () => {
    assert.ok(
      !scriptTokens(text, 'app.tsx').some(
        (token) => !token.negativeOnly && token.index < text.indexOf('"red"') && token.end > text.indexOf('"red"'),
      ),
    );
  });
}

for (const scenario of parameterCases) {
  test(`${scenario.name} names its residual`, async () => {
    const result = await classify(scenario.before, scenario.before.replace('"red"', '"blue"'), 'app.ts', {});
    assert.equal(result.units.length, 2);
    assert.ok(result.units.every((unit) => unit.execution === 'ran' && unit.why.includes(scenario.residual)));
    assert.ok(
      result.units.every((unit) => !('parameterContext' in unit)),
      'source context is never persisted',
    );
  });
}

test('negative-only tails name an idle anchor without claiming the whole expression never ran', () => {
  const text = 'if (live) /\\//.test(s) && __DEV__ && dbg("red");';
  const column = text.indexOf('/');
  const file = {
    sourceKey: 'app.ts',
    contentHash: 'hash',
    executed: [],
    mixed: [],
    unexecuted: [[1, column, column + 1]],
    encoding: 'line-column-tuples',
  };
  const map = {
    scriptReach: { version: 1, status: 'measured', scripts: [{ url: '/app.js', status: 'mapped', files: [file] }] },
  };
  const result = classifyScriptReach(
    [map],
    [map],
    [
      {
        sourceKey: 'app.ts',
        side: 'head',
        contentHash: 'hash',
        text,
        range: { start: { line: 1, column: 0 }, end: { line: 1, column: text.length } },
      },
    ],
  );
  assert.equal(result.units[0].execution, 'never-ran');
  assert.match(result.units[0].why, /an anchor in the changed range never ran/);
  assert.ok(!result.units[0].why.includes('changed expression never ran'));
});
