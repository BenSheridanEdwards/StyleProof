import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
const CONFIG_DIST = path.join(here, '..', 'dist', 'config.js');

const NESTED_SPEC = 'hud/tests/e2e/styleproof.spec.ts';

/** styleproof-init typed scaffold: imports `defineConfig` from the package. */
const INIT_TS_SCAFFOLD = `import { defineConfig } from 'styleproof';

export default defineConfig({
  blocking: 'advisory',
  requireApproval: true,
});
`;

/** Nested-package root config: relative spec into a package subdirectory, no package import. */
const LOADABLE_TS = `export default { spec: '${NESTED_SPEC}', blocking: true };\n`;

/**
 * Load config in a child Node that type-strips `.ts` (Node 22.6+ flag;
 * Node 22.18+ default). Mirrors CI worktrees that have the init scaffold
 * but no resolvable `styleproof` package.
 */
function loadConfigAsyncWithTypeStripping(dir) {
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      '--input-type=module',
      '-e',
      `
        import { loadStyleProofConfigAsync } from ${JSON.stringify(pathToFileURL(CONFIG_DIST).href)};
        const config = await loadStyleProofConfigAsync(${JSON.stringify(dir)});
        process.stdout.write(JSON.stringify(config));
      `,
    ],
    { encoding: 'utf8', cwd: dir },
  );
}

/** Node 18/20 reject `--experimental-strip-types`; skip those spawn cases. */
const TYPE_STRIPPING_UNAVAILABLE = (() => {
  const probe = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '-e', '0'], {
    encoding: 'utf8',
  });
  const text = `${probe.stderr ?? ''}${probe.stdout ?? ''}`;
  return probe.status !== 0 || /bad option|unknown option|is not allowed/i.test(text)
    ? 'Node does not support --experimental-strip-types'
    : false;
})();

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

const INIT_SPECLESS_JSON = { blocking: 'advisory', requireApproval: true };

function assertNoSoftDefaultSpec(errorOrMessage) {
  const message = errorOrMessage instanceof Error ? errorOrMessage.message : String(errorOrMessage);
  assert.doesNotMatch(message, /no StyleProof spec at .*e2e\/styleproof\.spec\.ts/);
  assert.doesNotMatch(message, /declared as "e2e\/styleproof\.spec\.ts"/);
}

function assertLoadedOrFailClosedOnDiscoveredTs(startDir, expectedSpec) {
  let loaded;
  try {
    loaded = loadStyleProofConfig(startDir);
  } catch (error) {
    assert.match(error.message, /styleproof\.config\.ts/);
    assert.match(error.message, /could not be evaluated|cannot evaluate|sync loader/i);
    assertNoSoftDefaultSpec(error);
    return { threw: true };
  }
  assert.notDeepEqual(loaded, {});
  assert.equal(loaded.spec, expectedSpec);
  return { threw: false, loaded };
}

test('loadStyleProofConfig / resolveProjectSpec: discovered .ts + spec-less sibling JSON must not soft-default to e2e/styleproof.spec.ts', () => {
  const { root, nested } = mkRepoTree();
  try {
    const specAbs = writeSpec(root);
    fs.writeFileSync(path.join(root, 'styleproof.config.ts'), LOADABLE_TS);
    writeJsonConfig(root, INIT_SPECLESS_JSON);
    fs.mkdirSync(path.join(nested, 'e2e'), { recursive: true });
    fs.writeFileSync(path.join(nested, 'e2e', 'styleproof.spec.ts'), '// decoy default spec\n');

    const syncLoad = assertLoadedOrFailClosedOnDiscoveredTs(nested, NESTED_SPEC);
    if (!syncLoad.threw) {
      assert.equal(resolveStyleProofConfigPath(syncLoad.loaded.spec, root), specAbs);
    }

    let resolved;
    try {
      resolved = resolveProjectSpec({ startDir: nested, requireSpec: false });
    } catch (error) {
      assert.match(error.message, /styleproof\.config\.ts/);
      assertNoSoftDefaultSpec(error);
      return;
    }
    assert.equal(resolved.configFile, 'styleproof.config.ts');
    assert.equal(resolved.specDeclared, NESTED_SPEC);
    assert.equal(resolved.spec, specAbs);
    assert.notEqual(resolved.spec, path.join(nested, 'e2e', 'styleproof.spec.ts'));
    assert.notEqual(resolved.specDeclared, 'e2e/styleproof.spec.ts');
  } finally {
    rmTmp(root);
  }
});

