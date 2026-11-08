import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyScriptReach } from '../dist/script-join.js';
import { sha256 } from '../dist/node-util.js';
import { changedScriptRanges } from '../dist/script-join-git.js';
import { overlaySource, shapedCapture, sourceChanges } from './script-join-round6-fixture.mjs';

const cases = [
  ['CSS template line', overlaySource(), 'color: red;', 'color: blue;', null],
  ['multiline JSX text', overlaySource(), 'Service is down,', 'Service is up,', null],
  [
    'single-line JSX text',
    'function Overlay() { return <p>Service is down now</p>; }\nwindow.overlay = Overlay;',
    'down',
    'up',
    ['Service is down now', 'Service is up now'],
  ],
  [
    'fragment JSX text',
    'function Overlay() { return <>Service is down now</>; }\nwindow.overlay = Overlay;',
    'down',
    'up',
    ['Service is down now', 'Service is up now'],
  ],
  ...[
    ['hexadecimal', '0x1f', '0x2f'],
    ['exponent', '1e3', '1e4'],
    ['separator', '1_000', '1_500'],
    ['leading decimal', '.5', '.6'],
    ['binary', '0b11', '0b01'],
    ['octal', '0o17', '0o16'],
    ['bigint', '0x1fn', '0x2fn'],
    ['signed exponent', '1.5e-3', '1.5e-4'],
    ['regex literal', '/ab/', '/ac/'],
    ['regex character class', '/[a/b]+/gi', '/[a/c]+/gi'],
    ['uppercase hexadecimal', '0X1F', '0X2F'],
  ].map(([kind, before, after]) => [
    kind,
    `function Overlay() {\n  return ${before};\n}\nwindow.overlay = Overlay;`,
    before,
    after,
    [before, after],
  ]),
  [
    'private name',
    'function Overlay() {\n  class Box { #p = 1; #q = 2; get() { return this.#p; } }\n  return new Box().get();\n}\nwindow.overlay = Overlay;',
    'this.#p',
    'this.#q',
    ['#p', '#q'],
  ],
];

for (const [name, before, from, to, tokens] of cases) {
  for (const ran of [false, true]) {
    const expected = ran ? (tokens ? 'unknown' : 'unmeasured') : 'never-rendered';
    test(`${name} on an ${ran ? 'executed' : 'unopened'} overlay is ${expected}`, async () => {
      const after = before.replace(from, to);
      const maps = await Promise.all([shapedCapture(before, ran), shapedCapture(after, ran)]);
      const changes = sourceChanges(before, after);
      const units = classifyScriptReach([maps[0]], [maps[1]], changes).units;
      assert.deepEqual(
        units.map((unit) => [unit.side, unit.status]),
        [
          ['base', expected],
          ['head', expected],
        ],
      );
      if (tokens)
        assert.deepEqual(
          units.map((unit, i) => {
            const text = i ? after : before;
            return text.split('\n')[unit.range.start.line - 1].slice(unit.range.start.column, unit.range.end.column);
          }),
          tokens,
        );
      else {
        assert.ok(units.every((unit) => unit.executionScope === 'preceding-anchor'));
        assert.ok(units.every((unit) => /preceding-anchor/.test(unit.why)));
      }
    });
  }
}

function captured(text, executed, mixed = [], url = '/app.js', unexecuted = []) {
  return {
    scriptReach: {
      version: 1,
      window: 'navigation',
      status: 'measured',
      scripts: [
        {
          url,
          status: 'mapped',
          files: [
            {
              source: 'app.ts',
              sourceKey: 'app.ts',
              encoding: 'line-column-tuples',
              contentHash: sha256(text),
              executed,
              mixed,
              unexecuted,
            },
          ],
        },
      ],
    },
  };
}
const change = (text, start, end, line = 1) => ({
  sourceKey: 'app.ts',
  side: 'head',
  text,
  contentHash: sha256(text),
  range: { start: { line, column: start }, end: { line, column: end } },
});

test('a mixed preceding anchor keeps an unopened nullish fallback flagged', () => {
  const text = 'x = a ?? fallback;',
    map = captured(text, [[1, 4, 4]], [[1, 9, 17]]);
  const result = classifyScriptReach([map], [map], [change(text, 4, 5), change(text, 12, 16)]).units;
  assert.deepEqual(
    result.map((unit) => [unit.execution, unit.status]),
    [
      ['ran', 'unknown'],
      ['partly-ran', 'never-rendered'],
    ],
  );
  assert.equal(result[1].executionScope, 'preceding-anchor');
});

