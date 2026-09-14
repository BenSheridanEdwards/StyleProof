import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  loadStyleProofConfig,
  loadStyleProofConfigAsync,
  discoverStyleProofConfig,
  resolveStyleProofConfigPath,
  resolveStyleProofConfigFilePaths,
  resolveProjectSpec,
} from '../dist/config.js';
import { mkTmp, rmTmp } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAP = path.join(here, '..', 'bin', 'styleproof-map.mjs');

const NESTED_SPEC = 'hud/tests/e2e/styleproof.spec.ts';

/** Isolated git repo so upward walk stops at this root, not the StyleProof checkout. */
function mkRepoTree() {
  const root = mkTmp('styleproof-config-discover-');
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'pipe' });
  const nested = path.join(root, 'hud');
  fs.mkdirSync(path.join(nested, 'tests', 'e2e'), { recursive: true });
  return { root, nested };
}

function writeJsonConfig(dir, config) {
  fs.writeFileSync(path.join(dir, 'styleproof.config.json'), JSON.stringify(config, null, 2));
}

function writeSpec(root, specRel = NESTED_SPEC) {
  const specAbs = path.join(root, specRel);
  fs.mkdirSync(path.dirname(specAbs), { recursive: true });
  fs.writeFileSync(specAbs, '// styleproof spec\n');
  return specAbs;
}

// --- #645: upward discovery from a package subdirectory ---

test('loadStyleProofConfig: nested cwd discovers the root styleproof.config.json', () => {
  const { root, nested } = mkRepoTree();
  try {
    writeJsonConfig(root, { spec: NESTED_SPEC, blocking: true });
    const config = loadStyleProofConfig(nested);
    assert.equal(config.spec, NESTED_SPEC);
    assert.equal(config.blocking, true);
  } finally {
    rmTmp(root);
  }
});

test('loadStyleProofConfigAsync: nested cwd discovers the root ESM config', async () => {
  const { root, nested } = mkRepoTree();
  try {
    fs.writeFileSync(
      path.join(root, 'styleproof.config.mjs'),
      `export default { spec: '${NESTED_SPEC}', roots: ['hud'] };\n`,
    );
    const config = await loadStyleProofConfigAsync(nested);
    assert.equal(config.spec, NESTED_SPEC);
    assert.deepEqual(config.roots, ['hud']);
  } finally {
    rmTmp(root);
  }
});

test('discoverStyleProofConfig: walks upward and records every candidate path', () => {
  const { root, nested } = mkRepoTree();
  try {
    writeJsonConfig(root, { spec: NESTED_SPEC });
    const discovery = discoverStyleProofConfig(nested);
    assert.ok(discovery.location, 'expected a config file above the package cwd');
    assert.equal(discovery.location.dir, root);
    assert.equal(discovery.location.filename, 'styleproof.config.json');
    assert.equal(discovery.location.path, path.join(root, 'styleproof.config.json'));
    assert.ok(
      discovery.searched.some((candidate) => candidate === path.join(nested, 'styleproof.config.ts')),
      'searched paths must include the package cwd',
    );
    assert.ok(
      discovery.searched.some((candidate) => candidate === path.join(root, 'styleproof.config.json')),
      'searched paths must include the repo-root config',
    );
  } finally {
    rmTmp(root);
  }
});

test('discoverStyleProofConfig: nearest config wins over a parent', () => {
  const { root, nested } = mkRepoTree();
  try {
    writeJsonConfig(root, { spec: 'root.spec.ts' });
    writeJsonConfig(nested, { spec: 'tests/e2e/styleproof.spec.ts' });
    const discovery = discoverStyleProofConfig(nested);
    assert.equal(discovery.location?.dir, nested);
    const config = loadStyleProofConfig(nested);
    assert.equal(config.spec, 'tests/e2e/styleproof.spec.ts');
  } finally {
    rmTmp(root);
  }
});

test('discoverStyleProofConfig: does not walk past the git root', () => {
  const wrapper = mkTmp('styleproof-config-outside-');
  try {
    writeJsonConfig(wrapper, { spec: 'outside.spec.ts' });
    const root = path.join(wrapper, 'repo');
    fs.mkdirSync(root);
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'pipe' });
    const nested = path.join(root, 'hud');
    fs.mkdirSync(nested, { recursive: true });
    const discovery = discoverStyleProofConfig(nested);
    assert.equal(discovery.location, undefined);
    assert.equal(loadStyleProofConfig(nested).spec, undefined);
  } finally {
    rmTmp(wrapper);
  }
});

test('resolveStyleProofConfigPath: joins a relative spec to the config dir, not process cwd', () => {
  const { root, nested } = mkRepoTree();
  const previous = process.cwd();
  try {
    const specAbs = writeSpec(root);
    process.chdir(nested);
    const resolved = resolveStyleProofConfigPath(NESTED_SPEC, root);
    assert.equal(resolved, specAbs);
    assert.notEqual(resolved, path.resolve(nested, NESTED_SPEC));
  } finally {
    process.chdir(previous);
    rmTmp(root);
  }
});

