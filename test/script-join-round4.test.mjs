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
import { budgetScriptReach, reserveScriptNotice } from '../dist/report/script-units.js';
import { scriptGapLines } from '../dist/report/script-gap-details.js';
import { makeMap } from './helpers.mjs';
import { stampCertifyingFixture } from './certifying-fixture.mjs';

function capture(text, token, idle = false) {
  const column = text.indexOf(token);
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
              unexecuted: idle ? [[1, column, column + token.length]] : [],
              mixed: [],
            },
          ],
        },
      ],
    },
  };
}

function revisions(t, before, after) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'join-round4-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  const commit = (text) => {
    fs.writeFileSync(path.join(cwd, 'app.ts'), text);
    git('add', '.');
    git('commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  const shas = [commit(before), commit(after)];
  const dirs = ['base', 'head'].map((name, i) => {
    const dir = path.join(cwd, name);
    fs.mkdirSync(dir);
    stampCertifyingFixture(dir, shas[i]);
    return dir;
  });
  return (baseMaps, headMaps) => readScriptChanges(...dirs, { cwd, baseMaps, headMaps });
}

const edits = [
  ['string end', "color: '#ffffff'", "color: '#fff'", "'#ffffff'", "'#fff'"],
  ['number end', 'width: 120', 'width: 12', '120', '12'],
  ['identifier end', 'a ?? bb', 'a ?? b', 'bb', 'b'],
  ['string interior', "color: '#ff00ff'", "color: '#ffff'", "'#ff00ff'", "'#ffff'"],
  ['number interior', 'width: 1203', 'width: 123', '1203', '123'],
  ['identifier interior', 'a ?? fallback', 'a ?? falback', 'fallback', 'falback'],
];
for (const [kind, long, short, longToken, shortToken] of edits) {
  for (const lengthen of [false, true]) {
    const before = 'const value = ' + (lengthen ? short : long) + ';',
      after = 'const value = ' + (lengthen ? long : short) + ';',
      baseToken = lengthen ? shortToken : longToken,
      headToken = lengthen ? longToken : shortToken;
    for (const adapter of [false, true]) {
      test(`${lengthen ? 'lengthening' : 'shortening'} a ${kind} retains both token units${adapter ? ' through the git adapter' : ''}`, (t) => {
        const base = capture(before, baseToken),
          head = capture(after, headToken, true);
        const changes = adapter
          ? revisions(t, before, after)([base], [head]).changes
          : changedScriptRanges(`@@ -1 +1 @@\n-${before}\n+${after}\n`, { base: before, head: after }, 'app.ts');
        const units = classifyScriptReach([base], [head], changes).units;
        assert.deepEqual(
          units.map((u) => [u.side, u.range.start.column, u.range.end.column, u.execution, u.status]),
          [
            ['base', before.indexOf(baseToken), before.indexOf(baseToken) + baseToken.length, 'ran', 'unknown'],
            [
              'head',
              after.indexOf(headToken),
              after.indexOf(headToken) + headToken.length,
              'never-ran',
              'never-rendered',
            ],
          ],
        );
      });
    }
  }
}

for (const reverse of [false, true]) {
  test(`a true expression ${reverse ? 'deletion' : 'insertion'} omits only its empty side`, (t) => {
    const before = reverse ? 'const value = a ?? b ?? c;' : 'const value = a ?? b;',
      after = reverse ? 'const value = a ?? b;' : 'const value = a ?? b ?? c;';
    const result = revisions(t, before, after)([capture(before, 'a')], [capture(after, 'a')]);
    assert.deepEqual(
      result.changes.map((c) => c.side),
      [reverse ? 'base' : 'head'],
    );
    assert.ok(result.changes.every((c) => c.range.end.column > c.range.start.column));
  });
}

