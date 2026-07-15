import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkTmp, rmTmp } from './helpers.mjs';

// The CLI over affectedSurfaces — the packaged form of the selective-remap recipe
// (see selective-remap-recipe.test.mjs for the library-level proof). These tests
// drive the same committed dependency-cruiser fixture through the binary, so the
// CLI's input assembly (surface map, graph mapping, git diff) is what's on trial,
// not the graph logic itself.

const here = path.dirname(fileURLToPath(import.meta.url));
const AFFECTED = path.join(here, '..', 'bin', 'styleproof-affected.mjs');
const FIXTURE = path.join(here, 'fixtures', 'selective-remap');
const GRAPH = path.join(FIXTURE, 'graph.depcruise.json');

const SURFACES = {
  home: 'src/pages/Home.tsx',
  pricing: 'src/pages/Pricing.tsx',
  dashboard: 'src/pages/Dashboard.tsx',
};

function run(args, cwd = FIXTURE) {
  return spawnSync(process.execPath, [AFFECTED, ...args], { cwd, encoding: 'utf8' });
}

function withSurfacesFile(fn) {
  const dir = mkTmp('styleproof-affected-');
  try {
    const file = path.join(dir, 'surfaces.json');
    fs.writeFileSync(file, JSON.stringify(SURFACES));
    return fn(file);
  } finally {
    rmTmp(dir);
  }
}

test('styleproof-affected: a scoped change exits 0 and names re-capture vs reuse', () => {
  withSurfacesFile((surfaces) => {
    const res = run([
      '--graph',
      GRAPH,
      '--surfaces',
      surfaces,
      '--changed',
      'src/components/Chart.module.css',
      '--json',
    ]);
    assert.equal(res.status, 0, res.stderr);
    const verdict = JSON.parse(res.stdout);
    assert.equal(verdict.verdict, 'scoped');
    assert.deepEqual(verdict.recapture, ['dashboard']);
    assert.deepEqual(verdict.reuse, ['home', 'pricing']);
    assert.match(res.stderr, /↻ dashboard \(re-capture/);
    assert.match(res.stderr, /✓ home \(reuse base map/);
  });
});

test('styleproof-affected: a token/global change exits 3 (unbounded → re-capture all) with a reason', () => {
  withSurfacesFile((surfaces) => {
    const res = run(['--graph', GRAPH, '--surfaces', surfaces, '--changed', 'src/tokens.css', '--json']);
    assert.equal(res.status, 3, res.stderr);
    const verdict = JSON.parse(res.stdout);
    assert.equal(verdict.verdict, 'all');
    assert.deepEqual(verdict.recapture, ['dashboard', 'home', 'pricing']);
    assert.deepEqual(verdict.reuse, []);
    assert.match(verdict.reason, /src\/tokens\.css/);
    assert.match(res.stderr, /selective remap: OFF/);
  });
});

test('styleproof-affected: inline --surface entries work without a surfaces file', () => {
  const res = run([
    '--graph',
    GRAPH,
    ...Object.entries(SURFACES).flatMap(([k, p]) => ['--surface', `${k}=${p}`]),
    '--changed',
    'src/components/Hero.tsx',
  ]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /↻ home \(re-capture/); // Hero is imported only by Home
  assert.match(res.stdout, /✓ pricing \(reuse base map/);
});

test('styleproof-affected: --base derives the changed files from git (merge-base diff)', () => {
  const repo = mkTmp('styleproof-affected-git-');
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  try {
    fs.cpSync(FIXTURE, repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'surfaces.json'), JSON.stringify(SURFACES));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'a@b.c');
    git('config', 'user.name', 'test');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    fs.appendFileSync(path.join(repo, 'src/components/Chart.module.css'), '.chart{margin:1px}\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'restyle chart');

    const res = run(
      ['--graph', 'graph.depcruise.json', '--surfaces', 'surfaces.json', '--base', 'main~1', '--json'],
      repo,
    );
    assert.equal(res.status, 0, res.stderr);
    const verdict = JSON.parse(res.stdout);
    assert.deepEqual(verdict.changed, ['src/components/Chart.module.css']);
    assert.deepEqual(verdict.recapture, ['dashboard']);
  } finally {
    rmTmp(repo);
  }
});

test('styleproof-affected: usage errors exit 2 and never fake a verdict', () => {
  assert.equal(run([]).status, 2);
  assert.equal(run(['--graph', GRAPH, '--changed', 'src/tokens.css']).status, 2, 'no surfaces');
  assert.equal(run(['--graph', GRAPH, '--surface', 'home=src/pages/Home.tsx']).status, 2, 'no change source');
  const badGraph = run(['--graph', 'nope.json', '--surface', 'home=src/pages/Home.tsx', '--changed', 'x']);
  assert.equal(badGraph.status, 2);
  assert.match(badGraph.stderr, /could not read/);
  const badRef = run(['--graph', GRAPH, '--surface', 'home=src/pages/Home.tsx', '--base', 'no-such-ref']);
  assert.equal(badRef.status, 2);
});
