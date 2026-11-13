import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';
import { classLiterals } from '../dist/class-join-literals.js';
import { captureAuthorShadowRoots } from '../dist/capture/class-presence.js';
import { codeValue } from '../dist/code-span.js';
import { classifyClassReach } from '../dist/class-join.js';
import { assessReachDirs } from '../dist/report/reach.js';
import { saveStyleMap } from '../dist/capture.js';
import { stampCertifyingFixture } from './certifying-fixture.mjs';
import { mkTmp, rmTmp, spawnSyncToCompletion } from './helpers.mjs';

const map = {
  defaults: {},
  states: {},
  elements: {},
  reach: { version: 2, scope: 'compared', sheets: ['app.css'], rules: [{ key: '.known', hash: 'x', sheet: 0 }] },
};
test('codeValue handles many disjoint backtick runs without spreading arguments', () => {
  const value = '`x'.repeat(150000);
  assert.equal(codeValue(value), '`` ' + value + ' ``');
});
test('closed-root inventory traverses a wide CDP document without argument spreading', async () => {
  const author = { shadowRootType: 'closed' };
  const root = { nodeType: 9, children: Array.from({ length: 150000 }, () => ({ shadowRoots: [author] })) };
  let detached = false;
  const client = {
    send: async () => ({ root }),
    detach: async () => {
      detached = true;
    },
  };
  const page = { context: () => ({ newCDPSession: async () => client }) };
  assert.equal(await captureAuthorShadowRoots(page), 150000);
  assert.equal(detached, true);
});
const change = (text, sourceKey = 'app.ts', side = 'head') => ({
  text,
  classSource: text,
  sourceKey,
  side,
  contentHash: text,
  range: {
    start: { line: 1, column: 0 },
    end: { line: text.split('\n').length, column: text.split('\n').at(-1).length },
  },
});

for (const source of [
  "el.className=Math.abs(n)<lo?'a':n>=hi?'b':'c';",
  "el.className=n<lo?'a':n>=hi?'b':'c';",
  "cn(a<b?'a':'b',c>=d&&'c');",
  "s>>=1;el.className=n<lo?'a':n>=hi?'b':'c';",
])
  for (const kind of ['ts', 'tsx', 'vue', 'svelte'])
    test(`compact runtime angles stay runtime: ${kind} ${source}`, () => {
      const wrapped = ['vue', 'svelte'].includes(kind) ? `<script lang="ts">${source}</script>` : source;
      const literals = classLiterals(wrapped, `app.${kind}`);
      for (const token of ['a', 'b', 'c'])
        assert.ok(
          literals.some((l) => l.explicit && l.words.some((w) => w.token === token)),
          token,
        );
    });

test('unresolved gaps aggregate per file/side with exact counts and bounded deterministic samples', () => {
  const source = 'el.className=`btn ${on?"old":"new"}`;\n'.repeat(20);
  const input = [change(source), change(source, 'app.ts', 'base'), change(source, 'other.ts')];
  const result = classifyClassReach([map], [map], input, [{ base: map, head: map }]);
  assert.equal(result.gaps.length, 3);
  for (const gap of result.gaps) {
    assert.equal(gap.occurrenceCount, 60);
    assert.equal(gap.sampleRanges.length, 10);
    assert.match(gap.reason, /explicit class expression unresolved/);
    for (const r of gap.sampleRanges)
      assert.ok(gap.reason.includes(`${r.start.line}:${r.start.column}-${r.end.line}:${r.end.column}`));
    assert.equal(gap.paths.length, 1);
  }
  assert.deepEqual(classifyClassReach([map], [map], input.toReversed(), [{ base: map, head: map }]), result);
  const duplicate = classifyClassReach([map], [map], [input[0], input[0]], [{ base: map, head: map }]);
  assert.equal(duplicate.gaps[0].occurrenceCount, 60);
  const mixed = classifyClassReach(
    [map],
    [map],
    [change("el.className='missing'; el.className='known';")],
    [{ base: map, head: map }],
  );
  assert.equal(mixed.units.length, 1);
  assert.equal(mixed.units[0].status, 'unknown', 'an unrelated unresolved expression does not broaden range evidence');
  const nested = classifyClassReach(
    [map],
    [map],
    [change('el.className=`known ${on?"missing":"other"}`;\n'.repeat(20))],
    [{ base: map, head: map }],
  );
  assert.equal(nested.units.length, 20);
  assert.ok(nested.units.every((u) => u.status === 'unknown'));
  assert.deepEqual(nested.gaps, [], 'a known enclosing class value retains its existing evidence');
});

