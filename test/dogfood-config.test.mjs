import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import test from 'node:test';
import { loadStyleProofConfigAsync } from '../dist/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const CONFIG_TS = path.join(repoRoot, 'styleproof.config.ts');
const ACTION_DOGFOOD = path.join(repoRoot, '.github/workflows/action-dogfood.yml');

test('root styleproof.config.ts exists, uses defineConfig, and is advisory', () => {
  assert.ok(fs.existsSync(CONFIG_TS), 'root styleproof.config.ts must exist');
  const source = fs.readFileSync(CONFIG_TS, 'utf8');
  assert.match(source, /import \{ defineConfig \} from 'styleproof'/);
  assert.match(source, /export default defineConfig\(/);
  assert.match(source, /blocking:\s*'advisory'/);
  assert.match(source, /requireApproval:\s*false/);
  assert.match(source, /spec:\s*'example\/styleproof\.spec\.ts'/);
  assert.match(source, /productState:\s*\{/);
  assert.match(source, /legacyPairs:\s*'example\/styleproof\.product-state\.json'/);
  assert.doesNotMatch(source, /hudPassword|apiToken|password\s*:/);
  const declared = JSON.parse(fs.readFileSync(path.join(repoRoot, 'example/styleproof.product-state.json'), 'utf8'));
  assert.equal(typeof declared.home, 'string');
  assert.ok(declared.home.trim().length > 0);
  const jsonConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'styleproof.config.json'), 'utf8'));
  assert.equal(jsonConfig.productState?.legacyPairs, 'example/styleproof.product-state.json');
  const spec = fs.readFileSync(path.join(repoRoot, 'example/styleproof.spec.ts'), 'utf8');
  assert.match(
    spec,
    /expected:\s*SURFACES\.map\(\(surface\) => surface\.key\)/,
    'example spec must declare expected or advisory dogfood fails as CERTIFICATION_FAILED',
  );
  assert.ok(fs.existsSync(path.join(repoRoot, 'example/demo/index.html')));
});

test('root styleproof.config.ts parses through defineConfig on every supported Node', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-dogfood-config-'));
  const outfile = path.join(tmp, 'styleproof.config.mjs');
  try {
    await esbuild.build({
      entryPoints: [CONFIG_TS],
      outfile,
      format: 'esm',
      platform: 'node',
      bundle: true,
      packages: 'external',
      alias: { styleproof: path.join(repoRoot, 'dist/config.js') },
    });
    const config = await loadStyleProofConfigAsync(tmp);
    assert.equal(config.blocking, 'advisory');
    assert.equal(config.requireApproval, false);
    assert.equal(config.spec, 'example/styleproof.spec.ts');
    assert.equal(config.productState?.legacyPairs, 'example/styleproof.product-state.json');
    assert.equal(config.auth, undefined);
    assert.ok(fs.existsSync(path.join(repoRoot, config.spec)));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('synthetic action-dogfood contract suite is still present', () => {
  assert.ok(fs.existsSync(ACTION_DOGFOOD), 'action-dogfood.yml must stay as the contract suite');
  const workflow = fs.readFileSync(ACTION_DOGFOOD, 'utf8');
  assert.match(workflow, /node scripts\/action-dogfood-fixtures\.mjs/);
  assert.match(workflow, /report-branch: styleproof-action-dogfood/);
});
