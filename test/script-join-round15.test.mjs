import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { transform } from 'esbuild';
import { sourceContainsGenerator } from '../dist/script-join-generators.js';
import { changedScriptRanges } from '../dist/script-join-git.js';
import { classifyScriptReach } from '../dist/script-join.js';
import { mapScriptCoverage } from '../dist/script-reach.js';
import { compactScriptEvidence } from '../dist/script-reach-storage.js';
import { patches } from './script-join-round6-fixture.mjs';
import { widenedGeneratorCases } from './script-join-round15-fixture.mjs';

for (const scenario of widenedGeneratorCases) {
  for (const options of [{}, { minifySyntax: true }, { minifyWhitespace: true }, { minify: true }]) {
    test(`${scenario.name} flags and downgrades under ${JSON.stringify(options)}`, async () => {
      if (scenario.noYield) assert.ok(!/\byield\b/.test(scenario.before));
      const maps = [];
      for (const text of [scenario.before, scenario.after]) {
        const bundle = await transform(text, {
          loader: 'ts',
          target: 'es2022',
          ...options,
          sourcemap: 'external',
          sourcefile: 'app.ts',
        });
        const files = mapScriptCoverage(
          { functions: [{ ranges: [{ startOffset: 0, endOffset: bundle.code.length, count: 1 }] }] },
          bundle.code,
          JSON.parse(bundle.map),
          'https://widened.test/app.js.map',
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
        'app.ts',
      );
      assert.ok(changes.every((change) => change.generatorFile === true));
      const result = classifyScriptReach([maps[0]], [maps[1]], changes);
      assert.equal(result.units.length, 2);
      assert.ok(result.units.every((unit) => unit.execution === 'unmeasured'));
    });
  }
}

for (const text of ['yield', '"yield"', '/* yield */', '`yield`', 'const yieldCount=1;']) {
  test(`raw yield word catch-all: ${text}`, () =>
    assert.equal(sourceContainsGenerator(text), text !== 'const yieldCount=1;'));
}

test('bounded computed and generic patterns stop after 512 content characters', () => {
  assert.equal(sourceContainsGenerator('*[' + 'x'.repeat(512) + ']()'), true);
  assert.equal(sourceContainsGenerator('*[' + 'x'.repeat(513) + ']()'), false);
  assert.equal(sourceContainsGenerator('*m<' + 'T'.repeat(512) + '>()'), true);
  assert.equal(sourceContainsGenerator('*m<' + 'T'.repeat(513) + '>()'), false);
});

test('bounded raw Unicode patterns count characters rather than surrogate halves', () => {
  assert.equal(sourceContainsGenerator("*['" + '😀'.repeat(510) + "']()"), true);
  assert.equal(sourceContainsGenerator("*['" + '😀'.repeat(511) + "']()"), false);
});

test('large raw scans stay within a bounded CPU and wall-time budget', (t) => {
  const text = 'const value=1;\n'.repeat(140000) + ' * /*'.repeat(6000) + ' */ ordinary end';
  const cpu = process.cpuUsage(),
    start = performance.now();
  assert.equal(sourceContainsGenerator(text), false);
  assert.equal(sourceContainsGenerator(text + ' *[k[0]]<T extends () => void>/*c*/()'), true);
  const wall = performance.now() - start,
    usage = process.cpuUsage(cpu),
    cpuMs = (usage.user + usage.system) / 1000;
  t.diagnostic(`${Buffer.byteLength(text)} bytes; two scans: ${wall.toFixed(1)} ms wall, ${cpuMs.toFixed(1)} ms CPU`);
  assert.ok(cpuMs < 2000, `${cpuMs} ms CPU exceeds 2000 ms`);
  assert.ok(wall < 5000, `${wall} ms wall exceeds 5000 ms`);
});
