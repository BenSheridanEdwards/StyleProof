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

test('composite action publishes every generated report crop', () => {
  const publishStep = actionYml.match(/- id: publish[\s\S]*?(?=\n\s{4}- name: Upsert PR comment)/);

  assert.ok(publishStep, 'action.yml should include a report publish step');
  assert.match(publishStep[0], /cp styleproof-report\/crops\/\*\.png "\$TMP\/\$REPORT_PATH\/crops\/"/);
  assert.doesNotMatch(publishStep[0], /\*-composite\.png.*\*-annotated\.png.*\*-new\.png/);
});

test('dogfood workflow runs the local composite action against clean, changed, new-surface, and removal maps', () => {
  assert.match(dogfoodYml, /uses: \.\/\n/g);
  assert.equal(dogfoodYml.match(/uses: \.\//g)?.length, 4);
  assert.match(dogfoodYml, /action-dogfood\/clean-base/);
  assert.match(dogfoodYml, /action-dogfood\/changed-base/);
  assert.match(dogfoodYml, /action-dogfood\/new-base/);
  assert.match(dogfoodYml, /action-dogfood\/removed-base/);
  assert.match(dogfoodYml, /steps\.changed\.outputs\.changed }}' = 'true'/);
  assert.match(dogfoodYml, /steps\.new-surface\.outputs\.changed }}' = 'true'/);
  // The inventory removal must FAIL the action even with fail-on-diff off.
  assert.match(dogfoodYml, /steps\.removed\.outcome }}' = 'failure'/);
});

test('composite action hard-gates on unacknowledged navigable removals in both modes', () => {
  // Reads the inventory verdict the diff writes, and fails when a removal is unacknowledged
  // — independent of the style-approval box; on by default (config can opt out).
  assert.match(actionYml, /--json styleproof-diff\.json/);
  const gate = actionYml.match(
    /- name: Block on unacknowledged navigable removals[\s\S]*?(?=\n\s{4}- name:|\n\s{4}- id:|$)/,
  );
  assert.ok(gate, 'action.yml should include the inventory removal gate step');
  assert.match(gate[0], /gate-inventory-removals != 'false'/);
  assert.match(gate[0], /inventory\?\.unacknowledged/);
  assert.match(gate[0], /exit 1/);
  assert.doesNotMatch(gate[0], /require-approval/, 'the removal gate must fire in BOTH modes');
});

test('composite action requires approval for new-surface-only reports', () => {
  const diffStep = actionYml.match(/- id: diff[\s\S]*?(?=\n\s{4}#|\n\s{4}- id:|\n\s{4}- name:)/);

  assert.ok(diffStep, 'action.yml should include a diff step');
  assert.match(diffStep[0], /\[ "\$code" -eq 1 \] \|\| \[ "\$code" -eq 3 \]/);
  assert.match(diffStep[0], /echo "changed=true"/);
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
