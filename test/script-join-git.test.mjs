import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { readScriptChanges } from '../dist/script-join-git.js';
import { stampCertifyingFixture } from './certifying-fixture.mjs';

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'script-join-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  const projectRoot = path.join(cwd, 'packages', 'app');
  fs.mkdirSync(projectRoot, { recursive: true });
  const write = (name, text) => fs.writeFileSync(path.join(projectRoot, name), text);

  const commit = () => {
    git('add', '.');
    git('commit', '-qm', 'fixture');

    return git('rev-parse', 'HEAD');
  };

  const beforeDir = path.join(cwd, 'before');
  const afterDir = path.join(cwd, 'after');

  const stamp = (base, head) => {
    fs.mkdirSync(beforeDir, { recursive: true });
    fs.mkdirSync(afterDir, { recursive: true });
    stampCertifyingFixture(beforeDir, base);
    stampCertifyingFixture(afterDir, head);
  };

  return { cwd, projectRoot, write, commit, beforeDir, afterDir, stamp };
}

test('git joins use the actual ancestor map SHA and preserve config-relative paths on both sides', (t) => {
  const f = fixture(t);
  f.write('app.ts', 'const x = a ?? b;\n');
  const ancestor = f.commit();
  f.write('other.ts', 'export const value = 1;\n');
  f.commit();
  f.write('app.ts', 'const x = c ?? b;\n');
  const head = f.commit();
  f.stamp(ancestor, head);
  const result = readScriptChanges(f.beforeDir, f.afterDir, f);
  assert.deepEqual(result.gaps, []);
  assert.ok(
    result.changes.some((change) => change.sourceKey === 'other.ts'),
    'diff starts from the stored ancestor',
  );
  const changes = result.changes.filter((change) => change.sourceKey === 'app.ts');
  assert.deepEqual(
    changes.map((change) => [change.side, change.range.start.column, change.range.end.column]),
    [
      ['base', 10, 11],
      ['head', 10, 11],
    ],
  );
  assert.ok(changes.every((change) => change.contentHash.length === 64));
});

test('changed string values include their mapping anchor without widening to an unrelated fallback', (t) => {
  const f = fixture(t);
  f.write('app.ts', "const x = 'old' ?? fallback;\n");
  const base = f.commit();
  f.write('app.ts', "const x = 'new' ?? fallback;\n");
  const head = f.commit();
  f.stamp(base, head);
  const { changes } = readScriptChanges(f.beforeDir, f.afterDir, f);
  assert.deepEqual(
    changes.map((change) => [change.range.start.column, change.range.end.column]),
    [
      [10, 15],
      [10, 15],
    ],
  );
});

test('missing manifests and unavailable git produce named run gaps instead of an empty success', (t) => {
  const f = fixture(t);
  assert.match(readScriptChanges(f.beforeDir, f.afterDir, f).gaps[0].reason, /base.*SHA/);
  f.write('app.ts', 'const x = 1;\n');
  const sha = f.commit();
  f.stamp(sha, sha);
  const result = readScriptChanges(f.beforeDir, f.afterDir, { cwd: path.dirname(f.cwd), projectRoot: f.projectRoot });
  assert.match(result.gaps[0].reason, /git.*unavailable/);
  assert.equal(result.changes.length, 0);
});

test('git paths with whitespace and renames retain source identities and numeric line ordering', (t) => {
  const f = fixture(t);
  f.write('old name.ts', 'const x = 1;\n');
  const base = f.commit();
  fs.renameSync(path.join(f.projectRoot, 'old name.ts'), path.join(f.projectRoot, 'new name.ts'));
  const head = f.commit();
  f.stamp(base, head);
  const { changes, gaps } = readScriptChanges(f.beforeDir, f.afterDir, f);
  assert.deepEqual(gaps, []);
  assert.deepEqual(
    changes.map((change) => [change.sourceKey, change.side]),
    [
      ['new name.ts', 'head'],
      ['old name.ts', 'base'],
    ],
  );
});

test('reports retain J2 source ranges and grouped reasons in JSON, Markdown and HTML without holding gate', async (t) => {
  const { generateStyleMapReport } = await import('../dist/report.js');
  const { makeMap, writeCapture } = await import('./helpers.mjs');
  const { sha256 } = await import('../dist/node-util.js');
  const f = fixture(t);
  f.write('styleproof.config.json', '{}');
  f.write('app.ts', 'const x = a ?? b;\n');
  const base = f.commit();
  f.write('app.ts', 'const x = c ?? b;\n');
  const head = f.commit();
  f.stamp(base, head);

  for (const [dir, text] of [
    [f.beforeDir, 'const x = a ?? b;\n'],
    [f.afterDir, 'const x = c ?? b;\n'],
  ]) {
    const map = makeMap();
    map.reach = { version: 2, scope: 'compared', sheets: [], rules: [] };
    map.scriptReach = {
      version: 1,
      window: 'navigation',
      status: 'measured',
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
              executed: [[1, 10, 10]],
              unexecuted: [[1, 15, 16]],
              mixed: [],
            },
          ],
        },
      ],
    };
    writeCapture(dir, 'home@1280', map, null);
  }

  const previous = process.cwd();
  process.chdir(f.projectRoot);

  try {
    for (const changeReach of ['warn', 'gate']) {
      const result = generateStyleMapReport({
        beforeDir: f.beforeDir,
        afterDir: f.afterDir,
        outDir: path.join(f.cwd, 'report'),
        changeReach,
      });

      const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
      assert.equal(json.reach.blocking, 0);
      assert.equal(json.reach.complete, false);
      assert.deepEqual(
        json.reach.scripts.map((unit) => [unit.sourceKey, unit.side, unit.execution, unit.status, unit.level]),
        [
          ['app.ts', 'base', 'ran', 'unknown', 'warn'],
          ['app.ts', 'head', 'ran', 'unknown', 'warn'],
        ],
      );
      assert.equal(json.reach.gaps.filter((gap) => gap.join === 'J2').length, 0);
      const md = fs.readFileSync(result.reportMdPath, 'utf8');
      const html = fs.readFileSync(path.join(f.cwd, 'report/report.html'), 'utf8');
      assert.match(md, /\*\*unknown\*\*/);
      assert.match(md, /app.ts:1:10-1:11/);
      assert.match(md, /value; rendering not proved/);
      assert.match(html, /Script change reach \(J2\)/);
      assert.match(html, /app.ts:1:10-1:11/);
      assert.doesNotMatch(md, /Reach complete/);
    }
  } finally {
    process.chdir(previous);
  }
});

test('git blob hashes retain original bytes rather than hashing a lossy UTF-8 decode', async (t) => {
  const { sha256 } = await import('../dist/node-util.js');
  const f = fixture(t);
  const bytes = Buffer.from([47, 47, 32, 255, 10]);
  f.write('app.ts', bytes);
  const base = f.commit();
  f.write('app.ts', Buffer.from([47, 47, 32, 254, 10]));
  const head = f.commit();
  f.stamp(base, head);
  const result = readScriptChanges(f.beforeDir, f.afterDir, f);
  assert.equal(result.changes.find((change) => change.side === 'base').contentHash, sha256(bytes));
});
