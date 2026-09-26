import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadStyleProofConfig, loadStyleProofConfigAsync, defineConfig } from '../dist/config.js';
import { mkTmp, rmTmp } from './helpers.mjs';

const STYLEPROOF_CONFIG_JSON = 'styleproof.config.json';
const STYLEPROOF_CONFIG_MJS = 'styleproof.config.mjs';
const STYLEPROOF_CONFIG_FILE = STYLEPROOF_CONFIG_JSON;

const here = path.dirname(fileURLToPath(import.meta.url));
const AFFECTED = path.join(here, '..', 'bin', 'styleproof-affected.mjs');
const MAP = path.join(here, '..', 'bin', 'styleproof-map.mjs');
const PREPUSH = path.join(here, '..', 'bin', 'styleproof-prepush.mjs');
const FIXTURE = path.join(here, 'fixtures', 'selective-remap');

function withConfig(config, fn) {
  const dir = mkTmp('styleproof-config-');
  try {
    fs.writeFileSync(
      path.join(dir, STYLEPROOF_CONFIG_FILE),
      typeof config === 'string' ? config : JSON.stringify(config, null, 2),
    );
    return fn(dir);
  } finally {
    rmTmp(dir);
  }
}

async function withMjsConfigAsync(configContent, fn) {
  const dir = mkTmp('styleproof-mjs-config-');
  try {
    fs.writeFileSync(path.join(dir, STYLEPROOF_CONFIG_MJS), configContent);
    return await fn(dir);
  } finally {
    rmTmp(dir);
  }
}

test('loadStyleProofConfig: a missing file is an empty config, never an error', () => {
  const dir = mkTmp('styleproof-config-none-');
  try {
    assert.deepEqual(loadStyleProofConfig(dir), {});
  } finally {
    rmTmp(dir);
  }
});

test('loadStyleProofConfig: reads the CLI default keys and the affected block', () => {
  withConfig(
    {
      spec: 'tests/styleproof.spec.ts',
      dirtyAllow: ['hud/tsconfig.json'],
      cacheBranch: 'my-maps',
      remote: 'upstream',
      affected: { surfaces: { home: 'src/pages/Home.tsx' }, graph: 'dc.json', base: 'origin/main' },
    },
    (dir) => {
      const config = loadStyleProofConfig(dir);
      assert.equal(config.spec, 'tests/styleproof.spec.ts');
      assert.deepEqual(config.dirtyAllow, ['hud/tsconfig.json']);
      assert.equal(config.cacheBranch, 'my-maps');
      assert.equal(config.remote, 'upstream');
      assert.deepEqual(config.affected, {
        surfaces: { home: 'src/pages/Home.tsx' },
        graph: 'dc.json',
        base: 'origin/main',
        selectiveRemap: undefined,
      });
    },
  );
});

test('loadStyleProofConfig: affected.selectiveRemap opts into CI selective remap', () => {
  withConfig(
    {
      affected: {
        surfaces: { home: 'src/pages/Home.tsx' },
        graph: 'dc.json',
        base: 'origin/main',
        selectiveRemap: true,
      },
    },
    (dir) => {
      const config = loadStyleProofConfig(dir);
      assert.equal(config.affected?.selectiveRemap, true);
    },
  );
  withConfig({ affected: { selectiveRemap: 'yes' } }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /selectiveRemap.*boolean/);
  });
});

test("loadStyleProofConfig: validates the Action's gate-policy keys in the shared config", () => {
  withConfig({ blocking: false, gateInventoryRemovals: false, dirtyAllow: ['a.json'] }, (dir) => {
    const config = loadStyleProofConfig(dir);
    assert.deepEqual(config.dirtyAllow, ['a.json']);
    assert.equal(config.blocking, false);
    assert.equal(config.gateInventoryRemovals, false);
  });
});

test('loadStyleProofConfig: written-but-broken config fails LOUDLY, never silently drops', () => {
  withConfig('{ not json', (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /invalid JSON/);
  });
  withConfig({ dirtyAllow: 'hud/tsconfig.json' }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"dirtyAllow" must be an array/);
  });
  withConfig({ spec: 42 }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"spec" must be a non-empty string/);
  });
  withConfig({ blocking: 'invalid-string' }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"blocking" must be a boolean or 'advisory'/);
  });
  withConfig({ gateInventoryRemovals: 0 }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"gateInventoryRemovals" must be a boolean/);
  });
  withConfig({ affected: { surfaces: { home: 7 } } }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"affected\.surfaces\.home"/);
  });
  withConfig([1, 2], (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /must be a JSON object/);
  });
});

