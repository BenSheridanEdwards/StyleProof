import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'bin', 'styleproof-components.mjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-components-cli-'));
  const components = path.join(root, 'src', 'components');
  fs.mkdirSync(components, { recursive: true });
  fs.writeFileSync(path.join(components, 'Button.tsx'), 'export function Button() {}');
  fs.writeFileSync(path.join(components, 'Card.tsx'), 'export function Card() {}');
  fs.writeFileSync(
    path.join(root, 'styleproof.components.json'),
    JSON.stringify({
      version: 1,
      components: [
        {
          module: 'src/components/Button.tsx',
          export: 'Button',
          variants: [{ key: 'default' }],
        },
      ],
    }),
  );
  return root;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
}

test('styleproof-components prints exact JSON inventory and exits 1 for uncovered files', () => {
  const root = fixture();
  try {
    const result = run(root, '--manifest', 'styleproof.components.json', '--component-root', 'src/components');
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(
      output.declared.map((entry) => entry.path),
      ['src/components/Button.tsx'],
    );
    assert.deepEqual(output.excludedWithReason, []);
    assert.deepEqual(output.uncovered, ['src/components/Card.tsx']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('styleproof-components --uncovered-ok exits 0 without hiding uncovered files', () => {
  const root = fixture();
  try {
    const result = run(
      root,
      '--manifest=styleproof.components.json',
      '--component-root=src/components',
      '--uncovered-ok',
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).uncovered, ['src/components/Card.tsx']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('styleproof-components fails with usage exit 2 for missing inputs and unknown flags', () => {
  const root = fixture();
  try {
    assert.equal(run(root, '--component-root', 'src/components').status, 2);
    assert.equal(run(root, '--manifest', 'styleproof.components.json').status, 2);
    assert.equal(run(root, '--wat').status, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('styleproof-components --help documents the fail-closed default', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /usage: styleproof-components/);
  assert.match(result.stdout, /exit 1.*uncovered/i);
});
