import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transform } from 'esbuild';
import { classifyScriptReach } from '../dist/script-join.js';
import { changedScriptRanges } from '../dist/script-join-git.js';
import { mapScriptCoverage } from '../dist/script-reach.js';
import { compactScriptEvidence } from '../dist/script-reach-storage.js';
import { sha256 } from '../dist/node-util.js';
import { patches } from './script-join-round6-fixture.mjs';
import { executionIn, indexScriptSources } from '../dist/script-join-index.js';

for (const [name, entry, gaps] of [
  ['resolved non-app sources', { status: 'unmeasured', reason: 'no mapped app sources', nonAppSourcesOnly: true }, 0],
  ['ambiguous legacy empty mapping', { status: 'unmeasured', reason: 'no mapped app sources' }, 2],
  ['missing source map', { status: 'unmeasured', reason: 'source map absent', nonAppSourcesOnly: true }, 2],
  [
    'unreadable source map',
    { status: 'unknown', reason: 'source map could not be read or resolved', nonAppSourcesOnly: true },
    2,
  ],
]) {
  test(`a vendor chunk with ${name} ${gaps ? 'retains' : 'avoids'} a run-level gap beside an app chunk`, () => {
    const text = 'const value = 1;';
    const app = {
      url: '/assets/app.js',
      status: 'mapped',
      files: [
        {
          source: 'app.js',
          sourceKey: 'app.js',
          contentHash: sha256(text),
          encoding: 'line-column-tuples',
          executed: [[1, 0, 0]],
          unexecuted: [],
          mixed: [],
        },
      ],
    };
    const map = {
      scriptReach: {
        version: 1,
        window: 'navigation',
        status: 'measured',
        scripts: [app, { url: '/assets/chunk.js', ...entry }],
      },
    };
    const changes = [
      {
        sourceKey: 'app.js',
        side: 'head',
        contentHash: sha256(text),
        text,
        range: { start: { line: 1, column: 0 }, end: { line: 1, column: text.length } },
      },
    ];
    const result = classifyScriptReach([map], [map], changes);
    assert.equal(result.gaps.length, gaps);
    assert.equal(result.units[0].status, 'unknown');
  });
}

const explanation =
  'no mapped anchor inside the changed range; the preceding anchor ran but cannot prove this code ran (it may have been removed by the bundler)';

for (const [name, before] of [
  [
    'unreachable declaration',
    'window.healthy = 1;\nfunction App() {\n  return "healthy";\n  const value = "down";\n}\nApp();',
  ],
  [
    'optimized idle ternary arm',
    'window.healthy = 1;\nfunction App() {\n  return true ? "healthy" : "down";\n}\nApp();',
  ],
  [
    'production-only removed debug JSX',
    'function App() {\n  if (process.env.NODE_ENV !== "production") {\n    return <p>Debug build down</p>;\n  }\n  return "healthy";\n}\nApp();',
  ],
  ['removed return after throw', 'function App() {\n  try { throw 1; return "down"; } catch {}\n}\nApp();'],
]) {
  test(`${name} removed by esbuild cannot inherit positive execution`, async () => {
    const after = before.replace('down', 'up');
    const maps = [];
    for (const text of [before, after]) {
      const bundle = await transform(text, {
        loader: 'jsx',
        minify: true,
        define: { 'process.env.NODE_ENV': '"production"' },
        sourcemap: 'external',
        sourcefile: 'app.js',
      });
      assert.ok(!bundle.code.includes(text === before ? 'down' : 'up'));
      const files = mapScriptCoverage(
        { functions: [{ ranges: [{ startOffset: 0, endOffset: bundle.code.length, count: 1 }] }] },
        bundle.code,
        JSON.parse(bundle.map),
        'https://app.test/app.js.map',
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
    const changes = changedScriptRanges(patches(before, after), { base: before, head: after }, 'app.js');
    const units = classifyScriptReach([maps[0]], [maps[1]], changes).units;
    assert.equal(units.length, 2);
    for (const unit of units) {
      assert.equal(unit.execution, 'unmeasured');
      assert.equal(unit.status, 'unmeasured');
      assert.equal(unit.executionScope, 'preceding-anchor');
      assert.ok(unit.why.startsWith(explanation));
    }
  });
}

for (const [state, expected] of [
  ['executed', 'unmeasured'],
  ['unexecuted', 'never-rendered'],
  ['mixed', 'never-rendered'],
]) {
  test(`an unopened multiline function without body anchors uses only negative ${state} preceding evidence`, () => {
    const before = 'window.healthy = 1;\nfunction Overlay() {\n  return "down";\n}\nwindow.overlay = Overlay;',
      after = before.replace('down', 'up');
    const maps = [before, after].map((text) => ({
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
                encoding: 'line-column-tuples',
                contentHash: sha256(text),
                executed: [],
                unexecuted: [],
                mixed: [],
                [state]: [[2, 0, 0]],
              },
            ],
          },
        ],
      },
    }));
    const changes = changedScriptRanges(patches(before, after), { base: before, head: after }, 'app.js');
    const proofs = changes.map((change) => ({ ...change, join: 'J1', status: 'reached' }));
    const units = classifyScriptReach([maps[0]], [maps[1]], changes, proofs).units;
    assert.equal(units.length, 2);
    assert.deepEqual(
      units.map((unit) => unit.status),
      [expected, expected],
    );
    assert.ok(units.every((unit) => unit.executionScope === 'preceding-anchor'));
    if (state === 'executed') assert.ok(units.every((unit) => unit.why.startsWith(explanation)));
  });
}