test('styleproof-affected: a fully configured repo runs with no input flags at all', () => {
  // The config lives in the package the verdict is about: at cwd for a plain
  // repo, at --root for a monorepo subpackage. Both invocations below read the
  // SAME config from the package root — the second must not silently fall back
  // to whatever sits at the invoking cwd.
  const pkg = mkTmp('styleproof-config-pkg-');
  const elsewhere = mkTmp('styleproof-config-cwd-');
  try {
    fs.cpSync(FIXTURE, pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, STYLEPROOF_CONFIG_FILE),
      JSON.stringify(
        {
          affected: {
            graph: 'graph.depcruise.json',
            surfaces: {
              home: 'src/pages/Home.tsx',
              pricing: 'src/pages/Pricing.tsx',
              dashboard: 'src/pages/Dashboard.tsx',
            },
          },
        },
        null,
        2,
      ),
    );
    const bare = spawnSync(process.execPath, [AFFECTED, '--changed', 'src/components/Chart.module.css', '--json'], {
      cwd: pkg,
      encoding: 'utf8',
    });
    assert.equal(bare.status, 0, bare.stderr);
    const verdict = JSON.parse(bare.stdout);
    assert.deepEqual(verdict.recapture, ['dashboard']);
    assert.deepEqual(verdict.reuse, ['home', 'pricing']);

    // From an unrelated cwd, --root carries BOTH the source resolution and the
    // config (the subpackage's affected block, not the invoker's).
    const viaRoot = spawnSync(
      process.execPath,
      [AFFECTED, '--changed', 'src/components/Chart.module.css', '--root', pkg, '--json'],
      { cwd: elsewhere, encoding: 'utf8' },
    );
    assert.equal(viaRoot.status, 0, viaRoot.stderr);
    assert.deepEqual(JSON.parse(viaRoot.stdout).recapture, ['dashboard']);
  } finally {
    rmTmp(pkg);
    rmTmp(elsewhere);
  }
});

test('loadStyleProofConfig: reads the closed-world crawl block for confidence exclusions', () => {
  withConfig(
    {
      crawl: {
        baseUrl: 'http://127.0.0.1:3000',
        routes: ['/', 'account=/account'],
        setup: 'styleproof.setup.json',
        authBoundaryExclude: 'styleproof.auth-boundary-exclude.json',
        incompleteUiExclude: 'styleproof.incomplete-ui-exclude.json',
        strict: true,
        maxActions: 20,
        width: 1440,
        height: 900,
      },
    },
    (dir) => {
      const config = loadStyleProofConfig(dir);
      assert.deepEqual(config.crawl, {
        baseUrl: 'http://127.0.0.1:3000',
        routes: ['/', 'account=/account'],
        setup: 'styleproof.setup.json',
        authBoundaryExclude: 'styleproof.auth-boundary-exclude.json',
        incompleteUiExclude: 'styleproof.incomplete-ui-exclude.json',
        strict: true,
        out: undefined,
        maxActions: 20,
        width: 1440,
        height: 900,
      });
    },
  );
});

test('loadStyleProofConfig: crawl block rejects bad types and warns on unknown crawl keys', () => {
  withConfig({ crawl: { setup: 7 } }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"crawl\.setup" must be a non-empty string/);
  });
  withConfig({ crawl: { maxActions: 0 } }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"crawl\.maxActions" must be a positive number/);
  });
  withConfig({ crawl: { baseUrl: 'http://x', seutup: 'typo.json' } }, (dir) => {
    const map = spawnSync(process.execPath, [MAP], { cwd: dir, encoding: 'utf8' });
    assert.match(map.stderr, /unknown "crawl" key\(s\) ignored: seutup/);
  });
});

test('styleproof-map: refuses crawl.setup / authBoundaryExclude (auth belongs on styleproof-capture)', () => {
  withConfig(
    {
      crawl: {
        baseUrl: 'http://127.0.0.1:9',
        routes: ['/'],
        setup: 'styleproof.setup.json',
      },
    },
    (dir) => {
      fs.mkdirSync(path.join(dir, 'e2e'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'e2e/styleproof.spec.ts'), '// spec\n');
      fs.writeFileSync(path.join(dir, 'styleproof.setup.json'), '[]\n');
      const map = spawnSync(process.execPath, [MAP], { cwd: dir, encoding: 'utf8' });
      assert.equal(map.status, 2, map.stderr);
      assert.match(map.stderr, /does not run auth setup|styleproof-capture/);
    },
  );

  withConfig({ spec: 'e2e/styleproof.spec.ts' }, (dir) => {
    fs.mkdirSync(path.join(dir, 'e2e'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'e2e/styleproof.spec.ts'), '// spec\n');
    const map = spawnSync(process.execPath, [MAP, '--setup', 'x.json'], { cwd: dir, encoding: 'utf8' });
    assert.equal(map.status, 2, map.stderr);
    assert.match(map.stderr, /not supported on the spec-driven map path|unknown flag: --setup/);
  });
});

