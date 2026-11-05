import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transform } from 'esbuild';
import { classifyScriptReach } from '../dist/script-join.js';
import { changedScriptRanges } from '../dist/script-join-git.js';
import { mapScriptCoverage } from '../dist/script-reach.js';
import { compactScriptEvidence, storedScriptEvidence } from '../dist/script-reach-storage.js';
import { parameterResiduals } from '../dist/script-join-parameters.js';
import { scriptTokens } from '../dist/script-join-tokens.js';
import { patches } from './script-join-round6-fixture.mjs';
import { generatorCases, generatorResidual, methodDefaults, tsxGenerics } from './script-join-round12-fixture.mjs';

async function classified(scenario, options, sourceKey = 'app.ts') {
  const maps = [];
  for (const text of [scenario.before, scenario.after]) {
    const input = text.replace(/<\/?script\b[^>]*>/g, (tag) => ' '.repeat(tag.length));
    const bundle = await transform(input, {
      loader: sourceKey.endsWith('tsx') ? 'tsx' : 'ts',
      sourcemap: 'external',
      sourcefile: sourceKey,
      ...options,
    });
    const ranges = [{ startOffset: 0, endOffset: bundle.code.length, count: 1 }];
    // V8's selected ternary has an idle alternate; generator creation has no idle inner range.
    const idle = /"(?:k|idle)"/.exec(bundle.code);
    if (idle) ranges.push({ startOffset: idle.index, endOffset: idle.index + idle[0].length, count: 0 });
    const sourceMap = JSON.parse(bundle.map);
    sourceMap.sourcesContent = [text];
    const files = mapScriptCoverage(
      { functions: [{ ranges }] },
      bundle.code,
      sourceMap,
      'https://generator.test/app.js.map',
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
    sourceKey,
  );
  return { maps, changes, result: classifyScriptReach([maps[0]], [maps[1]], changes) };
}

for (const options of [{}, { minifySyntax: true }, { minifyWhitespace: true }, { minify: true }]) {
  for (const scenario of generatorCases) {
    test(`${scenario.name} stays unmeasured under ${JSON.stringify(options)}`, async () => {
      const { maps, changes, result } = await classified(scenario, options);
      assert.equal(result.units.length, 2);
      assert.ok(
        result.units.every(
          (unit) =>
            unit.execution === 'unmeasured' && unit.status === 'unmeasured' && unit.why.includes(generatorResidual),
        ),
      );
      const proofs = changes.map((change) => ({ ...change, join: 'J1', status: 'reached' }));
      assert.ok(
        classifyScriptReach([maps[0]], [maps[1]], changes, proofs).units.every((unit) => unit.status === 'unmeasured'),
      );
    });
  }
}

for (const scenario of methodDefaults) {
  test(`${scenario.name} names its changed initializer`, async () => {
    const { changes, result } = await classified(scenario, {});
    assert.ok(result.units.every((unit) => unit.execution === 'ran' && unit.why.includes(scenario.residual)));
    if (scenario.name.includes('whole-line')) {
      const whole = {
        ...changes[0],
        range: { start: { line: 1, column: 0 }, end: { line: 1, column: scenario.before.length } },
        changeScope: 'line',
      };
      assert.ok(parameterResiduals(whole).includes(scenario.residual));
    }
  });
}

for (const scenario of tsxGenerics) {
  for (const minify of [false, true]) {
    test(`${scenario.name} keeps its own execution under minify=${minify}`, async () => {
      const { result } = await classified(scenario, { minify }, 'app.tsx');
      assert.equal(result.units.length, 2);
      assert.ok(result.units.every((unit) => unit.status === (scenario.idle ? 'never-rendered' : 'unknown')));
      if (!scenario.idle) assert.ok(result.units.every((unit) => unit.execution === 'ran'));
    });
  }
}

for (const parameters of ['T extends unknown', 'T,', 'T, U']) {
  test(`only the TSX type-parameter header <${parameters}> is negative-only`, () => {
    const text = `const f = <${parameters}>(a: T) => "red";`;
    assert.ok(
      scriptTokens(text, 'app.tsx').some(
        (token) => token.negativeOnly && token.index === text.indexOf('<') && token.end === text.indexOf('>') + 1,
      ),
    );
  });
}

for (const [sourceKey, attributes] of [
  ['App.vue', 'lang="typescript"'],
  ['app.html', 'type="text/typescript"'],
  ['App.astro', ''],
]) {
  test(`${sourceKey} ${attributes} uses TypeScript script boundaries`, async () => {
    const before = `<script ${attributes}>\nwindow.res = <any>[__DEV__ && "red", 1];\n</script>`;
    const { result } = await classified(
      { before, after: before.replace('red', 'orange') },
      { define: { __DEV__: 'false' } },
      sourceKey,
    );
    assert.equal(result.units.length, 2);
    assert.ok(result.units.every((unit) => unit.status === 'unmeasured'));
  });
}

test('capture notes name generator creation without iteration', () => {
  assert.ok(storedScriptEvidence([]).notes.some((note) => note.includes(generatorResidual)));
});
