import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const actionYml = fs.readFileSync(path.join(here, '..', 'action.yml'), 'utf8');

test('composite action builds its checkout before running local bins', () => {
  const installStep = actionYml.match(/- name: Install StyleProof action runtime[\s\S]*?(?=\n\s{4}#|\n\s{4}- id:)/);

  assert.ok(installStep, 'action.yml should include an action runtime install step');
  assert.match(installStep[0], /npm ci --ignore-scripts/);
  assert.match(installStep[0], /npm run build/);
  assert.doesNotMatch(installStep[0], /npm ci .*--omit=dev/);
});

test('composite action creates a no-change PR receipt on a clean first run', () => {
  const commentStep = actionYml.match(/- name: Upsert PR comment[\s\S]*?(?=\n\s{4}#|\n\s{4}- name:)/);

  assert.ok(commentStep, 'action.yml should include a PR comment step');
  assert.match(commentStep[0], /if \(!report\) \{/);
  assert.match(
    commentStep[0],
    /await upsert\(`\$\{marker\}\\n## 🗺️ StyleProof report\\n\\n✓ No visual changes detected\.`\);/,
  );
  assert.doesNotMatch(commentStep[0], /if \(existing\) await upsert/, 'clean first run must create a comment too');
});

test('composite action only compares explicit base/head directories', () => {
  assert.match(actionYml, /baseline-dir:[\s\S]*?required: true/);
  assert.doesNotMatch(actionYml, /base-ref:/);
  assert.doesNotMatch(actionYml, /--base-ref/);
  assert.match(actionYml, /styleproof-diff\.mjs" "\$\{\{ inputs\.baseline-dir \}\}" "\$\{\{ inputs\.fresh-dir \}\}"/);
  assert.match(actionYml, /styleproof-report\.mjs" "\$\{\{ inputs\.baseline-dir \}\}" "\$\{\{ inputs\.fresh-dir \}\}"/);
});