test('loadStyleProofConfig: unknown keys warn loudly instead of silently dropping', () => {
  // A typo'd key silently reverting to defaults is the exact failure the
  // loader's contract forbids — but it must stay a WARNING so a config written
  // for a newer release doesn't brick every CLI during version skew.
  withConfig({ dirtyallow: ['tsconfig.json'], spec: 'e2e/styleproof.spec.ts' }, (dir) => {
    const map = spawnSync(process.execPath, [MAP], { cwd: dir, encoding: 'utf8' });
    assert.match(map.stderr, /unknown key\(s\) ignored: dirtyallow/);
    assert.match(map.stderr, /known: .*dirtyAllow/);
  });
  withConfig({ affected: { graph: 'dc.json', bsae: 'origin/main' } }, (dir) => {
    const map = spawnSync(process.execPath, [MAP], { cwd: dir, encoding: 'utf8' });
    assert.match(map.stderr, /unknown "affected" key\(s\) ignored: bsae/);
  });
  withConfig({ spec: 'e2e/styleproof.spec.ts' }, (dir) => {
    const map = spawnSync(process.execPath, [MAP], { cwd: dir, encoding: 'utf8' });
    assert.doesNotMatch(map.stderr, /unknown key/);
  });
});

test('styleproof-map / styleproof-prepush: a malformed config is a usage error before any work', () => {
  withConfig('{ nope', (dir) => {
    const map = spawnSync(process.execPath, [MAP], { cwd: dir, encoding: 'utf8' });
    assert.equal(map.status, 2);
    assert.match(map.stderr, /styleproof\.config\.json: invalid JSON/);

    const prepush = spawnSync(process.execPath, [PREPUSH], { cwd: dir, encoding: 'utf8', input: '' });
    assert.equal(prepush.status, 2);
    assert.match(prepush.stderr, /styleproof\.config\.json: invalid JSON/);
  });
});

