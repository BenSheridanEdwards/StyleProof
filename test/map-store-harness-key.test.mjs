import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeMapManifest } from '../dist/map-store.js';

function checkScenario(t, scenario) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-harness-'));

  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const write = (file, content = 'export {};') => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), content);
  };

  const spec = scenario === 'root' ? 'root.spec.ts' : 'e2e/styleproof.spec.ts';

  write(spec);
  write('e2e/helper.ts');
  write('.gitignore', '*.json\n*.ignored\n');
  execFileSync('git', ['init', '--quiet', cwd]);
  execFileSync('git', ['add', '.'], { cwd });

  if (scenario === 'gitlink') {
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},e2e/submodule`], { cwd });
    fs.mkdirSync(path.join(cwd, 'e2e/submodule'));
  }

  const stamp = (side) =>
    writeMapManifest({
      cwd,
      dir: path.join(cwd, side),
      spec,
      sha: 'a'.repeat(40),
      dirty: false,
      screenshots: false,
      dirtyAllow: ['e2e/helper.ignored'],
    });

  const before = stamp('before');

  const changes = {
    deleted: () => fs.unlinkSync(path.join(cwd, 'e2e/helper.ts')),
    renamed: () => fs.renameSync(path.join(cwd, 'e2e/helper.ts'), path.join(cwd, 'e2e/renamed.ts')),
    config: () => write('playwright.styleproof.config.ts'),
    root: () => {
      write('e2e/head-only.ts');
      write('playwright.styleproof.config.ts');
    },
    ignored: () => write('e2e/capture.json', '{}'),
    overlay: () => write('e2e/helper.ignored'),
    nested: () => write('e2e/nested/head-only.ts'),
    helper: () => write('e2e/helper.ts', 'export const changed = true;'),
    gitlink: () => {},
  };

  changes[scenario]();
  const after = stamp('after');

  assert.equal(before.compatibilityKey, after.compatibilityKey);

  if (['ignored', 'gitlink'].includes(scenario)) assert.equal(before.harnessHash, after.harnessHash);
  else assert.notEqual(before.harnessHash, after.harnessHash);

  if (['config', 'root'].includes(scenario)) {
    write('playwright.styleproof.config.ts', 'export const changed = true;');
    const changed = stamp('changed');

    assert.notEqual(after.harnessHash, changed.harnessHash);
    assert.equal(after.compatibilityKey, changed.compatibilityKey);
  }
}

test('helper edits, paths and nested head-only files affect restore identity', (t) => {
  for (const scenario of ['helper', 'nested', 'renamed', 'deleted']) checkScenario(t, scenario);
});

test('first-adoption config changes restore identity without changing comparability', (t) =>
  checkScenario(t, 'config'));

test('root specs include the cwd config in restore identity', (t) => checkScenario(t, 'root'));

test('ignored capture output stays stable; explicit overlays affect restore identity', (t) => {
  for (const scenario of ['ignored', 'overlay']) checkScenario(t, scenario);
});

test('unreadable gitlink uses a stable errno marker', (t) => checkScenario(t, 'gitlink'));
