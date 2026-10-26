import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkAntiSlopVendor } from '../scripts/check-anti-slop-vendor.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const VENDOR = 'vendor/anti-slop';
const SOURCE = `${VENDOR}/rules/example.ts`;
const WHOLE = 'first\nsecond\nthird\n';
const PREFIX = 'first\n';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const write = (root, path, bytes) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
};

describe('anti-slop provenance', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'anti-slop-vendor-'));
    write(root, `${VENDOR}/UPSTREAM.sha256`, `${hash(WHOLE)}  ${SOURCE}\n`);
    write(root, `${VENDOR}/UPSTREAM.prefixes`, `${hash(PREFIX)}  1  ${SOURCE}\n`);
    write(root, `${VENDOR}/README.md`, 'Provenance metadata\n');
    write(root, SOURCE, WHOLE);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('passes whole files before and after wiring', () => {
    assert.deepEqual(checkAntiSlopVendor(root), []);
    write(root, '.oxlintrc.json', '{}');
    assert.deepEqual(checkAntiSlopVendor(root), []);
  });
  it('rejects altered bytes', () => {
    write(root, SOURCE, `${WHOLE}changed\n`);
    assert.deepEqual(checkAntiSlopVendor(root), [`${SOURCE}: hash mismatch`]);
  });
  for (const path of ['extra.ts', 'nested/README.md', 'nested/UPSTREAM.sha256', 'nested/UPSTREAM.prefixes']) {
    it(`rejects unlisted ${path} even with a declared prefix`, () => {
      write(root, `${VENDOR}/${path}`, PREFIX);
      write(root, `${VENDOR}/UPSTREAM.prefixes`, `${hash(PREFIX)}  1  ${VENDOR}/${path}\n`);
      assert.deepEqual(checkAntiSlopVendor(root), [`${VENDOR}/${path}: unlisted file`]);
    });
  }
  it('allows only declared prefixes before wiring, and none after wiring', () => {
    write(root, SOURCE, PREFIX);
    assert.deepEqual(checkAntiSlopVendor(root), []);
    write(root, SOURCE, 'first\nsecond\n');
    assert.deepEqual(checkAntiSlopVendor(root), [`${SOURCE}: hash mismatch`]);
    write(root, SOURCE, PREFIX);
    write(root, '.oxlintrc.json', '{}');
    assert.deepEqual(checkAntiSlopVendor(root), [`${SOURCE}: hash mismatch`]);
  });
  for (const [bytes, lines] of [
    [PREFIX, 2],
    ['first\nunfinished', 1],
    ['first', 1],
  ]) {
    it(`requires exactly ${lines} complete prefix lines in ${JSON.stringify(bytes)}`, () => {
      write(root, SOURCE, bytes);
      write(root, `${VENDOR}/UPSTREAM.prefixes`, `${hash(bytes)}  ${lines}  ${SOURCE}\n`);
      assert.deepEqual(checkAntiSlopVendor(root), [`${SOURCE}: hash mismatch`]);
    });
  }
  it('requires every listed file only after wiring', () => {
    rmSync(join(root, SOURCE));
    assert.deepEqual(checkAntiSlopVendor(root), []);
    write(root, '.oxlintrc.json', '{}');
    assert.deepEqual(checkAntiSlopVendor(root), [`${SOURCE}: missing file`]);
  });
  for (const directory of [false, true]) {
    it(`rejects a symlink to a ${directory ? 'directory' : 'file'}`, () => {
      write(root, 'outside/example.ts', WHOLE);
      rmSync(join(root, SOURCE));
      symlinkSync(join(root, directory ? 'outside' : 'outside/example.ts'), join(root, SOURCE));
      assert.deepEqual(checkAntiSlopVendor(root), [`${SOURCE}: expected regular file`]);
    });
  }
  for (const [name, count] of [
    ['UPSTREAM.sha256', ''],
    ['UPSTREAM.prefixes', '1  '],
  ]) {
    it(`rejects malformed ${name} entries with original line numbers`, () => {
      const paths = ['', '../escape.ts', './example.ts', 'rules//example.ts', 'rules/..', 'rules/.', 'rules/'];
      const entries = paths.map((path) => `${hash(WHOLE)}  ${count}${VENDOR}/${path}`);
      entries.push(`invalid  ${count}${SOURCE}`, `${hash(WHOLE)} ${count}${SOURCE}`);
      if (count) entries.push(...['0', '-1', '1.5'].map((n) => `${hash(PREFIX)}  ${n}  ${SOURCE}`));
      for (const entry of entries) {
        write(root, `${VENDOR}/${name}`, `\n${entry}\n`);
        assert.deepEqual(checkAntiSlopVendor(root), [`${VENDOR}/${name}:2: invalid manifest entry`]);
      }
    });
  }
  it('rejects identical and conflicting duplicate whole paths with line numbers', () => {
    for (const bytes of [WHOLE, 'wrong']) {
      const entries = `${hash(bytes)}  ${SOURCE}\n\n${hash(WHOLE)}  ${SOURCE}\n`;
      write(root, `${VENDOR}/UPSTREAM.sha256`, entries);
      assert.deepEqual(checkAntiSlopVendor(root), [`${VENDOR}/UPSTREAM.sha256:3: duplicate path`]);
    }
  });
  it('reports CLI success and exits 1 for file or manifest violations', () => {
    const run = () =>
      spawnSync(process.execPath, [join(REPO, 'scripts/check-anti-slop-vendor.mjs')], {
        cwd: root,
        encoding: 'utf8',
      });
    const success = run();
    assert.equal(success.status, 0);
    assert.match(success.stdout, /^OK:/);
    write(root, SOURCE, 'wrong');
    const mismatch = run();
    assert.equal(mismatch.status, 1);
    assert.ok(mismatch.stderr.includes(`${SOURCE}: hash mismatch`));
    write(root, `${VENDOR}/UPSTREAM.sha256`, 'malformed\n');
    const malformed = run();
    assert.equal(malformed.status, 1);
    assert.ok(malformed.stderr.includes('UPSTREAM.sha256:1: invalid manifest entry'));
  });
  it('checks the real repository tree', () => {
    assert.deepEqual(checkAntiSlopVendor(REPO), []);
  });
});