test('styleproof-map: config spec/cacheBranch are defaults, flags and env override', () => {
  // A spec path that does not exist makes styleproof-map exit 2 naming it — a
  // cheap probe proving WHICH spec value won the precedence contest.
  withConfig({ spec: 'from-config.spec.ts' }, (dir) => {
    const fromConfig = spawnSync(process.execPath, [MAP], { cwd: dir, encoding: 'utf8' });
    assert.equal(fromConfig.status, 2);
    assert.match(fromConfig.stderr, /from-config\.spec\.ts/);

    const fromFlag = spawnSync(process.execPath, [MAP, '--spec', 'from-flag.spec.ts'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(fromFlag.status, 2);
    assert.match(fromFlag.stderr, /from-flag\.spec\.ts/);
  });
});

test('styleproof-diff / styleproof-report: a malformed config is a usage error (config-aware like every CLI)', () => {
  withConfig('{ nope', (dir) => {
    const DIFF = path.join(here, '..', 'bin', 'styleproof-diff.mjs');
    const REPORT = path.join(here, '..', 'bin', 'styleproof-report.mjs');
    for (const bin of [DIFF, REPORT]) {
      const res = spawnSync(process.execPath, [bin, 'a-dir', 'b-dir'], { cwd: dir, encoding: 'utf8' });
      assert.equal(res.status, 2, res.stderr);
      assert.match(res.stderr, /styleproof\.config\.json: invalid JSON/);
    }
  });
});

test('styleproof-diff / styleproof-report: cached-map remote and branch follow flag > env > config > built-in', () => {
  // No remote exists in the temp repo, so the "git remote <name> was not found"
  // message names the remote that won the precedence contest.
  withConfig({ remote: 'from-config-remote', cacheBranch: 'from-config-maps' }, (dir) => {
    const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    fs.mkdirSync(path.join(dir, 'e2e'));
    fs.writeFileSync(path.join(dir, 'e2e', 'styleproof.spec.ts'), '');
    const env = { ...process.env };
    delete env.STYLEPROOF_REMOTE;
    delete env.STYLEPROOF_CACHE_BRANCH;
    for (const bin of ['styleproof-diff.mjs', 'styleproof-report.mjs']) {
      const run = (args, extraEnv = {}) =>
        spawnSync(process.execPath, [path.join(here, '..', 'bin', bin), 'main', ...args], {
          cwd: dir,
          encoding: 'utf8',
          env: { ...env, ...extraEnv },
        });
      assert.match(run([]).stderr, /git remote from-config-remote was not found/, bin);
      assert.match(
        run([], { STYLEPROOF_REMOTE: 'from-env-remote' }).stderr,
        /git remote from-env-remote was not found/,
      );
      assert.match(
        run(['--remote', 'from-flag-remote'], { STYLEPROOF_REMOTE: 'from-env-remote' }).stderr,
        /git remote from-flag-remote was not found/,
      );
    }

    // Once the configured remote exists (an empty bare repo), the "map store branch <name>
    // does not exist" message names the branch that won the same contest.
    const bare = mkTmp('styleproof-config-remote-');
    try {
      spawnSync('git', ['init', '-q', '--bare', bare], { encoding: 'utf8' });
      git('remote', 'add', 'from-config-remote', bare);
      for (const bin of ['styleproof-diff.mjs', 'styleproof-report.mjs']) {
        const run = (args, extraEnv = {}) =>
          spawnSync(process.execPath, [path.join(here, '..', 'bin', bin), 'main', ...args], {
            cwd: dir,
            encoding: 'utf8',
            env: { ...env, ...extraEnv },
          });
        assert.match(run([]).stderr, /map store branch from-config-maps does not exist/, bin);
        assert.match(
          run([], { STYLEPROOF_CACHE_BRANCH: 'from-env-maps' }).stderr,
          /map store branch from-env-maps does not exist/,
        );
        assert.match(
          run(['--cache-branch', 'from-flag-maps'], { STYLEPROOF_CACHE_BRANCH: 'from-env-maps' }).stderr,
          /map store branch from-flag-maps does not exist/,
        );
      }
    } finally {
      rmTmp(bare);
    }
  });
});

test('the reference documents every top-level one-config adoption block', () => {
  const readme = fs.readFileSync(path.join(here, '..', 'docs/REFERENCE.md'), 'utf8');
  const configReference = readme.slice(readme.indexOf('**Config file `styleproof.config.ts`'));
  assert.match(configReference, /\| `crawl`\s+\|/);
  assert.match(configReference, /`setup`/);
  assert.match(configReference, /`authBoundaryExclude`/);
});

// --- New tests for #579: One root styleproof.config.ts ---

test('defineConfig: returns the config unchanged (identity function for type safety)', () => {
  const input = { blocking: true, spec: 'e2e/spec.ts', roots: ['hud'] };
  const result = defineConfig(input);
  assert.deepEqual(result, input);
  assert.strictEqual(result, input);
});

test('loadStyleProofConfig: reads the roots array for multi-directory projects', () => {
  withConfig({ roots: ['hud', 'admin'], spec: 'e2e/styleproof.spec.ts' }, (dir) => {
    const config = loadStyleProofConfig(dir);
    assert.deepEqual(config.roots, ['hud', 'admin']);
  });
});

test('loadStyleProofConfig: validates roots must be an array of strings', () => {
  withConfig({ roots: 'hud' }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"roots" must be an array/);
  });
  withConfig({ roots: [42] }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"roots" must be an array of non-empty strings/);
  });
});

test('loadStyleProofConfig: reads the requireApproval field', () => {
  withConfig({ requireApproval: true, blocking: true }, (dir) => {
    const config = loadStyleProofConfig(dir);
    assert.equal(config.requireApproval, true);
    assert.equal(config.blocking, true);
  });
});

test('loadStyleProofConfig: validates requireApproval must be a boolean', () => {
  withConfig({ requireApproval: 'true' }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"requireApproval" must be a boolean/);
  });
});

test('loadStyleProofConfig: emits deprecation warning when only JSON config exists', () => {
  withConfig({ blocking: true }, (dir) => {
    const map = spawnSync(process.execPath, [MAP], { cwd: dir, encoding: 'utf8' });
    assert.match(map.stderr, /styleproof\.config\.json is deprecated/);
    assert.match(map.stderr, /migrate to styleproof\.config\.ts/);
  });
});

