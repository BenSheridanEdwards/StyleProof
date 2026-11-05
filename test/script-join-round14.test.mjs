import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transform } from 'esbuild';
import { sourceContainsGenerator } from '../dist/script-join-generators.js';
import { scriptTokens } from '../dist/script-join-tokens.js';
import { changedScriptRanges } from '../dist/script-join-git.js';
import { classifyScriptReach } from '../dist/script-join.js';
import { mapScriptCoverage } from '../dist/script-reach.js';
import { compactScriptEvidence } from '../dist/script-reach-storage.js';
import { patches } from './script-join-round6-fixture.mjs';
import { rawGeneratorCases, apostropheControls } from './script-join-round14-fixture.mjs';

for (const scenario of rawGeneratorCases) {
  for (const options of [{}, { minifySyntax: true }, { minifyWhitespace: true }, { minify: true }]) {
    test(`${scenario.name} sets both raw file flags under ${JSON.stringify(options)}`, async () => {
      const maps = [];
      for (const text of [scenario.before, scenario.after]) {
        const bundle = await transform(text, {
          loader: scenario.sourceKey.endsWith('tsx') ? 'tsx' : 'ts',
          jsxFactory: 'h',
          sourcemap: 'external',
          sourcefile: scenario.sourceKey,
          ...options,
        });
        const files = mapScriptCoverage(
          { functions: [{ ranges: [{ startOffset: 0, endOffset: bundle.code.length, count: 1 }] }] },
          bundle.code,
          JSON.parse(bundle.map),
          'https://raw.test/app.js.map',
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
      const changes = changedScriptRanges(
        patches(scenario.before, scenario.after),
        { base: scenario.before, head: scenario.after },
        scenario.sourceKey,
      );
      assert.ok(changes.every((change) => change.generatorFile === true));
      const result = classifyScriptReach([maps[0]], [maps[1]], changes);
      assert.equal(result.units.length, 2);
      assert.ok(result.units.every((unit) => unit.execution === 'unmeasured'));
    });
  }
}

for (const text of [
  'a *b(c)',
  'obj.function *b(2)',
  '/function*foo/',
  '"function * fake"',
  '/* *m<T>() {} */',
  'function/*c*/* gen(){}',
  'function// c\n*gen(){}',
  "class D { @dec() *'quoted'<T>() {} }",
]) {
  test(`raw generator-like text flags without parsing: ${text}`, () =>
    assert.equal(sourceContainsGenerator(text), true));
}

for (const extension of ['vue', 'svelte', 'html']) {
  test(`apostrophe template text in .${extension} cannot hide a later raw header`, () => {
    const before =
      "<template><p>Don't stop</p></template>\n<script>function* saga(){yield 1;}\nwindow.done='done';</script>";
    const changes = changedScriptRanges(
      patches(before, before.replace('yield 1', 'yield 2')),
      { base: before, head: before.replace('yield 1', 'yield 2') },
      `App.${extension}`,
    );
    assert.ok(changes.every((change) => change.generatorFile));
  });
}

for (const quote of ["'", '"'])
  for (const ending of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    test(`an unterminated ${quote} is one character before ${JSON.stringify(ending)}`, () => {
      const text = `value=${quote}unfinished${ending}next=${quote}done${quote};`;
      const tokens = scriptTokens(text, 'app.ts');
      assert.deepEqual(
        tokens.find((token) => token.index === 6),
        { index: 6, end: 7 },
      );
      assert.ok(tokens.every((token) => !text.slice(token.index, token.end).includes(ending)));
    });
  }

for (const scenario of apostropheControls) {
  test(`${scenario.name} cannot create a quoted token crossing its line`, () => {
    const tokens = scriptTokens(scenario.before, 'app.tsx');
    assert.ok(
      tokens.every(
        (token) =>
          !/["']/.test(scenario.before[token.index]) ||
          !/[\r\n\u2028\u2029]/.test(scenario.before.slice(token.index, token.end)),
      ),
    );
    assert.equal(sourceContainsGenerator(scenario.before), false);
  });
}

for (const text of ['const a=1;window.value=a+2;', 'window.text="ordinary";', 'window.regex=/ordinary/;']) {
  test(`ordinary source has no raw generator-like pattern: ${text}`, () =>
    assert.equal(sourceContainsGenerator(text), false));
}
