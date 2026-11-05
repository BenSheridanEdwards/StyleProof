import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mapScriptCoverage } from '../dist/script-reach.js';
import { compactScriptEvidence } from '../dist/script-reach-storage.js';
import { classifyScriptReach } from '../dist/script-join.js';
import { changedScriptRanges, readScriptChanges } from '../dist/script-join-git.js';
import { assessReachMaps, reachSectionLines } from '../dist/report/reach.js';
import { generateStyleMapReport } from '../dist/report.js';
import { DEFAULT_MAX_JSON_BYTES } from '../dist/report/sections.js';
import { sha256 } from '../dist/node-util.js';
import { resolveSettings } from '../dist/runner/settings.js';
import { makeMap, writeCapture } from './helpers.mjs';
import { stampCertifyingFixture } from './certifying-fixture.mjs';

const span = (line, start, end) => ({ start: { line, column: start }, end: { line, column: end } });
const change = (text, line = 1, start = 0, end = text.length) => ({
  sourceKey: 'app.ts',
  side: 'head',
  range: span(line, start, end),
  contentHash: sha256(text),
  text,
});
const measured = (text = 'const a = 1;', key = 'app.ts') => ({
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
            source: key,
            sourceKey: key,
            encoding: 'line-column-tuples',
            contentHash: sha256(text),
            executed: text.split('\n').map((_, i) => [i + 1, 0, 0]),
            unexecuted: [],
            mixed: [],
          },
        ],
      },
    ],
  },
});
function repository(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'join-round2-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  const write = (file, text) => fs.writeFileSync(path.join(cwd, file), text);
  const commit = () => {
    git('add', '.');
    git('commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  const beforeDir = path.join(cwd, 'base'),
    afterDir = path.join(cwd, 'head');
  const stamp = (base, head) => {
    for (const [dir, sha] of [
      [beforeDir, base],
      [afterDir, head],
    ]) {
      fs.mkdirSync(dir);
      stampCertifyingFixture(dir, sha);
    }
  };
  const read = (baseMaps = [measured()], headMaps = [measured()]) =>
    readScriptChanges(beforeDir, afterDir, { cwd, baseMaps, headMaps });
  return { cwd, git, write, commit, stamp, read, beforeDir, afterDir };
}

test('one column-zero map retains a hidden ternary branch for whole-line and token changes', () => {
  const text = "const label = fault ? 'red' : 'blue';";
  const start = text.indexOf("'red'");
  const files = mapScriptCoverage(
    {
      functions: [
        {
          ranges: [
            { startOffset: 0, endOffset: text.length, count: 1 },
            { startOffset: start, endOffset: start + 5, count: 0 },
          ],
        },
      ],
    },
    text,
    { version: 3, sources: ['app.ts'], sourcesContent: [text], names: [], mappings: 'AAAA' },
    'https://example.test/app.js.map',
  );
  const capture = {
    scriptReach: {
      ...measured().scriptReach,
      scripts: [compactScriptEvidence({ url: '/app.js', status: 'mapped', files })],
    },
  };
  for (const unit of classifyScriptReach([capture], [capture], [change(text), change(text, 1, start, start + 5)])
    .units) {
    assert.equal(unit.execution, 'partly-ran');
    assert.equal(unit.status, 'never-rendered');
    assert.equal(unit.executionScope, 'line');
  }
});

test('column-zero-only evidence always discloses line scope even when its anchor is inside the range', () => {
  const text = 'const a = 1;';
  const [unit] = classifyScriptReach([measured(text)], [measured(text)], [change(text)]).units;
  assert.equal(unit.executionScope, 'line');
});

for (const tokenScoped of [false, true])
  test(`advisory J2 ${tokenScoped ? 'token' : 'line'} detail cannot evict twenty style findings from the default JSON budget`, (t) => {
    const f = repository(t);
    const texts = {
      base:
        Array.from({ length: 1500 }, (_, i) => `const value${i} = 1;${tokenScoped ? '\nunchanged();' : ''}`).join(
          '\n',
        ) + '\n',
      head:
        Array.from({ length: 1500 }, (_, i) => `const value${i} = 2;${tokenScoped ? '\nunchanged();' : ''}`).join(
          '\n',
        ) + '\n',
    };
    f.write('app.ts', texts.base);
    const base = f.commit();
    f.write('app.ts', texts.head);
    const head = f.commit();
    f.stamp(base, head);
    for (const side of ['base', 'head']) {
      const map = {
        ...makeMap({
          elements: Object.fromEntries(
            Array.from({ length: 20 }, (_, i) => [
              `body > div:nth-child(${i + 1})`,
              { tag: 'div', rect: [0, i * 10, 10, 10], style: { color: side === 'base' ? 'red' : 'blue' } },
            ]),
          ),
        }),
        ...measured(texts[side]),
        reach: { version: 2, scope: 'compared', sheets: [], rules: [] },
      };
      writeCapture(side === 'base' ? f.beforeDir : f.afterDir, 'home@1280', map, null);
    }
    const render = (name, options = {}) => {
      const previous = process.cwd();
      process.chdir(f.cwd);
      try {
        return generateStyleMapReport({
          beforeDir: f.beforeDir,
          afterDir: f.afterDir,
          outDir: path.join(f.cwd, name),
          ...options,
        });
      } finally {
        process.chdir(previous);
      }
    };
    const output = render('report');
    const raw = fs.readFileSync(output.reportJsonPath, 'utf8'),
      json = JSON.parse(raw);
    assert.equal(output.totalFindings, 20);
    assert.equal(json.surfaces.flatMap((surface) => surface.findings ?? []).length, 20);
    assert.ok(Buffer.byteLength(raw) <= DEFAULT_MAX_JSON_BYTES, `${Buffer.byteLength(raw)} JSON bytes`);
    assert.equal(json.findingsBudget?.omitted ?? 0, 0);
    assert.equal(json.reach.scriptCounts.unmeasured, 3000);
    const metadata = { ...json, reach: { ...json.reach, scripts: [] } };
    const tightBytes = Buffer.byteLength(JSON.stringify(metadata, null, 2)) + 1024;
    const tight = render('tight-report', { maxJsonBytes: tightBytes });
    const tightRaw = fs.readFileSync(tight.reportJsonPath, 'utf8'),
      tightJson = JSON.parse(tightRaw);
    assert.equal(tightJson.surfaces.flatMap((surface) => surface.findings ?? []).length, 20);
    assert.ok(Buffer.byteLength(tightRaw) <= tightBytes);
    assert.ok(tightJson.reach.gaps.some((gap) => /J2 units truncated/.test(gap.reason)));

    if (tokenScoped) {
      const retained = json.reach.scripts.reduce((sum, unit) => sum + (unit.count ?? 1), 0);
      assert.ok(retained < 3000);
      assert.ok(json.reach.gaps.some((gap) => gap.reason.includes(`J2 units truncated: ${3000 - retained} more`)));
      assert.match(fs.readFileSync(output.reportMdPath, 'utf8'), /J2 units truncated: \d+ more/);
    } else {
      assert.equal(json.reach.scripts.length, 2);
      assert.equal(
        json.reach.scripts.reduce((sum, unit) => sum + unit.count, 0),
        3000,
      );
    }
  });

test('empty template-literal lines added and removed remain individually unmeasured', (t) => {
  const f = repository(t);
  const before = 'const style = css`\ncolor: red;\n`;\n',
    after = 'const style = css`\n\ncolor: red;\n`;\n';
  f.write('app.ts', before);
  const base = f.commit();
  f.write('app.ts', after);
  const head = f.commit();
  f.stamp(base, head);
  const result = f.read([measured(before)], [measured(after)]);
  const joined = classifyScriptReach([measured(before)], [measured(after)], result.changes);
  assert.equal(joined.units.length, 1);
  assert.equal(joined.units[0].range.start.line, 2);
  assert.equal(joined.units[0].status, 'unmeasured');
  assert.match(joined.units[0].why, /no anchors on an empty line/);
  const removed = changedScriptRanges('@@ -2 +1,0 @@\n-\n', { base: after, head: before }, 'app.ts');
  assert.equal(classifyScriptReach([measured(after)], [measured(before)], removed).units.length, 1);
});

test('type changes and CR content do not invalidate healthy sibling paths', (t) => {
  const f = repository(t);
  f.write('app.ts', 'const x = 1;\n');
  f.write('link.ts', 'target.ts\n');
  f.write('cr.ts', 'const x = "before";\n');
  const base = f.commit();
  fs.unlinkSync(path.join(f.cwd, 'link.ts'));
  fs.symlinkSync('target.ts', path.join(f.cwd, 'link.ts'));
  f.write('app.ts', 'const x = 2;\n');
  f.write('cr.ts', 'const x = "after\rdiff --git a/fake.ts b/fake.ts";\n');
  const head = f.commit();
  f.stamp(base, head);
  const result = f.read();
  assert.ok(result.changes.some((entry) => entry.sourceKey === 'app.ts'));
  assert.ok(result.changes.some((entry) => entry.sourceKey === 'cr.ts'));
  assert.ok(
    result.changes.some((entry) => entry.sourceKey === 'link.ts') ||
      result.gaps.some((gap) => gap.paths?.includes('link.ts')),
  );
  assert.ok(!result.gaps.some((gap) => /^git source diff unavailable/.test(gap.reason)));
});

test('a valid captured root still lists unloaded-only changed files as not loaded', (t) => {
  const f = repository(t);
  const oldText = 'const lazy = 1;\n',
    newText = 'const lazy = 2;\n';
  f.write('lazy.ts', oldText);
  const base = f.commit();
  f.write('lazy.ts', newText);
  const head = f.commit();
  f.stamp(base, head);
  const maps = [measured('const a = 1;', 'a.ts')];
  const result = f.read(maps, maps);
  assert.equal(result.changes.length, 2);
  const units = classifyScriptReach(maps, maps, result.changes).units;
  assert.ok(units.every((unit) => unit.execution === 'not-loaded' && unit.status === 'unmeasured'));
  assert.ok(result.gaps.some((gap) => /no changed path/.test(gap.reason)));
});

test('inter-hunk context and user diff formatting cannot attribute unchanged lines', (t) => {
  const f = repository(t),
    texts = {
      base: 'const a = 1;\nkeep();\nstay();\nconst b = 1;\n',
      head: 'const a = 2;\nkeep();\nstay();\nconst b = 2;\n',
    };
  f.write('app.ts', texts.base);
  const base = f.commit();
  f.write('app.ts', texts.head);
  const head = f.commit();
  f.stamp(base, head);
  f.git('config', 'diff.interHunkContext', '5');
  f.git('config', 'diff.noprefix', 'true');
  f.git('config', 'diff.srcPrefix', 'BEFORE/');
  f.git('config', 'diff.dstPrefix', 'AFTER/');
  f.git('config', 'diff.outputIndicatorNew', '>');
  const result = f.read([measured(texts.base)], [measured(texts.head)]);
  assert.deepEqual(
    result.changes.map((entry) => [entry.side, entry.range.start.line]),
    [
      ['base', 1],
      ['base', 4],
      ['head', 1],
      ['head', 4],
    ],
  );
  const parsed = changedScriptRanges(
    '@@ -1,4 +1,4 @@\n-const a = 1;\n+const a = 2;\n keep();\n stay();\n-const b = 1;\n+const b = 2;\n',
    texts,
    'app.ts',
  );
  assert.equal(parsed.length, 4);
});

test('long residual candidates stay unknown without running unbounded naming regexes', () => {
  const text = '(a=1,'.repeat(600);
  const maps = [measured(text)];
  maps[0].scriptReach.scripts[0].files[0].executed = [...text.matchAll(/[a1]/g)].map((token) => [
    1,
    token.index,
    token.index,
  ]);
  const [unit] = classifyScriptReach(maps, maps, [change(text)]).units;
  assert.equal(unit.status, 'unknown');
  assert.match(unit.why, /residual naming skipped.*128/);
});

test('capture settings resolve project-root provenance once for the whole run', (t) => {
  const f = repository(t);
  const settings = resolveSettings({ dir: path.join(f.cwd, 'maps'), captureScriptReach: true }, f.cwd);
  assert.equal(settings.projectRootPrefix, '');
});

test('J2 gaps cannot suppress the incomplete J1 ledger fallback under gate', () => {
  const map = { ...measured(), reach: { version: 2, scope: 'compared', sheets: [], rules: [], complete: false } };
  // An invalid negative count leaves no concrete per-side ledger row.
  map.reach.unreadable = -1;
  const result = assessReachMaps([map], [map], 'gate', {
    changes: [],
    gaps: [
      {
        join: 'J2',
        kind: 'execution',
        status: 'unmeasured',
        reason: 'source map absent',
        remedy: 'capture source maps',
      },
    ],
  });
  assert.equal(result.ledger, 'partial');
  assert.ok(result.gaps.some((gap) => gap.kind === 'ledger' && /reach ledger incomplete/.test(gap.reason)));
  assert.ok(result.blocking > 0);
});

test('token-scoped units keep their exact columns instead of merging across adjacent lines', () => {
  const unit = (line) => ({
    sourceKey: 'app.ts',
    side: 'head',
    range: span(line, 10, 11),
    execution: 'ran',
    status: 'unknown',
    why: 'value; rendering not proved',
    level: 'warn',
  });
  const rows = reachSectionLines({ level: 'warn', rules: [], gaps: [], scripts: [unit(1), unit(2)] }).filter((row) =>
    row.startsWith('| `app.ts'),
  );
  assert.equal(rows.length, 2);
  assert.ok(rows.some((row) => row.includes('app.ts:1:10-1:11')));
  assert.ok(rows.some((row) => row.includes('app.ts:2:10-2:11')));
});

test('a side without coverage still lists its changed lines using the other side root provenance', (t) => {
  const f = repository(t),
    before = 'const x = 1;\n',
    after = 'const x = 2;\n';
  f.write('app.ts', before);
  const base = f.commit();
  f.write('app.ts', after);
  const head = f.commit();
  f.stamp(base, head);
  const result = f.read([{}], [measured(after)]);
  assert.deepEqual(
    result.changes.map((unit) => unit.side),
    ['base', 'head'],
  );
  const units = classifyScriptReach([{}], [measured(after)], result.changes).units;
  assert.equal(units[0].status, 'unmeasured');
  assert.match(units[0].why, /coverage missing/);
});

test('unmeasured script reasons use explicit Unicode code-point ordering', () => {
  const map = measured();
  map.scriptReach.scripts = ['\u{10000}', '\ue000'].map((reason) => ({
    url: '/missing.js',
    status: 'unmeasured',
    reason,
  }));
  const { units } = classifyScriptReach([map], [map], [change('const a = 1;')]);
  assert.equal(units[0].why, '\ue000; \u{10000}');
});
