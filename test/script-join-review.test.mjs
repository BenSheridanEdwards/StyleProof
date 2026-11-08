import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { changedScriptRanges, readScriptChanges } from '../dist/script-join-git.js';
import { reachSectionLines, assessReachMaps } from '../dist/report/reach.js';
import { stampCertifyingFixture } from './certifying-fixture.mjs';

const evidence = (prefix = '', sourceKey = 'app.ts') => ({
  scriptReach: {
    version: 1,
    window: 'navigation',
    status: 'measured',
    projectRootPrefix: prefix,
    scripts: [
      {
        url: '/app.js',
        status: 'mapped',
        files: [
          {
            source: sourceKey,
            sourceKey,
            contentHash: 'hash',
            encoding: 'line-column-tuples',
            executed: [],
            mixed: [],
            unexecuted: [],
          },
        ],
      },
    ],
  },
});

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'join-review-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');

  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), text);
  };

  const commit = () => {
    git('add', '.');
    git('commit', '-qm', 'fixture');

    return git('rev-parse', 'HEAD');
  };

  const dirs = { beforeDir: path.join(cwd, 'base'), afterDir: path.join(cwd, 'head') };

  const stamp = (base, head) => {
    for (const [dir, sha] of [
      [dirs.beforeDir, base],
      [dirs.afterDir, head],
    ]) {
      fs.mkdirSync(dir);
      stampCertifyingFixture(dir, sha);
    }
  };

  const read = (baseMaps = [evidence()], headMaps = [evidence()], extra = {}) =>
    readScriptChanges(dirs.beforeDir, dirs.afterDir, { cwd, baseMaps, headMaps, ...extra });

  return { cwd, git, write, commit, stamp, read };
}

test('unloaded MDX, template, extensionless and gitlink paths remain named J2 gaps', (t) => {
  const f = fixture(t);
  f.write('app.ts', 'const x = 1;\n');
  const base = f.commit();

  for (const file of ['z.mdx', 'widget.gjs', 'view.html', 'render']) f.write(file, 'value\n');
  const head = f.commit();
  f.stamp(base, head);
  const result = f.read();
  const gap = result.gaps.find((gap) => gap.reason.startsWith('changed files J2 does not judge:'));
  assert.deepEqual(gap.paths, ['render', 'view.html', 'widget.gjs', 'z.mdx']);
  assert.equal(gap.pathCount, 4);
  assert.match(gap.reason, /4 path\(s\); first: render, view.html, widget.gjs/);
});

test('git line three maps to JavaScript line four after an earlier Unicode line separator', () => {
  for (const separator of ['\u2028', '\u2029', '\r']) {
    const texts = {
      base: `const text = 'x${separator}y';\nconst unchanged = 1;\nconst oldValue = 1;\n`,
      head: `const text = 'x${separator}y';\nconst unchanged = 1;\nconst oldValue = 2;\n`,
    };

    const units = changedScriptRanges('@@ -3 +3 @@\n-const oldValue = 1;\n+const oldValue = 2;\n', texts, 'app.ts');
    assert.ok(units.every((unit) => unit.range.start.line === 4));
    assert.ok(units.every((unit) => unit.text.includes('const oldValue')));
  }
});

test('unrelated hunks retain line scope and empty token sides retain a touching token', () => {
  const units = changedScriptRanges(
    '@@ -1,2 +1,2 @@\n-const oldName = 1;\n-oldFunction();\n+const newName = 2;\n+newFunction();\n',
    { base: 'const oldName = 1;\noldFunction();\n', head: 'const newName = 2;\nnewFunction();\n' },
    'app.ts',
  );

  assert.ok(units.every((unit) => unit.range.start.column === 0));

  const inserted = changedScriptRanges(
    '@@ -1 +1 @@\n-window.result = a;\n+window.result = a ?? b;\n',
    { base: 'window.result = a;', head: 'window.result = a ?? b;' },
    'app.ts',
  );

  assert.equal(inserted.length, 2);
  assert.equal(inserted[0].side, 'base');
  assert.equal(inserted[0].changeScope, undefined);
  assert.deepEqual(inserted[0].range, { start: { line: 1, column: 16 }, end: { line: 1, column: 17 } });
  assert.equal(inserted[1].side, 'head');
});

test('capture root prefixes bind source keys independently of the report working directory', (t) => {
  const f = fixture(t);
  f.write('packages/app/app.ts', 'const x = 1;\n');
  const base = f.commit();
  f.write('packages/app/app.ts', 'const x = 2;\n');
  const head = f.commit();
  f.stamp(base, head);
  const result = f.read([evidence('packages/app')], [evidence('packages/app')]);
  assert.equal(result.changes.length, 2);
  assert.ok(result.changes.every((change) => change.sourceKey === 'app.ts'));
  const mismatch = f.read([evidence('other')], [evidence('other')]);
  assert.match(mismatch.gaps.map((gap) => gap.reason).join('\n'), /captured source keys.*no changed path/);
});