test('loadStyleProofConfigAsync: returns empty config when no config file exists', async () => {
  const dir = mkTmp('styleproof-no-config-');
  try {
    const config = await loadStyleProofConfigAsync(dir);
    assert.deepEqual(config, {});
  } finally {
    rmTmp(dir);
  }
});

test('loadStyleProofConfigAsync: loads JSON config with deprecation warning', async () => {
  const dir = mkTmp('styleproof-json-async-');
  try {
    fs.writeFileSync(path.join(dir, STYLEPROOF_CONFIG_JSON), JSON.stringify({ blocking: true, spec: 'test.spec.ts' }));
    const config = await loadStyleProofConfigAsync(dir);
    assert.equal(config.blocking, true);
    assert.equal(config.spec, 'test.spec.ts');
  } finally {
    rmTmp(dir);
  }
});

test('loadStyleProofConfig: known keys list includes roots and requireApproval', () => {
  withConfig({ roots: ['hud'], requireApproval: true }, (dir) => {
    const map = spawnSync(process.execPath, [MAP], { cwd: dir, encoding: 'utf8' });
    assert.doesNotMatch(map.stderr, /unknown key\(s\) ignored:.*roots/);
    assert.doesNotMatch(map.stderr, /unknown key\(s\) ignored:.*requireApproval/);
  });
});

test('loadStyleProofConfigAsync: loads ESM config (.mjs) with defineConfig', async () => {
  await withMjsConfigAsync(
    `export default { blocking: true, spec: 'e2e/spec.ts', roots: ['hud', 'admin'] };`,
    async (dir) => {
      const config = await loadStyleProofConfigAsync(dir);
      assert.equal(config.blocking, true);
      assert.equal(config.spec, 'e2e/spec.ts');
      assert.deepEqual(config.roots, ['hud', 'admin']);
    },
  );
});

test('loadStyleProofConfigAsync: ESM config takes precedence over JSON', async () => {
  const dir = mkTmp('styleproof-esm-precedence-');
  try {
    fs.writeFileSync(path.join(dir, STYLEPROOF_CONFIG_JSON), JSON.stringify({ blocking: false, spec: 'json.spec.ts' }));
    fs.writeFileSync(path.join(dir, STYLEPROOF_CONFIG_MJS), `export default { blocking: true, spec: 'mjs.spec.ts' };`);
    const config = await loadStyleProofConfigAsync(dir);
    assert.equal(config.blocking, true);
    assert.equal(config.spec, 'mjs.spec.ts');
  } finally {
    rmTmp(dir);
  }
});

// --- Advisory mode tests (#580) ---

test('loadStyleProofConfig: accepts blocking: "advisory" for advisory-only mode', () => {
  withConfig({ blocking: 'advisory' }, (dir) => {
    const config = loadStyleProofConfig(dir);
    assert.equal(config.blocking, 'advisory');
  });
});

test('loadStyleProofConfig: accepts blocking: true and blocking: false alongside advisory', () => {
  withConfig({ blocking: true }, (dir) => {
    const config = loadStyleProofConfig(dir);
    assert.equal(config.blocking, true);
  });
  withConfig({ blocking: false }, (dir) => {
    const config = loadStyleProofConfig(dir);
    assert.equal(config.blocking, false);
  });
});

test('loadStyleProofConfig: rejects invalid blocking string values', () => {
  withConfig({ blocking: 'true' }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"blocking" must be a boolean or 'advisory'/);
  });
  withConfig({ blocking: 'false' }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"blocking" must be a boolean or 'advisory'/);
  });
  withConfig({ blocking: 'enabled' }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"blocking" must be a boolean or 'advisory'/);
  });
});

// --- Tests for #595: map-store token and timeout defaults ---

test('loadStyleProofConfig: reads mapStore block with token and gitTimeoutMs', () => {
  withConfig({ mapStore: { token: 'inherit', gitTimeoutMs: 120000 } }, (dir) => {
    const config = loadStyleProofConfig(dir);
    assert.deepEqual(config.mapStore, { token: 'inherit', gitTimeoutMs: 120000 });
  });
});

test('loadStyleProofConfig: mapStore.token accepts "inherit" or string env reference', () => {
  withConfig({ mapStore: { token: 'inherit' } }, (dir) => {
    const config = loadStyleProofConfig(dir);
    assert.equal(config.mapStore.token, 'inherit');
  });
  withConfig({ mapStore: { token: '${GITHUB_TOKEN}' } }, (dir) => {
    const config = loadStyleProofConfig(dir);
    assert.equal(config.mapStore.token, '${GITHUB_TOKEN}');
  });
});

