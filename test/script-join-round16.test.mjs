import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { transform } from 'esbuild';
import { sourceContainsGenerator } from '../dist/script-join-generators.js';
import { scriptTokens } from '../dist/script-join-tokens.js';
import { changedScriptRanges } from '../dist/script-join-git.js';
import { classifyScriptReach } from '../dist/script-join.js';
import { mapScriptCoverage } from '../dist/script-reach.js';
import { compactScriptEvidence, storedScriptEvidence } from '../dist/script-reach-storage.js';
import { patches } from './script-join-round6-fixture.mjs';
import { escapedGeneratorCases, overBoundCases, boundResidual } from './script-join-round16-fixture.mjs';

for (const scenario of [...escapedGeneratorCases, ...overBoundCases])
  for (const options of [{}, { minifySyntax: true }, { minifyWhitespace: true }, { minify: true }]) {
    const residual = overBoundCases.includes(scenario);
    test(`${scenario.name} ${residual ? 'retains the documented residual' : 'is flagged'} under ${JSON.stringify(options)}`, async () => {
      assert.ok(!/\byield\b/.test(scenario.before));
      const maps = [];
      for (const text of [scenario.before, scenario.after]) {
        assert.equal(sourceContainsGenerator(text), !residual);
        const bundle = await transform(text, {
          loader: 'ts',
          target: 'es2022',
          sourcemap: 'external',
          sourcefile: 'app.ts',
          ...options,
        });
        const files = mapScriptCoverage(
          { functions: [{ ranges: [{ startOffset: 0, endOffset: bundle.code.length, count: 1 }] }] },
          bundle.code,
          JSON.parse(bundle.map),
          'https://escape.test/app.js.map',
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
      assert.ok(changes.every((change) => change.generatorFile === !residual));
      const result = classifyScriptReach([maps[0]], [maps[1]], changes);
      assert.equal(result.units.length, 2);
      assert.ok(
        result.units.every(
          (unit) =>
            unit.execution === (residual ? 'ran' : 'unmeasured') &&
            unit.status === (residual ? 'unknown' : 'unmeasured'),
        ),
      );
      if (residual) assert.ok(storedScriptEvidence([]).notes.some((note) => note.includes(boundResidual)));
    });
  }

test('capture notes name the no-yield computed/generic scan-bound residual', () => {
  assert.ok(storedScriptEvidence([]).notes.some((note) => note.includes(boundResidual)));
});

test('crafted unclosed regex classes tokenize within a bounded CPU budget', (t) => {
  const cpu = process.cpuUsage(),
    start = performance.now();
  for (const repeats of [20000, 40000]) {
    const source = 'x=' + '/['.repeat(repeats);
    assert.ok(scriptTokens(source, 'app.ts').length > 0);
  }
  const wall = performance.now() - start,
    usage = process.cpuUsage(cpu),
    cpuMs = (usage.user + usage.system) / 1000;
  t.diagnostic(`20k + 40k unclosed classes: ${wall.toFixed(1)} ms wall, ${cpuMs.toFixed(1)} ms CPU`);
  assert.ok(cpuMs < 500, `${cpuMs} ms CPU exceeds 500 ms`);
  assert.ok(wall < 2000, `${wall} ms wall exceeds 2000 ms`);
});