test('preceding lookup never takes a future anchor or another source', () => {
  const text = 'x = value;',
    future = captured(text, [], [], '/app.js', [[1, 4, 9]]);
  assert.equal(classifyScriptReach([future], [future], [change(text, 0, 1)]).units[0].execution, 'unmeasured');
  const empty = captured(text, []);
  const other = captured(text, [], [], '/other.js', [[1, 0, 9]]);
  other.scriptReach.scripts[0].files[0].sourceKey = 'other.ts';
  assert.equal(classifyScriptReach([empty], [empty, other], [change(text, 7, 8)]).units[0].execution, 'unmeasured');
});

for (const after of ['x = a.c ?? b;', 'x = a() ?? b;']) {
  test(`appending ${after.includes('a.c') ? 'a property' : 'a call'} preserves the evaluated base operand`, () => {
    const before = 'x = a ?? b;';
    const maps = [
      captured(before, [[1, 4, 4]], [], '/app.js', [[1, 9, 10]]),
      captured(
        after,
        after.includes('a.c')
          ? [
              [1, 4, 4],
              [1, 6, 6],
            ]
          : [[1, 4, 4]],
        [],
        '/app.js',
        [[1, after.indexOf('b'), after.indexOf('b') + 1]],
      ),
    ];
    const changes = changedScriptRanges(
      `@@ -1 +1 @@\n-${before}\n+${after}\n`,
      { base: before, head: after },
      'app.ts',
    );
    const units = classifyScriptReach([maps[0]], [maps[1]], changes).units;
    assert.deepEqual(
      units.map((unit) => [unit.execution, unit.status]),
      [
        ['ran', 'unknown'],
        ['ran', 'unknown'],
      ],
    );
    assert.equal(units[0].range.start.column, 4);
    assert.equal(units[0].range.end.column, 5);
    assert.equal(units[0].changeScope, undefined);
  });
}

for (const sameUrl of [false, true]) {
  test(`${sameUrl ? 'same-script' : 'different-chunk'} executed evidence ${sameUrl ? 'can' : 'cannot'} clear a mixed start`, () => {
    const text = 'x = a ?? b;',
      mixed = captured(text, [], [[1, 4, 5]]);
    const executed = captured(text, [[1, 4, 4]], [], sameUrl ? '/app.js' : '/chunk.js');
    const combined = {
      scriptReach: { ...mixed.scriptReach, scripts: [...mixed.scriptReach.scripts, ...executed.scriptReach.scripts] },
    };
    for (const maps of [[mixed, executed], [executed, mixed], [combined]]) {
      const [unit] = classifyScriptReach(maps, maps, [change(text, 4, 5)]).units;
      assert.equal(unit.execution, sameUrl ? 'ran' : 'partly-ran');
      assert.equal(unit.status, sameUrl ? 'unknown' : 'never-rendered');
    }
  });
}

test('division is not widened to a regex literal', () => {
  const texts = { base: 'const v = a / b / c;', head: 'const v = a / d / c;' };
  const changes = changedScriptRanges(`@@ -1 +1 @@\n-${texts.base}\n+${texts.head}\n`, texts, 'app.ts');
  assert.deepEqual(
    changes.map((unit) => texts[unit.side].slice(unit.range.start.column, unit.range.end.column)),
    ['b', 'd'],
  );
});

for (const [base, head, expected] of [
  ['const v = <p /> + left;', 'const v = <p /> + right;', ['left', 'right']],
  ['const v = "<p>down</p>";', 'const v = "<p>up</p>";', ['"<p>down</p>"', '"<p>up</p>"']],
]) {
  test(`JSX tokenization preserves ordinary code boundaries in ${base}`, () => {
    const changes = changedScriptRanges(`@@ -1 +1 @@\n-${base}\n+${head}\n`, { base, head }, 'app.ts');
    assert.deepEqual(
      changes.map((unit) => ({ base, head })[unit.side].slice(unit.range.start.column, unit.range.end.column)),
      expected,
    );
  });
}

test('touching the right-hand token does not import its idle anchor into the removed prefix', () => {
  const before = 'const label = value ?? fallbackLabel;',
    after = 'const label = fallbackLabel;';
  const base = captured(before, [[1, before.indexOf('value'), before.indexOf('value')]], [], '/app.js', [
    [1, before.indexOf('fallbackLabel'), before.indexOf('fallbackLabel') + 13],
  ]);
  const head = captured(after, [[1, after.indexOf('fallbackLabel'), after.indexOf('fallbackLabel')]]);
  const changes = changedScriptRanges(`@@ -1 +1 @@\n-${before}\n+${after}\n`, { base: before, head: after }, 'app.ts');
  assert.deepEqual(
    classifyScriptReach([base], [head], changes).units.map((unit) => [unit.execution, unit.status]),
    [
      ['ran', 'unknown'],
      ['ran', 'unknown'],
    ],
  );
});
