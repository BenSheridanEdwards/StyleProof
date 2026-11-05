import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transform } from 'esbuild';
import { classifyScriptReach } from '../dist/script-join.js';
import { changedScriptRanges } from '../dist/script-join-git.js';
import { mapScriptCoverage } from '../dist/script-reach.js';
import { compactScriptEvidence, storedScriptEvidence } from '../dist/script-reach-storage.js';
import { sha256 } from '../dist/node-util.js';
import { scriptTokens } from '../dist/script-join-tokens.js';
import { patches } from './script-join-round6-fixture.mjs';
import { residualCases, tokenCases, tokenDefines } from './script-join-round8-fixture.mjs';

for (const count of [0, 1]) {
  test(`an eager JSX element keeps its executable starts with V8 count ${count}`, async () => {
    const before = '  const banner = <span className="sp-banner">Down</span>;',
      after = before.replaceAll('span', 'strong');
    const maps = [];
    for (const text of [before, after]) {
      const bundle = await transform(text, {
        loader: 'jsx',
        jsxFactory: 'h',
        sourcemap: 'external',
        sourcefile: 'app.tsx',
      });
      const files = mapScriptCoverage(
        { functions: [{ ranges: [{ startOffset: 0, endOffset: bundle.code.length, count }] }] },
        bundle.code,
        JSON.parse(bundle.map),
        'https://tokens.test/app.js.map',
      );
      const starts = new Set(files[0][count ? 'executed' : 'unexecuted'].map((span) => span.start.column));
      assert.ok(
        scriptTokens(text).every((token) => starts.has(token.index)),
        'every executable token has a start',
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
    const changes = changedScriptRanges(patches(before, after), { base: before, head: after }, 'app.tsx');
    const units = classifyScriptReach([maps[0]], [maps[1]], changes).units;
    assert.equal(units.length, 2);
    assert.deepEqual(
      units.map((unit) => unit.execution),
      [count ? 'ran' : 'never-ran', count ? 'ran' : 'never-ran'],
    );
    assert.deepEqual(
      units.map((unit) => unit.status),
      [count ? 'unknown' : 'never-rendered', count ? 'unknown' : 'never-rendered'],
    );
  });
}

test('JSX closing-tag names are delimiter syntax while strings and following code keep tokens', () => {
  const text = 'const banner = <UI.Title>Down</UI.Title>; next("</strong>");';
  assert.deepEqual(
    scriptTokens(text).map((token) => text.slice(token.index, token.end)),
    ['const', 'banner', 'UI', 'Title', 'Down', 'next', '"</strong>"'],
  );
});

for (const scenario of residualCases) {
  for (const minify of [false, true]) {
    test(`${scenario.name} names its residual with minify=${minify}`, async () => {
      const after = scenario.before.replace('"red"', '"blue"');
      const maps = [];
      for (const text of [scenario.before, after]) {
        const bundle = await transform(text, { minify, sourcemap: 'external', sourcefile: 'app.tsx' });
        const files = mapScriptCoverage(
          { functions: [{ ranges: [{ startOffset: 0, endOffset: bundle.code.length, count: 1 }] }] },
          bundle.code,
          JSON.parse(bundle.map),
          'https://tokens.test/app.js.map',
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
        patches(scenario.before, after),
        { base: scenario.before, head: after },
        'app.tsx',
      );
      const units = classifyScriptReach([maps[0]], [maps[1]], changes).units;
      assert.equal(units.length, 2);
      assert.ok(units.every((unit) => unit.execution === 'ran' && unit.status === 'unknown'));
      assert.ok(units.every((unit) => unit.why.includes(scenario.residual)));
    });
  }
}

for (const scenario of tokenCases) {
  test(scenario.name + ' with real esbuild mappings', async () => {
    const maps = [];
    for (const text of [scenario.before, scenario.after]) {
      const bundle = await transform(text, {
        loader: 'tsx',
        minify: true,
        sourcemap: 'external',
        sourcefile: 'app.tsx',
        define: tokenDefines,
      });
      for (const removed of scenario.removed) assert.ok(!bundle.code.includes(removed));
      const files = mapScriptCoverage(
        { functions: [{ ranges: [{ startOffset: 0, endOffset: bundle.code.length, count: 1 }] }] },
        bundle.code,
        JSON.parse(bundle.map),
        'https://tokens.test/app.js.map',
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
      'app.tsx',
    );
    assert.ok(changes.every((change) => change.changeScope === 'line'));
    const result = classifyScriptReach([maps[0]], [maps[1]], changes);
    assert.equal(result.units.length, 2);
    assert.deepEqual(
      result.units.map((unit) => unit.status),
      ['unmeasured', 'unmeasured'],
    );
    assert.deepEqual(result.gaps, []);
  });
}

for (const [text, executed, unexecuted, expected] of [
  ['},', [[1, 0, 0]], [], 'unmeasured'],
  [
    'foo(); removed;',
    [
      [1, 0, 0],
      [1, 4, 4],
    ],
    [],
    'unmeasured',
  ],
  [
    'foo(); bar;',
    [
      [1, 0, 0],
      [1, 7, 7],
    ],
    [],
    'ran',
  ],
  ['}; idle;', [[1, 0, 0]], [[1, 3, 7]], 'never-ran'],
]) {
  test(`token evidence for ${text} reads ${expected}`, () => {
    const map = {
      scriptReach: {
        version: 1,
        window: 'navigation',
        status: 'measured',
        scripts: [
          {
            url: '/app.js',
            status: 'mapped',
            files: [
              {
                source: 'app.js',
                sourceKey: 'app.js',
                contentHash: sha256(text),
                encoding: 'line-column-tuples',
                executed,
                unexecuted,
                mixed: [],
              },
            ],
          },
        ],
      },
    };
    const changes = [
      {
        sourceKey: 'app.js',
        side: 'head',
        text,
        contentHash: sha256(text),
        changeScope: 'line',
        range: { start: { line: 1, column: 0 }, end: { line: 1, column: text.length } },
      },
    ];
    assert.equal(classifyScriptReach([map], [map], changes).units[0].execution, expected);
  });
}

test('the capture notes retain optional-chain continuation and merged-arm attribution limits', () => {
  const notes = storedScriptEvidence([]).notes.join('\n');
  assert.match(notes, /optional chain.*idle continuation.*early/s);
  assert.match(notes, /minifier.*merg.*original arm/s);
});

for (const separator of ['\r', '\u2028', '\u2029']) {
  test(`token columns stay on the changed JavaScript line after ${JSON.stringify(separator)}`, async () => {
    const prefix = separator === '\r' ? 'const prefix = 1;\r' : `const prefix = "x${separator}y"; `;
    const before = prefix + 'window.result = 1;',
      after = prefix + 'window.result = 2;';
    const maps = [];
    for (const text of [before, after]) {
      const bundle = await transform(text, { sourcemap: 'external', sourcefile: 'app.tsx' });
      const files = mapScriptCoverage(
        { functions: [{ ranges: [{ startOffset: 0, endOffset: bundle.code.length, count: 1 }] }] },
        bundle.code,
        JSON.parse(bundle.map),
        'https://tokens.test/app.js.map',
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
    const changes = changedScriptRanges(patches(before, after), { base: before, head: after }, 'app.tsx');
    assert.ok(changes.every((change) => change.range.start.line === 2));
    assert.deepEqual(
      classifyScriptReach([maps[0]], [maps[1]], changes).units.map((unit) => unit.execution),
      ['ran', 'ran'],
    );
  });
}
