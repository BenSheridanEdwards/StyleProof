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
import { lexicalCases } from './script-join-round10-fixture.mjs';

for (const scenario of lexicalCases) {
  for (const minify of [false, true]) {
    test(`${scenario.name} stays unmeasured with minify=${minify}`, async () => {
      const maps = [];
      for (const text of [scenario.before, scenario.after]) {
        const bundle = await transform(text, {
          loader: 'tsx',
          jsxFactory: 'h',
          minify,
          define: tokenDefines,
          sourcemap: 'external',
          sourcefile: 'app.tsx',
        });
        assert.ok(!bundle.code.includes('"red"') && !bundle.code.includes('"orange"'));
        const files = mapScriptCoverage(
          { functions: [{ ranges: [{ startOffset: 0, endOffset: bundle.code.length, count: 1 }] }] },
          bundle.code,
          JSON.parse(bundle.map),
          'https://lexical.test/app.js.map',
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
      const result = classifyScriptReach(
        [maps[0]],
        [maps[1]],
        changedScriptRanges(
          patches(scenario.before, scenario.after),
          { base: scenario.before, head: scenario.after },
          'app.tsx',
        ),
      );
      assert.deepEqual(result.gaps, []);
      assert.equal(result.units.length, 2);
      assert.ok(result.units.every((unit) => unit.execution === 'unmeasured' && unit.status === 'unmeasured'));
    });
  }
}

for (const label of ['// TODO', '/* note', '`npm i']) {
  test(`JSX text ${label} ends before the following expression`, () => {
    const text = `<p>${label}</p>{__DEV__ && <Debug tone="red" />}`;
    assert.ok(
      scriptTokens(text).some(
        (token) => token.index === text.indexOf('"red"') && token.end === text.indexOf('"red"') + 5,
      ),
    );
  });
}

for (const expression of [
  '(i)=>i.label || __DEV__ && "red"',
  '(i)=>({label:"}>"}).label || "red"',
  '(i)=>`x${i.label}` || "red"',
]) {
  test(`JSX attributes keep expression tokens inside braces: ${expression}`, () => {
    const text = `<List render={${expression}}>x</List>`;
    assert.ok(scriptTokens(text).some((token) => token.index === text.indexOf('"red"')));
  });
}

test('ambiguous escaped-slash comments retain negative-only tail evidence', () => {
  const text = 'if (live) /\\//.test(s) && __DEV__ && dbg("red");';
  assert.ok(scriptTokens(text).some((token) => token.negativeOnly && token.end === text.length));
  assert.deepEqual(
    scriptTokens('a / b / c').map((token) => 'a / b / c'.slice(token.index, token.end)),
    ['a', 'b', 'c'],
  );
});