test('resolveStyleProofConfigFilePaths: resolves spec and similar file fields from the config dir', () => {
  const { root } = mkRepoTree();
  try {
    const resolved = resolveStyleProofConfigFilePaths(
      {
        spec: NESTED_SPEC,
        crawl: {
          setup: 'styleproof.setup.json',
          authBoundaryExclude: 'styleproof.auth-boundary-exclude.json',
          incompleteUiExclude: 'styleproof.incomplete-ui-exclude.json',
          out: 'styleproof.variants.generated.json',
        },
        coverage: { manifest: 'styleproof.surfaces.json' },
        affected: { graph: 'dc.json' },
      },
      root,
    );
    assert.equal(resolved.spec, path.join(root, NESTED_SPEC));
    assert.equal(resolved.crawl.setup, path.join(root, 'styleproof.setup.json'));
    assert.equal(resolved.crawl.authBoundaryExclude, path.join(root, 'styleproof.auth-boundary-exclude.json'));
    assert.equal(resolved.crawl.incompleteUiExclude, path.join(root, 'styleproof.incomplete-ui-exclude.json'));
    assert.equal(resolved.crawl.out, path.join(root, 'styleproof.variants.generated.json'));
    assert.equal(resolved.coverage.manifest, path.join(root, 'styleproof.surfaces.json'));
    assert.equal(resolved.affected.graph, path.join(root, 'dc.json'));
  } finally {
    rmTmp(root);
  }
});

test('resolveProjectSpec: nested cwd finds the root config and resolves spec under the config dir', () => {
  const { root, nested } = mkRepoTree();
  try {
    const specAbs = writeSpec(root);
    writeJsonConfig(root, { spec: NESTED_SPEC });
    const resolved = resolveProjectSpec({ startDir: nested });
    assert.equal(resolved.spec, specAbs);
    assert.equal(resolved.specDeclared, NESTED_SPEC);
    assert.equal(resolved.configDir, root);
    assert.equal(resolved.configFile, 'styleproof.config.json');
  } finally {
    rmTmp(root);
  }
});

test('resolveProjectSpec: missing spec fails closed and names the searched config locations', () => {
  const { root, nested } = mkRepoTree();
  try {
    writeJsonConfig(root, { spec: NESTED_SPEC });
    assert.throws(
      () => resolveProjectSpec({ startDir: nested }),
      (error) => {
        assert.match(error.message, /hud\/tests\/e2e\/styleproof\.spec\.ts/);
        assert.match(error.message, /styleproof\.config\.json/);
        assert.match(error.message, new RegExp(nested.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        return true;
      },
    );
  } finally {
    rmTmp(root);
  }
});

test('resolveProjectSpec: missing config fails closed and lists every searched candidate', () => {
  const { root, nested } = mkRepoTree();
  try {
    assert.throws(
      () => resolveProjectSpec({ startDir: nested, requireConfig: true }),
      (error) => {
        assert.match(error.message, /no styleproof\.config/);
        assert.match(error.message, /searched/i);
        assert.match(error.message, /styleproof\.config\.ts/);
        assert.match(error.message, /styleproof\.config\.json/);
        assert.ok(error.message.includes(path.join(nested, 'styleproof.config.ts')));
        assert.ok(error.message.includes(path.join(root, 'styleproof.config.json')));
        return true;
      },
    );
  } finally {
    rmTmp(root);
  }
});

test('resolveProjectSpec: does not soft-fallback to e2e/styleproof.spec.ts when a parent config exists', () => {
  const { root, nested } = mkRepoTree();
  try {
    writeJsonConfig(root, { spec: NESTED_SPEC });
    fs.mkdirSync(path.join(nested, 'e2e'), { recursive: true });
    fs.writeFileSync(path.join(nested, 'e2e', 'styleproof.spec.ts'), '// decoy default spec\n');
    assert.throws(() => resolveProjectSpec({ startDir: nested }), /hud\/tests\/e2e\/styleproof\.spec\.ts/);
    const decoy = resolveProjectSpec({ startDir: nested, requireSpec: false });
    assert.equal(decoy.specDeclared, NESTED_SPEC);
    assert.notEqual(decoy.spec, path.join(nested, 'e2e', 'styleproof.spec.ts'));
  } finally {
    rmTmp(root);
  }
});

test('styleproof-map: nested cwd uses the root config spec, not the default e2e path', () => {
  const { root, nested } = mkRepoTree();
  try {
    writeSpec(root);
    writeJsonConfig(root, { spec: NESTED_SPEC });
    const map = spawnSync(process.execPath, [MAP], { cwd: nested, encoding: 'utf8' });
    assert.doesNotMatch(
      map.stderr,
      /no StyleProof spec at e2e\/styleproof\.spec\.ts/,
      'must not soft-fallback to the default spec when a parent config exists',
    );
    assert.doesNotMatch(
      map.stderr,
      /no StyleProof spec at hud\/tests\/e2e\/styleproof\.spec\.ts/,
      'must resolve the config spec from the config dir, not join it onto the package cwd',
    );
  } finally {
    rmTmp(root);
  }
});
