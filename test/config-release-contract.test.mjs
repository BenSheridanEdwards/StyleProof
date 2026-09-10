import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { mkNonGitTmp, rmTmp } from './helpers.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const moduleNames = ['styleproof.config.ts', 'styleproof.config.mjs', 'styleproof.config.js'];

function runMap(root) {
  return spawnSync(process.execPath, [path.join(repo, 'bin/styleproof-map.mjs'), '--no-upload'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15000,
  });
}

test('real map CLI keeps the custom spec from static JSON', () => {
  const root = mkNonGitTmp('static-config-cli-');
  try {
    fs.writeFileSync(path.join(root, 'styleproof.config.json'), JSON.stringify({ spec: 'custom-proof.spec.ts' }));
    const result = runMap(root);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /no StyleProof spec at custom-proof\.spec\.ts/);
    assert.doesNotMatch(result.stderr, /deprecated/);
  } finally {
    rmTmp(root);
  }
});

test('real map CLI rejects malformed JSON before selecting a default spec', () => {
  const root = mkNonGitTmp('malformed-config-cli-');
  try {
    fs.writeFileSync(path.join(root, 'styleproof.config.json'), '{');
    const result = runMap(root);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /invalid JSON/);
    assert.doesNotMatch(result.stderr, /no StyleProof spec/);
  } finally {
    rmTmp(root);
  }
});

for (const filename of moduleNames) {
  for (const withJson of [false, true]) {
    test(`real map CLI rejects ${filename}${withJson ? ' alongside JSON' : ''} without executing it`, () => {
      const root = mkNonGitTmp('unsupported-config-cli-');
      try {
        const sentinel = path.join(root, 'executed.txt');
        fs.writeFileSync(
          path.join(root, filename),
          `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(sentinel)}, 'executed');\nexport default {};\n`,
        );
        if (withJson) {
          fs.writeFileSync(path.join(root, 'styleproof.config.json'), JSON.stringify({ spec: 'custom-proof.spec.ts' }));
        }
        const result = runMap(root);
        assert.equal(result.status, 2, result.stderr);
        assert.ok(result.stderr.startsWith(`styleproof-map: ${filename}: module configuration`), result.stderr);
        assert.match(result.stderr, /module configuration is not supported by this release/);
        assert.match(result.stderr, /styleproof\.config\.json/);
        assert.doesNotMatch(result.stderr, /no StyleProof spec/);
        assert.equal(fs.existsSync(sentinel), false);
      } finally {
        rmTmp(root);
      }
    });
  }
}

test('real map CLI lists every unsupported module config in a stable order', () => {
  const root = mkNonGitTmp('multiple-config-cli-');
  try {
    for (const filename of [...moduleNames].reverse())
      fs.writeFileSync(path.join(root, filename), 'export default {};');
    const result = runMap(root);
    assert.equal(result.status, 2, result.stderr);
    assert.ok(
      result.stderr.startsWith(`styleproof-map: ${moduleNames.join(', ')}: module configuration`),
      result.stderr,
    );
  } finally {
    rmTmp(root);
  }
});

test('fresh init does not generate unsupported module configuration', () => {
  const root = mkNonGitTmp('init-static-config-');
  try {
    const result = spawnSync(process.execPath, [path.join(repo, 'bin/styleproof-init.mjs'), '--external-server'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(root, 'e2e/styleproof.spec.ts')), true);
    for (const filename of moduleNames) assert.equal(fs.existsSync(path.join(root, filename)), false, filename);
  } finally {
    rmTmp(root);
  }
});