test('without scriptReach there is no manifest or git work and J1 opt-in behavior is preserved', () => {
  const result = readScriptChanges('missing-base', 'missing-head', {
    cwd: 'missing-cwd',
    baseMaps: [{}],
    headMaps: [{}],
  });

  assert.deepEqual(result, { changes: [], gaps: [] });
  assert.equal(assessReachMaps([{}], [{}], 'warn'), undefined);
  assert.ok(assessReachMaps([evidence()], [evidence()], 'warn'));
});

test('three thousand adjacent findings render as ranges and a long fragmented table is capped', () => {
  const unit = (line, why = 'value; rendering not proved') => ({
    sourceKey: 'app.ts',
    side: 'head',
    changeScope: 'line',
    range: { start: { line, column: 0 }, end: { line, column: 20 } },
    execution: 'ran',
    status: 'unknown',
    why,
    level: 'warn',
  });

  const reach = { level: 'warn', rules: [], gaps: [], scripts: Array.from({ length: 3000 }, (_, i) => unit(i + 1)) };
  const lines = reachSectionLines(reach);
  assert.ok(lines.filter((line) => line.startsWith('| `app.ts')).length <= 2);

  const fragmented = reachSectionLines({
    ...reach,
    scripts: reach.scripts.map((entry, i) => ({ ...entry, why: String(i) })),
  }).join('\n');

  assert.match(fragmented, /\+\d+ more/);
  assert.ok(fragmented.split('\n').filter((line) => line.startsWith('| `app.ts')).length <= 100);
});

test('git uses one all-path diff and one blob batch, retaining healthy files after a missing blob', (t) => {
  const f = fixture(t);
  f.write('app.ts', 'const root = 1;\n');
  f.write('broken.ts', 'const broken = 1;\n');

  for (let i = 0; i < 40; i++) f.write(`file-${i}.ts`, 'const value = 1;\n');
  const base = f.commit();
  const missing = f.git('rev-parse', `${base}:broken.ts`);
  f.write('app.ts', 'const root = 2;\n');
  f.write('broken.ts', 'const broken = 2;\n');

  for (let i = 0; i < 40; i++) f.write(`file-${i}.ts`, 'const value = 2;\n');
  const head = f.commit();
  f.stamp(base, head);
  const bin = path.join(f.cwd, 'tools');
  fs.mkdirSync(bin);
  const log = path.join(f.cwd, 'git-calls.jsonl');

  const realGit = process.env.PATH.split(path.delimiter)
    .map((dir) => path.join(dir, 'git'))
    .find((file) => fs.existsSync(file));

  fs.writeFileSync(
    path.join(bin, 'git'),
    `#!${process.execPath}\nconst fs = require('node:fs'); const {spawnSync} = require('node:child_process'); const args = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n'); const input = args.includes('--batch') ? fs.readFileSync(0) : undefined; const r = spawnSync(${JSON.stringify(realGit)}, args, {input}); let out = r.stdout; if(args.includes('--batch')) {const chunks=[];let p=0;while(p<out.length){const e=out.indexOf(10,p);const h=out.subarray(p,e).toString().split(' ');const end=e+1+Number(h[2])+1;chunks.push(h[0]===${JSON.stringify(missing)}?Buffer.from(h[0]+' missing\\n'):out.subarray(p,end));p=end;}out=Buffer.concat(chunks);} process.stdout.write(out); process.stderr.write(r.stderr); process.exit(r.status ?? 1);\n`,
    { mode: 0o755 },
  );
  const previous = process.env.PATH;
  process.env.PATH = bin + path.delimiter + previous;
  let result;

  try {
    result = f.read();
  } finally {
    process.env.PATH = previous;
  }

  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter((args) => args.includes('diff')).length, 1);
  assert.equal(calls.filter((args) => args[0] === 'cat-file' && args.includes('--batch')).length, 1);
  assert.ok(calls.length <= 3, 'git process count must not grow with changed-file count');
  assert.ok(result.changes.some((change) => change.sourceKey === 'file-39.ts'));
  assert.match(result.gaps.map((gap) => gap.reason).join('\n'), /broken.ts.*blob/);
});

test('submodule bumps remain named even with no text source that J2 can judge', (t) => {
  const f = fixture(t);
  f.write('app.ts', 'const x = 1;\n');
  const initial = f.commit();
  f.git('update-index', '--add', '--cacheinfo', `160000,${initial},linked.ts`);
  f.git('commit', '-qm', 'fixture');
  const base = f.git('rev-parse', 'HEAD');
  f.git('update-index', '--cacheinfo', `160000,${base},linked.ts`);
  f.git('commit', '-qm', 'fixture');
  const head = f.git('rev-parse', 'HEAD');
  f.stamp(base, head);
  const result = f.read();
  assert.equal(result.changes.length, 0);
  assert.ok(result.gaps.some((gap) => gap.paths?.includes('linked.ts')));
});

test('unjudged path lists sort Unicode scalar values rather than locale or UTF-16 order', (t) => {
  const f = fixture(t);
  f.write('app.ts', 'const x = 1;\n');
  const base = f.commit();
  f.write('\u{10000}.mdx', 'value');
  f.write('\ue000.mdx', 'value');
  const head = f.commit();
  f.stamp(base, head);
  assert.deepEqual(f.read().gaps.find((gap) => gap.paths)?.paths, ['\ue000.mdx', '\u{10000}.mdx']);
});
