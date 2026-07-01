import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const actionYml = fs.readFileSync(path.join(here, '..', 'action.yml'), 'utf8');
const dogfoodYml = fs.readFileSync(path.join(here, '..', '.github/workflows/action-dogfood.yml'), 'utf8');

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

test('dogfood workflow runs the local composite action against clean, changed, and new-surface maps', () => {
  assert.match(dogfoodYml, /uses: \.\/\n/g);
  assert.equal(dogfoodYml.match(/uses: \.\//g)?.length, 3);
  assert.match(dogfoodYml, /action-dogfood\/clean-base/);
  assert.match(dogfoodYml, /action-dogfood\/changed-base/);
  assert.match(dogfoodYml, /action-dogfood\/new-base/);
  assert.match(dogfoodYml, /steps\.changed\.outputs\.changed }}' = 'true'/);
  assert.match(dogfoodYml, /steps\.new-surface\.outputs\.changed }}' = 'false'/);
});

test('dogfood workflow runs on every same-repo PR', () => {
  assert.match(dogfoodYml, /pull_request:\s*\n\npermissions:/);
  assert.doesNotMatch(dogfoodYml, /\n\s+paths:/);
});

test('dogfood workflow asserts the PR report comment and branch artifact', () => {
  assert.ok(dogfoodYml.includes('Assert PR report was published'));
  assert.ok(dogfoodYml.includes('<!-- styleproof-report -->'));
  assert.ok(dogfoodYml.includes('/issues/${PR_NUMBER}/comments'));
  assert.ok(dogfoodYml.includes('/contents/${report_path}?ref=${REPORT_BRANCH}'));
});
