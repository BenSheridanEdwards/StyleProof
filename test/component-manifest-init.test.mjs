import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const init = path.join(here, '..', 'bin', 'styleproof-init.mjs');

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-manifest-init-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true }));
  for (const relative of ['src/components/Button.tsx', 'src/widgets/Card.tsx']) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, 'export default function Component() {}');
  }
  return root;
}

function run(root, ...args) {
  return spawnSync(
    process.execPath,
    [
      init,
      '--dir',
      'e2e/styleproof.spec.ts',
      '--manifest',
      'styleproof.components.json',
      '--component-roots',
      ' src/components, src/widgets ',
      ...args,
    ],
    { cwd: root, encoding: 'utf8' },
  );
}

test('styleproof-init scaffolds a validated component manifest without fabricating props', () => {
  const root = makeProject();
  try {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'styleproof.components.json'), 'utf8'));
    assert.equal(manifest.version, 1);
    assert.deepEqual(
      manifest.components.map((component) => component.module),
      ['src/components/Button.tsx', 'src/widgets/Card.tsx'],
    );
    for (const component of manifest.components) {
      assert.deepEqual(component.variants, [{ key: 'default' }]);
      assert.equal('props' in component.variants[0], false);
      assert.equal('provider' in component.variants[0], false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('styleproof-init leaves an existing manifest untouched unless --force is explicit', () => {
  const root = makeProject();
  try {
    const first = run(root);
    assert.equal(first.status, 0, first.stderr);
    const manifestPath = path.join(root, 'styleproof.components.json');
    fs.writeFileSync(manifestPath, '{"operator":"owned"}\n');

    const second = run(root);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), '{"operator":"owned"}\n');

    const forced = run(root, '--force');
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('styleproof-init requires --manifest and --component-roots together', () => {
  const root = makeProject();
  try {
    const manifestOnly = spawnSync(
      process.execPath,
      [init, '--dir', 'e2e/styleproof.spec.ts', '--manifest', 'styleproof.components.json'],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(manifestOnly.status, 2);
    assert.match(manifestOnly.stderr, /component-roots/i);

    const rootsOnly = spawnSync(
      process.execPath,
      [init, '--dir', 'e2e/styleproof.spec.ts', '--component-roots', 'src/components'],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(rootsOnly.status, 2);
    assert.match(rootsOnly.stderr, /manifest/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('styleproof-init reports invalid component roots as a clean usage error', () => {
  const root = makeProject();
  try {
    const result = spawnSync(
      process.execPath,
      [
        init,
        '--dir',
        'e2e/styleproof.spec.ts',
        '--manifest',
        'styleproof.components.json',
        '--component-roots',
        'src/nowhere',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^styleproof-init: /);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
    assert.equal(fs.existsSync(path.join(root, 'styleproof.components.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
