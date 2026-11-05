import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transform } from 'esbuild';
import { classifyScriptReach } from '../dist/script-join.js';
import { changedScriptRanges } from '../dist/script-join-git.js';
import { mapScriptCoverage } from '../dist/script-reach.js';
import { compactScriptEvidence } from '../dist/script-reach-storage.js';
import { generatorResidual } from './script-join-round12-fixture.mjs';
import { generatorFileCases, generatorLexicalControls } from './script-join-round13-fixture.mjs';
import { patches } from './script-join-round6-fixture.mjs';

async function joined(before, after, options, sourceKey = 'app.ts') {
  const maps = [];
  for (const text of [before, after]) {
    const bundle = await transform(text, {
      loader: sourceKey.endsWith('tsx') ? 'tsx' : 'ts',
      jsxFactory: 'h',
      sourcemap: 'external',
      sourcefile: sourceKey,
      ...options,
    });
    const files = mapScriptCoverage(
      { functions: [{ ranges: [{ startOffset: 0, endOffset: bundle.code.length, count: 1 }] }] },
      bundle.code,
      JSON.parse(bundle.map),
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
  const changes = changedScriptRanges(patches(before, after), { base: before, head: after }, sourceKey);
  return { changes, result: classifyScriptReach([maps[0]], [maps[1]], changes) };
}

for (const options of [{}, { minifySyntax: true }, { minifyWhitespace: true }, { minify: true }]) {
  for (const scenario of generatorFileCases) {
    test(`${scenario.name} downgrades every file change under ${JSON.stringify(options)}`, async () => {
      const { result } = await joined(scenario.before, scenario.after, options, scenario.sourceKey);
      assert.equal(result.units.length, 2);
      assert.ok(result.units.every((unit) => unit.execution === 'unmeasured' && unit.why.includes(generatorResidual)));
      assert.ok(
        result.units.every((unit) => !('generatorFile' in unit)),
        'private file flag is never persisted',
      );
    });
  }
}

for (const body of generatorLexicalControls) {
  test(`raw generator-like text conservatively downgrades a live value: ${body}`, async () => {
    const before = 'function sink(x) { return x; }\n' + body;
    const after = before.includes('sink(1)') ? before.replace('sink(1)', 'sink(2)') : before.replace('*b(1)', '*b(2)');
    const { changes, result } = await joined(before, after, {});
    assert.ok(changes.every((change) => change.generatorFile === true));
    assert.equal(result.units.length, 2);
    assert.ok(result.units.every((unit) => unit.execution === 'unmeasured' && unit.why.includes(generatorResidual)));
  });
}

test('base and head keep their own whole-file generator flag', async () => {
  const body = 'window.value = sink(1);';
  const before = 'function sink(x) { return x; }\nfunction* unused() {}\n' + body;
  const after = before.replace('function* unused() {}', 'function unused() {}').replace('sink(1)', 'sink(2)');
  const { changes } = await joined(before, after, {});
  assert.ok(changes.filter((change) => change.side === 'base').every((change) => change.generatorFile === true));
  assert.ok(changes.filter((change) => change.side === 'head').every((change) => change.generatorFile === false));
});