test('styleproof-map: discovered .ts + spec-less sibling JSON must not soft-default to e2e/styleproof.spec.ts', () => {
  const { root, nested } = mkRepoTree();
  try {
    writeSpec(root);
    fs.writeFileSync(path.join(root, 'styleproof.config.ts'), LOADABLE_TS);
    writeJsonConfig(root, INIT_SPECLESS_JSON);
    fs.mkdirSync(path.join(nested, 'e2e'), { recursive: true });
    fs.writeFileSync(path.join(nested, 'e2e', 'styleproof.spec.ts'), '// decoy default spec\n');

    const map = spawnSync(process.execPath, [MAP], { cwd: nested, encoding: 'utf8' });
    const text = `${map.stderr}${map.stdout}`;
    assert.doesNotMatch(
      text,
      /no StyleProof spec at e2e\/styleproof\.spec\.ts/,
      'must not invent the default spec while a parent .ts config exists',
    );
    assert.doesNotMatch(text, /declared as "e2e\/styleproof\.spec\.ts"/);
    if (map.status !== 0) {
      assert.match(text, /styleproof\.config\.ts/);
      assert.match(
        text,
        /could not be evaluated|could not load|Unknown file extension|Cannot find package|sync loader/i,
      );
    }
  } finally {
    rmTmp(root);
  }
});

test('loadStyleProofConfig: Action-shaped sync load of .ts + spec-less init JSON must not return empty policy', () => {
  const { root, nested } = mkRepoTree();
  try {
    writeSpec(root);
    fs.writeFileSync(path.join(root, 'styleproof.config.ts'), LOADABLE_TS);
    writeJsonConfig(root, INIT_SPECLESS_JSON);
    const syncLoad = assertLoadedOrFailClosedOnDiscoveredTs(nested, NESTED_SPEC);
    if (!syncLoad.threw) {
      assert.equal(syncLoad.loaded.blocking, true);
      assert.notEqual(syncLoad.loaded.requireApproval, true);
    }
  } finally {
    rmTmp(root);
  }
});

test('loadStyleProofConfig: sync loader does not soft-empty a found .ts', () => {
  const { root, nested } = mkRepoTree();
  try {
    fs.writeFileSync(path.join(root, 'styleproof.config.ts'), LOADABLE_TS);
    assertLoadedOrFailClosedOnDiscoveredTs(nested, NESTED_SPEC);
  } finally {
    rmTmp(root);
  }
});

test('loadStyleProofConfigAsync: unloadable .ts without sibling JSON fails closed', async () => {
  const { root, nested } = mkRepoTree();
  try {
    fs.writeFileSync(path.join(root, 'styleproof.config.ts'), INIT_TS_SCAFFOLD);
    await assert.rejects(
      () => loadStyleProofConfigAsync(nested),
      (error) => {
        assert.match(error.message, /styleproof\.config\.ts/);
        assert.match(error.message, /could not be evaluated|could not load|Unknown file extension|Cannot find package/);
        return true;
      },
    );
  } finally {
    rmTmp(root);
  }
});

