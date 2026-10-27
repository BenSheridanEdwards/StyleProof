import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// `npm run lint:slop` gate (ADR 0010): Oxlint with the vendored anti-slop rules
// fails on a rule set to error and passes clean code. The samples are written to
// a temp dir so no tracked file holds slop for ESLint, Oxlint or fallow to find.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OXLINT = path.join(ROOT, 'node_modules', 'oxlint', 'bin', 'oxlint');

// Oxlint loads the vendored .ts plugin with Node's type stripping, which is on by
// default from Node 22.18. The 22.13.0 floor leg cannot load it; CI runs the gate on 22.
const skip = process.features.typescript ? false : 'this Node does not strip types, so Oxlint cannot load the plugin';

function lint(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-slop-'));

  try {
    const file = path.join(dir, 'sample.ts');
    fs.writeFileSync(file, source);

    const args = [OXLINT, '-c', path.join(ROOT, '.oxlintrc.json'), '--quiet', file];

    return spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('lint:slop fails on a rule set to error', { skip }, () => {
  const result = lint('export const call = (fn: () => void) => Reflect.apply(fn, undefined, []);\n');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /anti-slop\(no-reflect-apply\)/);
});

test('lint:slop passes clean code', { skip }, () => {
  const result = lint('export const call = (fn: () => void) => fn();\n');
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('lint:slop uses quiet mode', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts['lint:slop'], 'oxlint --quiet');
});

test('lint:slop passes when only a warning fires', { skip }, () => {
  const result = lint('export const get = (obj: object, key: string) => Reflect.get(obj, key);\n');
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
