import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STYLEPROOF_CONFIG_FILE, StyleProofConfigError, loadStyleProofConfig } from '../dist/config.js';
import { mkTmp, rmTmp } from './helpers.mjs';

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
    assert.throws(() => loadStyleProofConfig(dir), StyleProofConfigError);
    assert.throws(() => loadStyleProofConfig(dir), /invalid JSON/);
  });
  withConfig({ dirtyAllow: 'hud/tsconfig.json' }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"dirtyAllow" must be an array/);
  });
  withConfig({ spec: 42 }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"spec" must be a non-empty string/);
  });
  withConfig({ blocking: 'false' }, (dir) => {
    assert.throws(() => loadStyleProofConfig(dir), /"blocking" must be a boolean/);
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
  withConfig(
    {
      affected: {
        graph: path.join(FIXTURE, 'graph.depcruise.json'),
        surfaces: {
          home: 'src/pages/Home.tsx',
          pricing: 'src/pages/Pricing.tsx',
          dashboard: 'src/pages/Dashboard.tsx',
        },
      },
    },
    (dir) => {
      const res = spawnSync(
        process.execPath,
        [AFFECTED, '--changed', 'src/components/Chart.module.css', '--root', FIXTURE, '--json'],
        { cwd: dir, encoding: 'utf8' },
      );
      assert.equal(res.status, 0, res.stderr);
      const verdict = JSON.parse(res.stdout);
      assert.deepEqual(verdict.recapture, ['dashboard']);
      assert.deepEqual(verdict.reuse, ['home', 'pricing']);
    },
  );
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
