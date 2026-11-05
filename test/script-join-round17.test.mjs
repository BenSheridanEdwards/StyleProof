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
import { cappedRegexCases, paddedEscapeCases } from './script-join-round17-fixture.mjs';
import { sourceContainsGenerator } from '../dist/script-join-generators.js';

for (const scenario of [...cappedRegexCases, ...paddedEscapeCases]) {
  for (const minify of [false, true]) {
    test(`${scenario.name} stays unmeasured with minify=${minify}`, async () => {
      const generator = paddedEscapeCases.includes(scenario);
      const maps = [];
      for (const text of [scenario.before, scenario.after]) {
        const bundle = await transform(text, {
          loader: scenario.sourceKey.endsWith('.tsx') ? 'tsx' : 'ts',
          target: 'es2022',
          jsxFactory: 'h',
          minify,
          define: tokenDefines,
          sourcemap: 'external',
          sourcefile: scenario.sourceKey,
        });
        if (generator) assert.equal(sourceContainsGenerator(text), true);
        else assert.ok(!/sink\([12]\)/.test(bundle.code));
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
          scenario.sourceKey,
        ),
      );
      assert.deepEqual(result.gaps, []);
      assert.equal(result.units.length, 2);
      assert.ok(result.units.every((unit) => unit.execution === 'unmeasured' && unit.status === 'unmeasured'));
    });
  }
}

for (const ending of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
  test(`a capped slash stops its negative tail at ${JSON.stringify(ending)}`, () => {
    const prefix = 'f(/' + String.raw`\.`.repeat(2100) + '[//]/) && 0 && sink(1);';
    const text = prefix + ending + 'next();';
    const tokens = scriptTokens(text, 'app.ts');
    const tail = tokens.find((token) => token.negativeOnly && token.index === 2);
    assert.equal(tail?.end, prefix.length);
    assert.ok(tokens.some((token) => token.index === text.indexOf('next')));
  });
}

test('a long division line supplies negative-only evidence after the slash', () => {
  const text = 'value / ' + 'other + '.repeat(600) + 'last';
  assert.ok(
    scriptTokens(text, 'app.ts').some((token) => token.index === 6 && token.negativeOnly && token.end === text.length),
  );
});