test('a column-zero start proves entry only when it starts inside the changed range', () => {
  const text = 'const value = "down";';
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
              encoding: 'line-column-tuples',
              contentHash: sha256(text),
              executed: [[1, 0, 0]],
              unexecuted: [],
              mixed: [],
            },
          ],
        },
      ],
    },
  };
  const changes = [0, 14].map((column) => ({
    sourceKey: 'app.js',
    side: 'head',
    text,
    contentHash: sha256(text),
    range: { start: { line: 1, column }, end: { line: 1, column: text.length } },
  }));
  const units = classifyScriptReach([map], [map], changes).units;
  assert.deepEqual(
    units.map((unit) => unit.execution),
    ['ran', 'unmeasured'],
  );
  assert.ok(units.every((unit) => unit.executionScope === 'line'));
  assert.ok(units[1].why.startsWith(explanation));
});

for (const [name, before, from, to, column] of [
  ['template tail', 'return a ? `Service\n    is down` : fallback;', 'is down', 'was down', 13],
  ['multi-token template tail', 'return a ? `Service\n    is down` : fallback;', 'is down', 'was unavailable', 13],
  ['clsx template tail', 'clsx(open && `\n    big`);', 'big', 'small', 8],
  ['empty map callback', 'xs.map((i) => foo +\n  5);', '5', '6', 3],
]) {
  test(`a changed ${name} combines idle leading text with later executed starts`, () => {
    const after = before.replace(from, to);
    const maps = [before, after].map((text) => ({
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
                encoding: 'line-column-tuples',
                contentHash: sha256(text),
                executed: [[2, text === before ? column : column + to.length - from.length, 0]],
                unexecuted: [[1, before.indexOf('`') >= 0 ? before.indexOf('`') : before.indexOf('foo'), 0]],
                mixed: [],
              },
            ],
          },
        ],
      },
    }));
    const patch = `@@ -1,2 +1,2 @@\n-${before.split('\n').join('\n-')}\n+${after.split('\n').join('\n+')}\n`;
    const changes = changedScriptRanges(patch, { base: before, head: after }, 'app.js');
    const units = classifyScriptReach([maps[0]], [maps[1]], changes).units.filter(
      (unit) => unit.range.start.line === 2,
    );
    assert.equal(units.length, 2);
    assert.deepEqual(
      units.map((unit) => unit.status),
      ['never-rendered', 'never-rendered'],
    );
    assert.deepEqual(
      units.map((unit) => unit.execution),
      ['partly-ran', 'partly-ran'],
    );
    assert.ok(units.every((unit) => unit.why.includes('leading')));
  });
}

for (const [prefix, state, expected] of [
  ['prefix; ', 'executed', 'unmeasured'],
  ['prefix; ', 'mixed', 'partly-ran'],
  [') ', 'unexecuted', 'ran'],
]) {
  test(`leading ${JSON.stringify(prefix)} with ${state} preceding evidence reads ${expected}`, () => {
    const index = indexScriptSources([
      {
        source: 'app.js',
        sourceKey: 'app.js',
        encoding: 'line-column-tuples',
        executed: [[2, prefix.length, 0]],
        unexecuted: [],
        mixed: [],
        [state]: [...(state === 'executed' ? [[2, prefix.length, 0]] : []), [1, 4, 0]],
      },
    ]);
    const text = prefix + 'value;';
    const unit = executionIn({ start: { line: 2, column: 0 }, end: { line: 2, column: text.length } }, index, text);
    assert.equal(unit.execution, expected);
    if (expected !== 'ran') assert.match(unit.why, /leading text/);
  });
}