test('loadStyleProofConfig: mapStore.gitTimeoutMs must be a positive number', () => {
  withConfig({ mapStore: { gitTimeoutMs: 0 } }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"mapStore\.gitTimeoutMs" must be a positive number/);
  });
  withConfig({ mapStore: { gitTimeoutMs: -1 } }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"mapStore\.gitTimeoutMs" must be a positive number/);
  });
  withConfig({ mapStore: { gitTimeoutMs: 'fast' } }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"mapStore\.gitTimeoutMs" must be a positive number/);
  });
});

test('loadStyleProofConfig: mapStore block warns on unknown keys', () => {
  withConfig({ mapStore: { token: 'inherit', gitTimeotMs: 120000 }, spec: 'e2e/styleproof.spec.ts' }, (dir) => {
    const map = spawnSync(process.execPath, [MAP], { cwd: dir, encoding: 'utf8' });
    assert.match(map.stderr, /unknown "mapStore" key\(s\) ignored: gitTimeotMs/);
  });
});

test('loadStyleProofConfig: mapStore block is optional', () => {
  withConfig({ spec: 'e2e/styleproof.spec.ts' }, (dir) => {
    const config = loadStyleProofConfig(dir);
    assert.equal(config.mapStore, undefined);
  });
});

test('loadStyleProofConfig: mapStore.pruneRetentionDays and pruneBudgetBytes are accepted', () => {
  withConfig({ mapStore: { pruneRetentionDays: 14, pruneBudgetBytes: 1_500_000_000 } }, (dir) => {
    const config = loadStyleProofConfig(dir);
    assert.equal(config.mapStore.pruneRetentionDays, 14);
    assert.equal(config.mapStore.pruneBudgetBytes, 1_500_000_000);
  });
});

test('loadStyleProofConfig: mapStore.pruneRetentionDays must be a positive number', () => {
  withConfig({ mapStore: { pruneRetentionDays: 0 } }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"mapStore\.pruneRetentionDays" must be a positive number/);
  });
  withConfig({ mapStore: { pruneRetentionDays: -7 } }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"mapStore\.pruneRetentionDays" must be a positive number/);
  });
});

// --- Tests for #595: ancestor baseline config ---

test('loadStyleProofConfig: reads ancestorBaseline block with enabled and roots', () => {
  withConfig({ ancestorBaseline: { enabled: true, roots: ['src', 'styles'] } }, (dir) => {
    const config = loadStyleProofConfig(dir);
    assert.deepEqual(config.ancestorBaseline, { enabled: true, roots: ['src', 'styles'] });
  });
});

test('loadStyleProofConfig: ancestorBaseline.enabled accepts boolean', () => {
  withConfig({ ancestorBaseline: { enabled: false } }, (dir) => {
    const config = loadStyleProofConfig(dir);
    assert.equal(config.ancestorBaseline.enabled, false);
  });
  withConfig({ ancestorBaseline: { enabled: true } }, (dir) => {
    const config = loadStyleProofConfig(dir);
    assert.equal(config.ancestorBaseline.enabled, true);
  });
});

test('loadStyleProofConfig: ancestorBaseline.enabled rejects non-boolean', () => {
  withConfig({ ancestorBaseline: { enabled: 'true' } }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"ancestorBaseline\.enabled" must be a boolean/);
  });
  withConfig({ ancestorBaseline: { enabled: 1 } }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"ancestorBaseline\.enabled" must be a boolean/);
  });
});

test('loadStyleProofConfig: ancestorBaseline.roots must be array of strings', () => {
  withConfig({ ancestorBaseline: { roots: 'src' } }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"ancestorBaseline\.roots" must be an array/);
  });
  withConfig({ ancestorBaseline: { roots: [42] } }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"ancestorBaseline\.roots" must be an array of non-empty strings/);
  });
});

test('loadStyleProofConfig: ancestorBaseline block warns on unknown keys', () => {
  withConfig({ ancestorBaseline: { enabled: true, roost: ['src'] }, spec: 'e2e/styleproof.spec.ts' }, (dir) => {
    const map = spawnSync(process.execPath, [MAP], { cwd: dir, encoding: 'utf8' });
    assert.match(map.stderr, /unknown "ancestorBaseline" key\(s\) ignored: roost/);
  });
});

