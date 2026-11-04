import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { sha256 } from '../dist/node-util.js';
import { changedScriptRanges, readScriptChanges } from '../dist/script-join-git.js';
import { classifyScriptReach, scriptJoinGap } from '../dist/script-join.js';
import { assessReachMaps, reachSummaryLine } from '../dist/report/reach.js';
import { makeMap } from './helpers.mjs';
import { stampCertifyingFixture } from './certifying-fixture.mjs';

function capture(text, column, idle = false) {
  return {
    ...makeMap(),
    scriptReach: {
      version: 1,
      window: 'navigation',
      status: 'measured',
      projectRootPrefix: '',
      scripts: [
        {
          url: '/app.js',
          status: 'mapped',
          files: [
            {
              source: 'app.ts',
              sourceKey: 'app.ts',
              contentHash: sha256(text),
              encoding: 'line-column-tuples',
              executed: idle ? [] : [[1, column, column]],
              unexecuted: idle ? [[1, column, column + 1]] : [],
              mixed: [],
            },
          ],
        },
      ],
    },
  };
}

function read(t, texts, maps) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'join-round5-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  const shas = texts.map((text) => {
    fs.writeFileSync(path.join(cwd, 'app.ts'), text);
    git('add', 'app.ts');
    git('commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  });
  const dirs = ['base', 'head'].map((side, i) => {
    const dir = path.join(cwd, side);
    fs.mkdirSync(dir);
    stampCertifyingFixture(dir, shas[i]);
    return dir;
  });
  return readScriptChanges(...dirs, { cwd, baseMaps: [maps[0]], headMaps: [maps[1]] });
}

function changes(t, texts, maps, adapter) {
  return adapter
    ? read(t, texts, maps).changes
    : changedScriptRanges(`@@ -1 +1 @@\n-${texts[0]}\n+${texts[1]}\n`, { base: texts[0], head: texts[1] }, 'app.ts');
}

const joins = [
  [
    'shared identifier prefix',
    'const v = base + baseOffset;',
    'const v = baseOffset;',
    'base + baseOffset',
    'baseOffset',
  ],
  ['member access', 'x = a.bc;', 'x = ac;', 'a.bc', 'ac'],
  ['argument separator', 'foo(a, b);', 'foo(ab);', 'a, b', 'ab'],
];
for (const [kind, left, right, leftRange, rightRange] of joins) {
  for (const reverse of [false, true]) {
    const texts = reverse ? [right, left] : [left, right];
    const spans = reverse ? [rightRange, leftRange] : [leftRange, rightRange];
    for (const adapter of [false, true]) {
      test(`${reverse ? 'splitting' : 'joining'} a ${kind} retains both anchored ranges${adapter ? ' through git' : ''}`, (t) => {
        const maps = texts.map((text, i) => capture(text, text.indexOf(spans[i]), i === 1));
        const units = classifyScriptReach([maps[0]], [maps[1]], changes(t, texts, maps, adapter)).units;
        assert.deepEqual(
          units.map((unit) => [
            unit.side,
            texts[unit.side === 'base' ? 0 : 1].slice(unit.range.start.column, unit.range.end.column),
            unit.execution,
            unit.status,
          ]),
          [
            ['base', spans[0], 'ran', 'unknown'],
            ['head', spans[1], 'never-ran', 'never-rendered'],
          ],
        );
      });
    }
  }
}

for (const reverse of [false, true]) {
  for (const adapter of [false, true]) {
    test(`a true ${reverse ? 'insertion' : 'deletion'} retains a touching token on the opposite side${adapter ? ' through git' : ''}`, (t) => {
      const pair = ['const label = value ?? fallbackLabel;', 'const label = fallbackLabel;'];
      const texts = reverse ? pair.toReversed() : pair;
      const spans = texts.map((text) => text.indexOf('fallbackLabel'));
      const maps = texts.map((text, i) => capture(text, spans[i], i === 1));
      const units = classifyScriptReach([maps[0]], [maps[1]], changes(t, texts, maps, adapter)).units;
      assert.deepEqual(
        units.map((unit) => unit.side),
        ['base', 'head'],
      );
      const side = reverse ? 'base' : 'head',
        unit = units.find((unit) => unit.side === side);
      const position = texts[reverse ? 0 : 1].indexOf('fallbackLabel');
      assert.equal(unit.changeScope, undefined);
      assert.equal(unit.range.start.column, position);
      assert.equal(unit.range.end.column, position + 'fallbackLabel'.length);
      assert.equal(unit.execution, reverse ? 'ran' : 'never-ran');
      assert.equal(unit.status, reverse ? 'unknown' : 'never-rendered');
    });
  }
}

for (const reverse of [false, true]) {
  for (const adapter of [false, true]) {
    test(`an operator-only ${reverse ? 'deletion' : 'insertion'} uses line scope${adapter ? ' through git' : ''}`, (t) => {
      const pair = ['a == b', 'a === b'],
        texts = reverse ? pair.toReversed() : pair;
      const maps = texts.map((text, i) => capture(text, 0, i === 1));
      const units = classifyScriptReach([maps[0]], [maps[1]], changes(t, texts, maps, adapter)).units;
      assert.deepEqual(
        units.map((unit) => [unit.side, unit.changeScope, unit.range.start.column, unit.range.end.column, unit.status]),
        [
          ['base', 'line', 0, texts[0].length, 'unknown'],
          ['head', 'line', 0, texts[1].length, 'never-rendered'],
        ],
      );
    });
  }
}

test('legacy reach summaries add omitted gap records without counting unit or path notices', () => {
  const map = capture('const x = 1;', 10);
  const reach = assessReachMaps([map], [map], 'warn', { changes: [], gaps: [] });
  delete reach.scriptGapCount;
  reach.gaps = [
    scriptJoinGap('one listed evidence gap'),
    scriptJoinGap('J2 gaps truncated: 7 more in report.json; first: gap'),
    scriptJoinGap('J2 units truncated: 99 more omitted from report.json'),
    scriptJoinGap('J2 gap paths truncated: 1000 more omitted from report.json'),
  ];
  assert.match(reachSummaryLine(reach), /8 run-level gap\(s\)/);
  reach.scriptGapCount = 42;
  assert.match(reachSummaryLine(reach), /42 run-level gap\(s\)/);
});
