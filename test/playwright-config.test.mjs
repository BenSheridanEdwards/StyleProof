// Regression coverage for playwright.config.ts test collection.
//
// The config must ignore a nested agent-worktree checkout under .claude/ when
// the suite runs from the canonical repo root (otherwise every spec collects
// twice), and it must STILL collect specs when the suite runs from inside such
// a checkout (a path-wide '**/.claude/**' ignore matched every spec's absolute
// path there and silently collected 0 tests — see the fix this file ships with).
//
// Both directions are exercised against a throwaway checkout layout in a temp
// dir: a fake repo root holding a copy of the real config, one spec, and a
// nested .claude/worktrees/agent checkout holding the same. `playwright test
// --list` only collects — no browsers launch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkTmp, rmTmp } from './helpers.mjs';

const require = createRequire(import.meta.url);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Resolve playwright through node's walk-up so this also works from a worktree
// checkout that has no node_modules of its own.
const nodeModules = path.resolve(require.resolve('@playwright/test/package.json'), '..', '..', '..');
// 'playwright/cli' is not an exported subpath, so address the file directly.
const playwrightCli = path.join(nodeModules, 'playwright', 'cli.js');

const SPEC = "import { test } from '@playwright/test';\ntest('collected', () => {});\n";

/** Lay down a config + one e2e spec at `dir`, resolving deps via a node_modules symlink. */
function writeCheckout(dir) {
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'playwright.config.ts'), path.join(dir, 'playwright.config.ts'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'pwconfig-fixture', private: true, type: 'module' }),
  );
  fs.writeFileSync(path.join(dir, 'test', 'collect.e2e.spec.ts'), SPEC);
  fs.symlinkSync(nodeModules, path.join(dir, 'node_modules'), 'junction');
}

function listTests(cwd) {
  const res = spawnSync(process.execPath, [playwrightCli, 'test', '--list'], {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return `${res.stdout}\n${res.stderr}`;
}

test('playwright config collects specs from the repo root but not from a nested .claude checkout', async (t) => {
  const fakeRoot = mkTmp('styleproof-pwconfig-');
  t.after(() => rmTmp(fakeRoot));

  writeCheckout(fakeRoot);
  writeCheckout(path.join(fakeRoot, '.claude', 'worktrees', 'agent'));

  const output = listTests(fakeRoot);
  // Exactly the root's own spec — the nested checkout's copy must not double it.
  assert.match(output, /Total: 1 test in 1 file/, `root run should collect 1 test, got:\n${output}`);
});

test('playwright config still collects specs when run from inside a .claude worktree checkout', async (t) => {
  const fakeRoot = mkTmp('styleproof-pwconfig-');
  t.after(() => rmTmp(fakeRoot));

  const worktree = path.join(fakeRoot, '.claude', 'worktrees', 'agent');
  writeCheckout(fakeRoot);
  writeCheckout(worktree);

  const output = listTests(worktree);
  // The unfixed '**/.claude/**' ignore matched every spec's absolute path here
  // and reported "Total: 0 tests" — e2e silently could not run in worktrees.
  assert.match(output, /Total: 1 test in 1 file/, `worktree run should collect 1 test, got:\n${output}`);
});