test('loadStyleProofConfig: ancestorBaseline block is optional', () => {
  withConfig({ spec: 'e2e/styleproof.spec.ts' }, (dir) => {
    const config = loadStyleProofConfig(dir);
    assert.equal(config.ancestorBaseline, undefined);
  });
});

// --- Tests for #596: report store prune schedule defaults ---

test('loadStyleProofConfig: reads reportStore block with prune retention and budget', () => {
  withConfig({ reportStore: { pruneRetentionDays: 30, pruneBudgetBytes: 2_000_000_000 } }, (dir) => {
    const config = loadStyleProofConfig(dir);
    assert.deepEqual(config.reportStore, { pruneRetentionDays: 30, pruneBudgetBytes: 2_000_000_000 });
  });
});

test('loadStyleProofConfig: reportStore.pruneRetentionDays must be a positive number', () => {
  withConfig({ reportStore: { pruneRetentionDays: 0 } }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"reportStore\.pruneRetentionDays" must be a positive number/);
  });
  withConfig({ reportStore: { pruneRetentionDays: -7 } }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"reportStore\.pruneRetentionDays" must be a positive number/);
  });
  withConfig({ reportStore: { pruneRetentionDays: 'month' } }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"reportStore\.pruneRetentionDays" must be a positive number/);
  });
});

test('loadStyleProofConfig: reportStore.pruneBudgetBytes must be a positive number', () => {
  withConfig({ reportStore: { pruneBudgetBytes: 0 } }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"reportStore\.pruneBudgetBytes" must be a positive number/);
  });
  withConfig({ reportStore: { pruneBudgetBytes: -1 } }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"reportStore\.pruneBudgetBytes" must be a positive number/);
  });
});

test('loadStyleProofConfig: reportStore block warns on unknown keys', () => {
  withConfig(
    { reportStore: { pruneRetentionDays: 30, pruneBugetBytes: 2_000_000_000 }, spec: 'e2e/styleproof.spec.ts' },
    (dir) => {
      const map = spawnSync(process.execPath, [MAP], { cwd: dir, encoding: 'utf8' });
      assert.match(map.stderr, /unknown "reportStore" key\(s\) ignored: pruneBugetBytes/);
    },
  );
});

test('loadStyleProofConfig: reportStore block is optional', () => {
  withConfig({ spec: 'e2e/styleproof.spec.ts' }, (dir) => {
    const config = loadStyleProofConfig(dir);
    assert.equal(config.reportStore, undefined);
  });
});

// --- Tests for #596: prune CLI config defaults ---

const PRUNE_MAPS = path.join(here, '..', 'bin', 'styleproof-prune-maps.mjs');
const PRUNE_REPORTS = path.join(here, '..', 'bin', 'styleproof-prune-reports.mjs');

test('styleproof-prune-maps: --help shows config-aware retention default', () => {
  const help = spawnSync(process.execPath, [PRUNE_MAPS, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /mapStore\.pruneRetentionDays/);
});

test('styleproof-prune-maps: --help shows config-aware budget default (1.5GB)', () => {
  const help = spawnSync(process.execPath, [PRUNE_MAPS, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--budget-bytes/);
  assert.match(help.stdout, /mapStore\.pruneBudgetBytes/);
  assert.match(help.stdout, /1\.5GB/);
});

test('styleproof-prune-reports: --help shows config-aware defaults', () => {
  const help = spawnSync(process.execPath, [PRUNE_REPORTS, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /reportStore\.pruneRetentionDays/);
  assert.match(help.stdout, /reportStore\.pruneBudgetBytes/);
});

// --- suppressPlatformWarning tests (#600) ---

test('loadStyleProofConfig: parses suppressPlatformWarning true', () => {
  withConfig({ suppressPlatformWarning: true }, (dir) => {
    const config = loadStyleProofConfig(dir);
    assert.equal(config.suppressPlatformWarning, true);
  });
});

test('loadStyleProofConfig: parses suppressPlatformWarning false', () => {
  withConfig({ suppressPlatformWarning: false }, (dir) => {
    const config = loadStyleProofConfig(dir);
    assert.equal(config.suppressPlatformWarning, false);
  });
});

test('loadStyleProofConfig: suppressPlatformWarning undefined when missing', () => {
  withConfig({ blocking: true }, (dir) => {
    const config = loadStyleProofConfig(dir);
    assert.equal(config.suppressPlatformWarning, undefined);
  });
});

test('loadStyleProofConfig: rejects invalid suppressPlatformWarning types', () => {
  withConfig({ suppressPlatformWarning: 'true' }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"suppressPlatformWarning" must be a boolean/);
  });
  withConfig({ suppressPlatformWarning: 1 }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"suppressPlatformWarning" must be a boolean/);
  });
});