test('production calls only spread bounded arguments', () => {
  const bounded = new Set([
    'browser-preflight.ts:path.join', // Fixed executable path tuple.
    'describe.ts:mark', // Fixed property alias lists.
    'map-store/bundle.ts:path.join', // Filesystem path length bounds segment count.
    'report/regions.ts:cropNote', // Base and head image pair.
    'report/shared.ts:surfaceContext', // Base and head map pair.
  ]);
  const base = fileURLToPath(new URL('../src', import.meta.url)),
    pending = [base],
    unsafe = [];
  while (pending.length) {
    const dir = pending.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(name);
        continue;
      }
      if (!name.endsWith('.ts')) continue;
      const tree = ts.createSourceFile(name, fs.readFileSync(name, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node) => {
        if (
          ts.isCallExpression(node) &&
          node.arguments.some(ts.isSpreadElement) &&
          !bounded.has(`${path.relative(base, name)}:${node.expression.getText(tree)}`)
        )
          unsafe.push(path.relative(base, name));
        ts.forEachChild(node, visit);
      };
      visit(tree);
    }
  }
  assert.deepEqual(unsafe, []);
});

test(
  'four-megabyte template file classifies, assesses captured directories and writes a CLI report',
  { timeout: 120000 },
  async (t) => {
    const row = 'el.className=`btn ${on?"old":"new"}`;\n';
    const lines = Math.ceil((4 * 1024 * 1024) / row.length),
      source = row.repeat(lines);
    const root = mkTmp('class-report-large-');
    t.after(() => rmTmp(root));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.test');
    fs.writeFileSync(path.join(root, 'app.ts'), '// base\n');
    git('add', 'app.ts');
    git('commit', '-qm', 'fixture');
    const base = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, 'app.ts'), source);
    git('add', 'app.ts');
    git('commit', '-qm', 'fixture');
    const head = git('rev-parse', 'HEAD');
    const dirs = ['base', 'head'].map((side) => path.join(root, side));
    for (const [i, sha] of [base, head].entries()) {
      fs.mkdirSync(dirs[i]);
      saveStyleMap(path.join(dirs[i], 'home@1280.json.gz'), {
        ...map,
        scriptReach: { version: 1, window: 'navigation', status: 'measured', projectRootPrefix: '', scripts: [] },
      });
      stampCertifyingFixture(dirs[i], sha);
    }
    await t.test('classifyClassReach bounds unresolved detail before report assessment', () => {
      const result = classifyClassReach([map], [map], [change(source)], [{ base: map, head: map }]);
      assert.equal(result.gaps.length, 1);
      assert.equal(result.gaps[0].occurrenceCount, lines * 3);
      assert.equal(result.gaps[0].sampleRanges.length, 10);
    });
    await t.test('assessReachDirs succeeds at the default warn level', () => {
      const previous = process.cwd();
      try {
        process.chdir(root);
        const result = assessReachDirs(...dirs, 'warn');
        const gaps = result.gaps.filter((g) => g.join === 'J3' && g.occurrenceCount);
        assert.equal(gaps.length, 1);
        assert.equal(gaps[0].occurrenceCount, lines * 3);
        assert.equal(result.blocking, 0);
      } finally {
        process.chdir(previous);
      }
    });
    await t.test('styleproof-report exits zero and writes budgeted report artifacts', () => {
      const out = path.join(root, 'report');
      const child = spawnSyncToCompletion(
        process.execPath,
        [
          fileURLToPath(new URL('../bin/styleproof-report.mjs', import.meta.url)),
          ...dirs,
          '--out',
          out,
          '--expected-before-sha',
          base,
          '--expected-after-sha',
          head,
        ],
        { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 },
      );
      assert.equal(child.status, 0, child.stderr + child.stdout);
      const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
      assert.equal(report.reach.gaps.find((g) => g.occurrenceCount)?.occurrenceCount, lines * 3);
      assert.equal(report.reach.complete, false);
      assert.ok(
        ['report.json', 'report.md', 'report.html'].every((name) => fs.statSync(path.join(out, name)).size > 0),
      );
      assert.ok(
        ['report.json', 'report.md', 'report.html'].reduce(
          (n, name) => n + fs.statSync(path.join(out, name)).size,
          0,
        ) <= 2000000,
      );
      assert.ok(
        Buffer.byteLength(
          JSON.stringify({ classes: report.reach.classes, gaps: report.reach.gaps.filter((g) => g.join === 'J3') }),
        ) < 64000,
      );
    });
    t.diagnostic(JSON.stringify({ bytes: source.length, lines, unresolved: lines * 3 }));
  },
);

test('self-closing JSX does not swallow later class attributes', () => {
  const source = '<><A value={x} /><B className="known" /></>';
  const literals = classLiterals(source, 'app.tsx');
  assert.ok(literals.some((l) => l.explicit && l.words.some((w) => w.token === 'known')));
});

test('residual fragments aggregate by file side and reason', () => {
  const source = "el.className='known '+value;\n".repeat(12);
  const result = classifyClassReach([map], [map], [change(source)], [{ base: map, head: map }]);
  const residual = result.gaps.filter((g) => /fragment excluded/.test(g.reason));
  assert.equal(residual.length, 1);
  assert.equal(residual[0].occurrenceCount, 12);
});