test(
  'loadStyleProofConfigAsync: type-stripping an unresolved styleproof import fails closed, not empty config',
  { skip: TYPE_STRIPPING_UNAVAILABLE },
  () => {
    const { root, nested } = mkRepoTree();
    try {
      fs.writeFileSync(path.join(root, 'styleproof.config.ts'), INIT_TS_SCAFFOLD);
      const loaded = loadConfigAsyncWithTypeStripping(nested);
      assert.notEqual(loaded.status, 0, loaded.stderr + loaded.stdout);
      assert.match(`${loaded.stderr}${loaded.stdout}`, /styleproof\.config\.ts/);
      assert.match(
        `${loaded.stderr}${loaded.stdout}`,
        /could not be evaluated|could not load|Cannot find package 'styleproof'/,
      );
      assert.doesNotMatch(`${loaded.stdout}`, /"spec"\s*:\s*"e2e\/styleproof\.spec\.ts"/);
    } finally {
      rmTmp(root);
    }
  },
);

test(
  'loadStyleProofConfigAsync: nested cwd loads a root .ts and resolves spec from the config dir',
  { skip: TYPE_STRIPPING_UNAVAILABLE },
  () => {
    const { root, nested } = mkRepoTree();
    try {
      const specAbs = writeSpec(root);
      fs.writeFileSync(path.join(root, 'styleproof.config.ts'), LOADABLE_TS);
      const loaded = loadConfigAsyncWithTypeStripping(nested);
      assert.equal(loaded.status, 0, loaded.stderr + loaded.stdout);
      const config = JSON.parse(loaded.stdout);
      assert.equal(config.spec, NESTED_SPEC);
      assert.equal(config.blocking, true);
      assert.equal(resolveStyleProofConfigPath(config.spec, root), specAbs);
      assert.notEqual(resolveStyleProofConfigPath(config.spec, root), path.resolve(nested, NESTED_SPEC));
    } finally {
      rmTmp(root);
    }
  },
);

test('loadStyleProofConfigAsync: unloadable init .ts fails closed even when sibling JSON exists', async () => {
  const { root, nested } = mkRepoTree();
  try {
    writeSpec(root);
    writeJsonConfig(root, { spec: NESTED_SPEC, blocking: true });
    fs.writeFileSync(path.join(root, 'styleproof.config.ts'), INIT_TS_SCAFFOLD);
    await assert.rejects(
      () => loadStyleProofConfigAsync(nested),
      (error) => {
        assert.match(error.message, /styleproof\.config\.ts/);
        assert.match(error.message, /could not be evaluated|could not load|Unknown file extension|Cannot find package/);
        assert.doesNotMatch(error.message, /e2e\/styleproof\.spec\.ts/);
        return true;
      },
    );
  } finally {
    rmTmp(root);
  }
});

test(
  'loadStyleProofConfigAsync: unloadable init .ts fails closed under type stripping even with sibling JSON',
  { skip: TYPE_STRIPPING_UNAVAILABLE },
  () => {
    const { root, nested } = mkRepoTree();
    try {
      writeSpec(root);
      writeJsonConfig(root, { spec: NESTED_SPEC, blocking: true });
      fs.writeFileSync(path.join(root, 'styleproof.config.ts'), INIT_TS_SCAFFOLD);
      const loaded = loadConfigAsyncWithTypeStripping(nested);
      assert.notEqual(loaded.status, 0, loaded.stderr + loaded.stdout);
      assert.match(`${loaded.stderr}${loaded.stdout}`, /styleproof\.config\.ts/);
      assert.match(
        `${loaded.stderr}${loaded.stdout}`,
        /could not be evaluated|could not load|Cannot find package 'styleproof'/,
      );
      assert.doesNotMatch(`${loaded.stdout}`, /"spec"\s*:\s*"e2e\/styleproof\.spec\.ts"/);
    } finally {
      rmTmp(root);
    }
  },
);