test('loadStyleProofConfig: suppressPlatformWarning is a known key (no unknown-key warning)', () => {
  withConfig({ suppressPlatformWarning: true, spec: 'e2e/styleproof.spec.ts' }, (dir) => {
    const map = spawnSync(process.execPath, [MAP], { cwd: dir, encoding: 'utf8' });
    assert.doesNotMatch(map.stderr, /unknown key\(s\) ignored:.*suppressPlatformWarning/);
  });
});

// --- Tests for #599: coverage config manifest path ---

test('loadStyleProofConfig: reads coverage block with manifest, strict, and exclude', () => {
  withConfig(
    {
      coverage: {
        manifest: 'styleproof.surfaces.json',
        strict: true,
        exclude: { 'admin-settings': 'behind feature flag' },
      },
    },
    (dir) => {
      const config = loadStyleProofConfig(dir);
      assert.deepEqual(config.coverage, {
        manifest: 'styleproof.surfaces.json',
        strict: true,
        exclude: { 'admin-settings': 'behind feature flag' },
      });
    },
  );
});

test('loadStyleProofConfig: coverage block is optional', () => {
  withConfig({ spec: 'e2e/styleproof.spec.ts' }, (dir) => {
    const config = loadStyleProofConfig(dir);
    assert.equal(config.coverage, undefined);
  });
});

test('loadStyleProofConfig: coverage.manifest must be a non-empty string', () => {
  withConfig({ coverage: { manifest: '' } }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"coverage\.manifest" must be a non-empty string/);
  });
  withConfig({ coverage: { manifest: 42 } }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"coverage\.manifest" must be a non-empty string/);
  });
});

test('loadStyleProofConfig: coverage.strict must be a boolean', () => {
  withConfig({ coverage: { strict: 'true' } }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"coverage\.strict" must be a boolean/);
  });
  withConfig({ coverage: { strict: 1 } }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"coverage\.strict" must be a boolean/);
  });
});

test('loadStyleProofConfig: coverage.exclude values must be non-empty reason strings', () => {
  withConfig({ coverage: { exclude: { admin: '' } } }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"coverage\.exclude\.admin" must be a non-empty reason string/);
  });
  withConfig({ coverage: { exclude: { admin: 42 } } }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"coverage\.exclude\.admin" must be a non-empty reason string/);
  });
});

test('loadStyleProofConfig: coverage block warns on unknown keys', () => {
  withConfig({ coverage: { manifest: 'x.json', strickt: true }, spec: 'e2e/styleproof.spec.ts' }, (dir) => {
    const map = spawnSync(process.execPath, [MAP], { cwd: dir, encoding: 'utf8' });
    assert.match(map.stderr, /unknown "coverage" key\(s\) ignored: strickt/);
  });
});

test('loadStyleProofConfig: coverage is a known key (no unknown-key warning)', () => {
  withConfig({ coverage: { manifest: 'surfaces.json' }, spec: 'e2e/styleproof.spec.ts' }, (dir) => {
    const map = spawnSync(process.execPath, [MAP], { cwd: dir, encoding: 'utf8' });
    assert.doesNotMatch(map.stderr, /unknown key\(s\) ignored:.*coverage/);
  });
});

test('loadStyleProofConfig: reads productState requireIdentity and legacyPairs path', () => {
  withConfig(
    {
      productState: {
        requireIdentity: true,
        legacyPairs: 'styleproof.product-state.json',
      },
    },
    (dir) => {
      const config = loadStyleProofConfig(dir);
      assert.deepEqual(config.productState, {
        requireIdentity: true,
        legacyPairs: 'styleproof.product-state.json',
      });
    },
  );
});

test('loadStyleProofConfig: productState.requireIdentity must be a boolean', () => {
  withConfig({ productState: { requireIdentity: 'true' } }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"productState\.requireIdentity" must be a boolean/);
  });
});

test('loadStyleProofConfig: productState is a known key (no unknown-key warning)', () => {
  withConfig({ productState: { requireIdentity: false }, spec: 'e2e/styleproof.spec.ts' }, (dir) => {
    const map = spawnSync(process.execPath, [MAP], { cwd: dir, encoding: 'utf8' });
    assert.doesNotMatch(map.stderr, /unknown key\(s\) ignored:.*productState/);
  });
});
