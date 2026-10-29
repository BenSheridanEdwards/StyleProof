// #1135: the map-store compatibility key must cover every harness file the spec-ref
// overlay can replace, not just the spec file.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expectedCompatibilityKey, writeMapManifest } from '../dist/map-store/manifest.js';

test('#1135 changing a harness helper beside the spec changes the compatibility key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-1135-'));

  try {
    fs.mkdirSync(path.join(dir, 'e2e'));
    fs.writeFileSync(path.join(dir, 'e2e/styleproof.spec.ts'), "import { surfaces } from './surfaces';\n");
    fs.writeFileSync(path.join(dir, 'e2e/surfaces.ts'), "export const surfaces = [{ name: 'home' }];\n");
    const before = expectedCompatibilityKey({ cwd: dir });
    fs.writeFileSync(path.join(dir, 'e2e/surfaces.ts'), "export const surfaces = [{ name: 'home', mask: ['.x'] }];\n");
    const after = expectedCompatibilityKey({ cwd: dir });
    assert.notEqual(after, before, 'harness change must change the key');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('harness paths, nested files and first-adoption config affect both publish and restore keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-harness-key-'));
  const spec = 'web/e2e/styleproof.spec.ts';
  const cwd = path.join(dir, 'web');

  try {
    fs.mkdirSync(path.join(dir, 'web/e2e/fixtures'), { recursive: true });
    const specBytes = 'export {};\n';
    fs.writeFileSync(path.join(dir, spec), specBytes);
    const key = () => expectedCompatibilityKey({ cwd, spec: 'e2e/styleproof.spec.ts' });
    const initial = key();
    fs.writeFileSync(path.join(cwd, 'application.ts'), 'export const version = 2;\n');
    fs.writeFileSync(path.join(dir, 'playwright.styleproof.config.ts'), 'export default {};\n');
    assert.equal(key(), initial, 'files outside the cwd-relative harness do not affect the key');

    const fixture = path.join(cwd, 'e2e/fixtures/empty.txt');
    fs.writeFileSync(fixture, '');
    const added = key();
    assert.notEqual(added, initial, 'even an empty nested file changes the key');
    fs.renameSync(fixture, `${fixture}.renamed`);
    assert.notEqual(key(), added, 'paths are part of the harness contract');
    fs.rmSync(`${fixture}.renamed`);
    assert.equal(key(), initial, 'deleting the added file restores the original key');

    const config = path.join(cwd, 'playwright.styleproof.config.ts');
    fs.writeFileSync(config, 'export default {};\n');
    const adopted = key();
    assert.notEqual(adopted, initial, 'first-adoption config participates');
    fs.writeFileSync(config, 'export default { timeout: 1000 };\n');
    assert.notEqual(key(), adopted, 'config edits participate');

    const manifest = writeMapManifest({
      cwd,
      dir: path.join(dir, 'capture'),
      spec: 'e2e/styleproof.spec.ts',
      sha: 'a'.repeat(40),
      dirty: false,
      screenshots: false,
    });

    assert.equal(manifest.specHash, createHash('sha256').update(specBytes).digest('hex'));
    assert.equal(manifest.compatibilityKey, key(), 'publication and dependency-free restore agree');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a root-level spec does not own every file in the project', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-root-harness-'));

  try {
    fs.writeFileSync(path.join(dir, 'styleproof.spec.ts'), 'export {};\n');
    const options = { cwd: dir, spec: 'styleproof.spec.ts' };
    const initial = expectedCompatibilityKey(options);
    fs.writeFileSync(path.join(dir, 'application.ts'), 'export {};\n');
    assert.equal(expectedCompatibilityKey(options), initial);
    fs.writeFileSync(path.join(dir, 'styleproof.spec.ts'), 'export const changed = true;\n');
    assert.notEqual(expectedCompatibilityKey(options), initial);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('git-ignored capture outputs leave keys stable while head-only helpers change them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-harness-ignored-'));
  const cwd = path.join(dir, 'web');

  try {
    execFileSync('git', ['init', '--quiet', dir]);
    fs.mkdirSync(path.join(cwd, 'e2e'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.gitignore'), 'web/e2e/__stylemaps__/\n*.log\n');
    fs.writeFileSync(path.join(cwd, 'e2e/styleproof.spec.ts'), 'export {};\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    const key = () => expectedCompatibilityKey({ cwd });
    const initial = key();
    const generated = path.join(cwd, 'e2e/__stylemaps__/home.json');
    const log = path.join(cwd, 'e2e/capture.log');
    fs.mkdirSync(path.dirname(generated));
    fs.writeFileSync(generated, '{}');
    fs.writeFileSync(log, 'capture started\n');
    assert.equal(key(), initial, 'creating ignored outputs must not invalidate restore');
    fs.writeFileSync(generated, '{"captured":true}');
    fs.writeFileSync(log, 'capture finished\n');
    assert.equal(key(), initial, 'changing ignored outputs must not invalidate restore');

    const helper = path.join(cwd, 'e2e/head-only.ts');
    fs.writeFileSync(helper, 'export const surfaces = [];\n');
    const added = key();
    assert.notEqual(added, initial, 'untracked overlay helpers participate');
    fs.writeFileSync(helper, 'export const surfaces = ["home"];\n');
    assert.notEqual(key(), added, 'checkout bytes of untracked helpers participate');

    execFileSync('git', ['add', 'e2e/head-only.ts'], { cwd });
    const tracked = key();
    fs.rmSync(helper);
    const missing = key();
    assert.notEqual(missing, tracked, 'deleted tracked helpers get a missing sentinel');
    execFileSync('git', ['rm', '--cached', '--quiet', 'e2e/head-only.ts'], { cwd });
    assert.equal(key(), initial, 'removing the index entry removes the missing sentinel');

    fs.symlinkSync('missing-target', helper);
    const linked = key();
    fs.unlinkSync(helper);
    fs.symlinkSync('another-missing-target', helper);
    assert.notEqual(key(), linked, 'symlink targets are hashed without following them');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const useGit of [false, true]) {
  test(`retargeting a harness directory symlink hashes content (git: ${useGit})`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-harness-link-'));

    try {
      if (useGit) execFileSync('git', ['init', '--quiet', dir]);

      for (const suite of ['suite-a', 'suite-b']) {
        const target = path.join(dir, suite);
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'styleproof.spec.ts'), 'export {};\n');
        fs.writeFileSync(path.join(target, 'helper.ts'), 'export const value = 1;\n');
        fs.symlinkSync('helper.ts', path.join(target, 'linked.ts'));
        fs.symlinkSync('.', path.join(target, 'directory-link'));
      }

      const link = path.join(dir, 'e2e');
      fs.symlinkSync('suite-a', link);

      if (useGit) execFileSync('git', ['add', '.'], { cwd: dir });
      const key = () => expectedCompatibilityKey({ cwd: dir });
      const initial = key();
      fs.unlinkSync(link);
      fs.symlinkSync('suite-b', link);
      assert.equal(key(), initial, 'directory link spelling does not change harness content');
      fs.writeFileSync(path.join(link, 'helper.ts'), 'export const value = 2;\n');
      assert.notEqual(key(), initial, 'helper bytes in the resolved harness change the key');
      fs.writeFileSync(path.join(link, 'helper.ts'), 'export const value = 1;\n');
      fs.writeFileSync(path.join(dir, 'suite-b/copy.ts'), 'export const value = 1;\n');
      const withCopy = key();
      fs.unlinkSync(path.join(link, 'linked.ts'));
      fs.symlinkSync('copy.ts', path.join(link, 'linked.ts'));
      assert.equal(key(), withCopy, 'file links hash target bytes rather than target spelling');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
