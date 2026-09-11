import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadStyleProofConfig,
  loadStyleProofConfigAsync,
  defineConfig,
  env,
  resolveEnvReferences,
  redactSecrets,
} from '../dist/config.js';
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
      });
    },
  );
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
    assert.match(map.stderr, /not supported on the spec-driven map path/);
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

test('README documents every top-level one-config adoption block', () => {
  const readme = fs.readFileSync(path.join(here, '..', 'README.md'), 'utf8');
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

test('loadStyleProofConfig: reads the auth block with env/secret references', () => {
  withConfig({ auth: { hudPassword: '${STYLEPROOF_HUD_PASSWORD}' } }, (dir) => {
    const config = loadStyleProofConfig(dir);
    assert.deepEqual(config.auth, { hudPassword: '${STYLEPROOF_HUD_PASSWORD}' });
  });
  withConfig({ auth: { hudPassword: '$HUD_PASS' } }, (dir) => {
    const config = loadStyleProofConfig(dir);
    assert.deepEqual(config.auth, { hudPassword: '$HUD_PASS' });
  });
});

test('loadStyleProofConfig: auth.hudPassword rejects plaintext (must be env/secret reference)', () => {
  withConfig({ auth: { hudPassword: 'my-secret-password' } }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /must reference an env\/secret name/);
  });
});