test('resolveProjectSpec: unloadable .ts fails closed and does not default to e2e/styleproof.spec.ts', () => {
  const { root, nested } = mkRepoTree();
  try {
    fs.writeFileSync(path.join(root, 'styleproof.config.ts'), INIT_TS_SCAFFOLD);
    fs.mkdirSync(path.join(nested, 'e2e'), { recursive: true });
    fs.writeFileSync(path.join(nested, 'e2e', 'styleproof.spec.ts'), '// decoy default spec\n');
    assert.throws(
      () => resolveProjectSpec({ startDir: nested }),
      (error) => {
        assert.match(error.message, /styleproof\.config\.ts/);
        assert.match(error.message, /could not be evaluated|cannot evaluate|sync loader/i);
        assert.doesNotMatch(error.message, /no StyleProof spec at .*e2e\/styleproof\.spec\.ts/);
        return true;
      },
    );
  } finally {
    rmTmp(root);
  }
});

test('styleproof-map: missing config from a nested cwd fails closed and lists searched locations', () => {
  const { root, nested } = mkRepoTree();
  try {
    const map = spawnSync(process.execPath, [MAP], { cwd: nested, encoding: 'utf8' });
    assert.equal(map.status, 2, map.stderr + map.stdout);
    assert.match(map.stderr, /searched/i);
    assert.match(map.stderr, /styleproof\.config\.ts/);
    assert.match(map.stderr, /styleproof\.config\.json/);
    assert.ok(map.stderr.includes(path.join(nested, 'styleproof.config.ts')));
    assert.ok(map.stderr.includes(path.join(root, 'styleproof.config.json')));
  } finally {
    rmTmp(root);
  }
});

test('styleproof-map: unloadable root .ts from a nested cwd fails closed, not the default spec', () => {
  const { root, nested } = mkRepoTree();
  try {
    fs.writeFileSync(path.join(root, 'styleproof.config.ts'), INIT_TS_SCAFFOLD);
    fs.mkdirSync(path.join(nested, 'e2e'), { recursive: true });
    fs.writeFileSync(path.join(nested, 'e2e', 'styleproof.spec.ts'), '// decoy default spec\n');
    const map = spawnSync(process.execPath, [MAP], { cwd: nested, encoding: 'utf8' });
    assert.equal(map.status, 2, map.stderr + map.stdout);
    assert.match(map.stderr, /styleproof\.config\.ts/);
    assert.match(map.stderr, /could not be evaluated|could not load|Unknown file extension|Cannot find package/);
    assert.doesNotMatch(map.stderr, /no StyleProof spec at e2e\/styleproof\.spec\.ts/);
  } finally {
    rmTmp(root);
  }
});

test(
  'styleproof-map: nested cwd uses a loadable root .ts spec, not the default e2e path',
  { skip: TYPE_STRIPPING_UNAVAILABLE },
  () => {
    const { root, nested } = mkRepoTree();
    try {
      writeSpec(root);
      fs.writeFileSync(path.join(root, 'styleproof.config.ts'), LOADABLE_TS);
      const map = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', MAP], {
        cwd: nested,
        encoding: 'utf8',
      });
      assert.doesNotMatch(
        map.stderr,
        /no StyleProof spec at e2e\/styleproof\.spec\.ts/,
        'must not soft-fallback to the default spec when a parent .ts config exists',
      );
      assert.doesNotMatch(
        map.stderr,
        /no StyleProof spec at hud\/tests\/e2e\/styleproof\.spec\.ts/,
        'must resolve the .ts spec from the config dir, not join it onto the package cwd',
      );
    } finally {
      rmTmp(root);
    }
  },
);

test('loadStyleProofConfigAsync: a .mjs that cannot resolve styleproof still fails closed', async () => {
  const { root } = mkRepoTree();
  try {
    fs.writeFileSync(
      path.join(root, 'styleproof.config.mjs'),
      `import { defineConfig } from 'styleproof';\nexport default defineConfig({ spec: '${NESTED_SPEC}' });\n`,
    );
    await assert.rejects(
      () => loadStyleProofConfigAsync(root),
      (error) => {
        assert.match(error.message, /could not load/);
        assert.match(error.message, /styleproof/);
        return true;
      },
    );
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