for (const [kind, before, after] of [
  ['EOF newline addition', 'const value = 1;\nconst stable = 3;', 'const value = 2;\nconst stable = 3;\n'],
  ['EOF newline deletion', 'const value = 1;\nconst stable = 3;\n', 'const value = 2;\nconst stable = 3;'],
  ['CRLF to LF', 'const value = 1;\r\nconst stable = 3;\r\n', 'const value = 2;\nconst stable = 3;\n'],
  ['LF to CRLF', 'const value = 1;\nconst stable = 3;\n', 'const value = 2;\r\nconst stable = 3;\r\n'],
]) {
  test(`${kind} keeps both changed line units when another line also changes`, (t) => {
    const base = capture(before, '1'),
      head = capture(after, '2');
    const diff = revisions(t, before, after)([base], [head]);
    const units = classifyScriptReach([base], [head], diff.changes).units.filter((u) => u.range.start.line === 2);
    assert.deepEqual(
      units.map((u) => [u.side, u.changeScope, u.status]),
      [
        ['base', 'line', 'unmeasured'],
        ['head', 'line', 'unmeasured'],
      ],
    );
    assert.ok(units.every((u) => /line ending/.test(u.why)));
  });
}

test('JSON truncation says details are omitted from the artifact and preserves the real gap count', () => {
  const map = capture('const x = 1;', '1');
  const original = assessReachMaps([map], [map], 'warn', {
    changes: [
      {
        sourceKey: 'app.ts',
        side: 'head',
        range: { start: { line: 1, column: 10 }, end: { line: 1, column: 11 } },
        text: 'const x = 1;',
        contentHash: sha256('const x = 1;'),
      },
    ],
    gaps: [scriptJoinGap('source gap A'), { ...scriptJoinGap('source gap B'), paths: ['lazy.mdx'] }],
  });
  const { reach } = budgetScriptReach(original, reserveScriptNotice(original), 0);
  const notices = reach.gaps.filter((g) => g.join === 'J2');
  assert.equal(notices.length, 3);
  assert.ok(notices.every((g) => /more omitted from report.json/.test(g.reason)));
  assert.match(reachSummaryLine(reach), /2 run-level gap\(s\)/);
});

for (const ending of ['', '\r\n']) {
  test(`${ending ? 'CRLF' : 'EOF'} newline-only changes retain both sides in a separate git hunk`, (t) => {
    const before = 'const value = 1;\nconst unchanged = true;\nconst stable = 3;' + ending,
      after = 'const value = 2;\nconst unchanged = true;\nconst stable = 3;\n';
    const base = capture(before, '1'),
      head = capture(after, '2');
    const diff = revisions(t, before, after)([base], [head]);
    const units = classifyScriptReach([base], [head], diff.changes).units.filter((u) => u.range.start.line === 3);
    assert.deepEqual(
      units.map((u) => [u.side, u.changeScope, u.status]),
      [
        ['base', 'line', 'unmeasured'],
        ['head', 'line', 'unmeasured'],
      ],
    );
    assert.ok(units.every((u) => /line ending/.test(u.why)));
  });
}

test('human truncation says omitted details are absent from this report', () => {
  const gaps = Array.from({ length: 101 }, (_, i) => ({
    ...scriptJoinGap(`source gap ${i}`),
    paths: [`file-${i}.mdx`],
  }));
  const lines = scriptGapLines(gaps).join('\n');
  assert.match(lines, /J2 gaps truncated: 1 more omitted from this report/);
  assert.match(lines, /J2 gap paths truncated: 1 more omitted from this report/);
});

test('presentation notices never replace the number of actual J2 evidence gaps', () => {
  const map = capture('const x = 1;', '1');
  const original = assessReachMaps([map], [map], 'warn', {
    changes: [],
    gaps: [scriptJoinGap('gap A'), scriptJoinGap('gap B')],
  });
  const { reach } = budgetScriptReach(original, reserveScriptNotice(original), 0);
  assert.match(reachSummaryLine(reach), /2 run-level gap\(s\)/);
});