test('loadStyleProofConfig: auth block warns on unknown keys', () => {
  withConfig({ auth: { hudPassword: '${X}', husPasword: '${Y}' }, spec: 'e2e/styleproof.spec.ts' }, (dir) => {
    const map = spawnSync(process.execPath, [MAP], { cwd: dir, encoding: 'utf8' });
    assert.match(map.stderr, /unknown "auth" key\(s\) ignored: husPasword/);
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

test('loadStyleProofConfig: known keys list includes roots, requireApproval, and auth', () => {
  withConfig({ roots: ['hud'], requireApproval: true, auth: { hudPassword: '${X}' } }, (dir) => {
    const map = spawnSync(process.execPath, [MAP], { cwd: dir, encoding: 'utf8' });
    assert.doesNotMatch(map.stderr, /unknown key\(s\) ignored:.*roots/);
    assert.doesNotMatch(map.stderr, /unknown key\(s\) ignored:.*requireApproval/);
    assert.doesNotMatch(map.stderr, /unknown key\(s\) ignored:.*auth/);
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

// --- Tests for #582: env/secret reference for HUD login ---

test('env(): returns an EnvRef marker object for explicit env references', () => {
  const ref = env('MY_SECRET');
  assert.equal(ref.__envRef, true);
  assert.equal(ref.name, 'MY_SECRET');
});

test('env(): validates env var name is alphanumeric + underscore only', () => {
  assert.throws(() => env('INVALID-NAME'), /must contain only uppercase letters, digits, and underscores/);
  assert.throws(() => env('has spaces'), /must contain only uppercase letters, digits, and underscores/);
  assert.throws(() => env('$VAR'), /must contain only uppercase letters, digits, and underscores/);
  assert.throws(() => env(''), /must contain only uppercase letters, digits, and underscores/);
  assert.doesNotThrow(() => env('VALID_NAME_123'));
  assert.doesNotThrow(() => env('A'));
  assert.doesNotThrow(() => env('_UNDERSCORE'));
});

test('resolveEnvReferences: resolves ${VAR_NAME} syntax from process.env', () => {
  const original = process.env.TEST_SECRET_582;
  try {
    process.env.TEST_SECRET_582 = 'secret-value';
    const config = { auth: { hudPassword: '${TEST_SECRET_582}' } };
    const resolved = resolveEnvReferences(config);
    assert.equal(resolved.auth.hudPassword, 'secret-value');
  } finally {
    if (original === undefined) delete process.env.TEST_SECRET_582;
    else process.env.TEST_SECRET_582 = original;
  }
});

test('resolveEnvReferences: resolves env() helper references from process.env', () => {
  const original = process.env.TEST_API_TOKEN;
  try {
    process.env.TEST_API_TOKEN = 'token-value';
    const ref = env('TEST_API_TOKEN');
    const config = { auth: { apiToken: ref } };
    const resolved = resolveEnvReferences(config);
    assert.equal(resolved.auth.apiToken, 'token-value');
  } finally {
    if (original === undefined) delete process.env.TEST_API_TOKEN;
    else process.env.TEST_API_TOKEN = original;
  }
});

test('resolveEnvReferences: throws loud error when env var is missing', () => {
  delete process.env.NONEXISTENT_VAR_582;
  const config = { auth: { hudPassword: '${NONEXISTENT_VAR_582}' } };
  assert.throws(() => resolveEnvReferences(config), /Environment variable NONEXISTENT_VAR_582 is not set/);
});

test('resolveEnvReferences: throws loud error for env() helper with missing var', () => {
  delete process.env.NONEXISTENT_TOKEN_582;
  const ref = env('NONEXISTENT_TOKEN_582');
  const config = { auth: { apiToken: ref } };
  assert.throws(() => resolveEnvReferences(config), /Environment variable NONEXISTENT_TOKEN_582 is not set/);
});

test('resolveEnvReferences: error message includes helpful guidance', () => {
  delete process.env.MISSING_SECRET_582;
  const config = { auth: { hudPassword: '${MISSING_SECRET_582}' } };
  assert.throws(() => resolveEnvReferences(config), /Set it in your shell or CI secrets/);
});

test('resolveEnvReferences: validates ${VAR_NAME} syntax — alphanumeric + underscore only', () => {
  const config = { auth: { hudPassword: '${INVALID-VAR}' } };
  assert.throws(
    () => resolveEnvReferences(config),
    /Invalid env reference.*must contain only uppercase letters, digits, and underscores/,
  );
});

test('resolveEnvReferences: resolves ${auth.X} cross-references to auth block values', () => {
  const original = process.env.HUD_PASS_582;
  try {
    process.env.HUD_PASS_582 = 'hud-secret';
    const config = {
      auth: { hudPassword: '${HUD_PASS_582}' },
      crawl: {
        setup: 'setup.json',
        setupSteps: [{ action: 'fill', selector: '#password', value: '${auth.hudPassword}' }],
      },
    };
    const resolved = resolveEnvReferences(config);
    assert.equal(resolved.crawl.setupSteps[0].value, 'hud-secret');
  } finally {
    if (original === undefined) delete process.env.HUD_PASS_582;
    else process.env.HUD_PASS_582 = original;
  }
});

test('resolveEnvReferences: ${auth.X} throws if referenced auth key does not exist', () => {
  const original = process.env.SOME_PASS_582;
  try {
    process.env.SOME_PASS_582 = 'value';
    const config = {
      auth: { hudPassword: '${SOME_PASS_582}' },
      crawl: {
        setupSteps: [{ action: 'fill', value: '${auth.nonexistentKey}' }],
      },
    };
    assert.throws(() => resolveEnvReferences(config), /auth\.nonexistentKey.*does not exist/);
  } finally {
    if (original === undefined) delete process.env.SOME_PASS_582;
    else process.env.SOME_PASS_582 = original;
  }
});

test('redactSecrets: replaces resolved secret values with [REDACTED] in strings', () => {
  const secrets = new Set(['secret-password', 'api-token-123']);
  const input = 'Login failed with password secret-password and token api-token-123';
  const redacted = redactSecrets(input, secrets);
  assert.equal(redacted, 'Login failed with password [REDACTED] and token [REDACTED]');
  assert.doesNotMatch(redacted, /secret-password/);
  assert.doesNotMatch(redacted, /api-token-123/);
});

test('redactSecrets: returns original string if no secrets present', () => {
  const secrets = new Set(['secret-password']);
  const input = 'No secrets here';
  const redacted = redactSecrets(input, secrets);
  assert.equal(redacted, 'No secrets here');
});

test('redactSecrets: handles empty secrets set', () => {
  const secrets = new Set();
  const input = 'Some text';
  const redacted = redactSecrets(input, secrets);
  assert.equal(redacted, 'Some text');
});

test('resolveEnvReferences: does not modify non-env strings', () => {
  const original = process.env.REAL_VAR_582;
  try {
    process.env.REAL_VAR_582 = 'real-value';
    const config = {
      spec: 'e2e/styleproof.spec.ts',
      blocking: true,
      auth: { hudPassword: '${REAL_VAR_582}' },
    };
    const resolved = resolveEnvReferences(config);
    assert.equal(resolved.spec, 'e2e/styleproof.spec.ts');
    assert.equal(resolved.blocking, true);
    assert.equal(resolved.auth.hudPassword, 'real-value');
  } finally {
    if (original === undefined) delete process.env.REAL_VAR_582;
    else process.env.REAL_VAR_582 = original;
  }
});

test('resolveEnvReferences: returns collected secrets set for redaction', () => {
  const original1 = process.env.SECRET_A_582;
  const original2 = process.env.SECRET_B_582;
  try {
    process.env.SECRET_A_582 = 'value-a';
    process.env.SECRET_B_582 = 'value-b';
    const config = {
      auth: {
        hudPassword: '${SECRET_A_582}',
        apiToken: '${SECRET_B_582}',
      },
    };
    const { resolved, secrets } = resolveEnvReferences(config, { collectSecrets: true });
    assert.equal(resolved.auth.hudPassword, 'value-a');
    assert.equal(resolved.auth.apiToken, 'value-b');
    assert.ok(secrets instanceof Set);
    assert.ok(secrets.has('value-a'));
    assert.ok(secrets.has('value-b'));
  } finally {
    if (original1 === undefined) delete process.env.SECRET_A_582;
    else process.env.SECRET_A_582 = original1;
    if (original2 === undefined) delete process.env.SECRET_B_582;
    else process.env.SECRET_B_582 = original2;
  }
});

test('error messages never contain secret values, only placeholders', () => {
  const original = process.env.ERR_TEST_582;
  try {
    process.env.ERR_TEST_582 = 'super-secret-value';
    const config = {
      auth: { hudPassword: '${ERR_TEST_582}' },
      crawl: {
        setupSteps: [{ action: 'fill', value: '${auth.missingKey}' }],
      },
    };
    try {
      resolveEnvReferences(config);
      assert.fail('Expected error to be thrown');
    } catch (e) {
      assert.doesNotMatch(e.message, /super-secret-value/);
      assert.match(e.message, /\$\{auth\.missingKey\}|auth\.missingKey/);
    }
  } finally {
    if (original === undefined) delete process.env.ERR_TEST_582;
    else process.env.ERR_TEST_582 = original;
  }
});

test('loadStyleProofConfig: reads auth block with apiToken', () => {
  withConfig({ auth: { hudPassword: '${HUD_PASS}', apiToken: '${API_TOKEN}' } }, (dir) => {
    const config = loadStyleProofConfig(dir);
    assert.deepEqual(config.auth, { hudPassword: '${HUD_PASS}', apiToken: '${API_TOKEN}' });
  });
});

test('loadStyleProofConfig: auth.apiToken rejects plaintext (must be env/secret reference)', () => {
  withConfig({ auth: { apiToken: 'my-api-token' } }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /must reference an env\/secret name/);
  });
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
