import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const actionYml = fs.readFileSync(path.join(here, '..', 'action.yml'), 'utf8');
const dogfoodYml = fs.readFileSync(path.join(here, '..', '.github/workflows/action-dogfood.yml'), 'utf8');

function extractActionStep(stepStartPattern, stepEndPattern) {
  return actionYml.match(new RegExp(`${stepStartPattern}[\\s\\S]*?(?=${stepEndPattern})`));
}

test('composite action builds its checkout before running local bins', () => {
  const installStep = actionYml.match(/- name: Install StyleProof action runtime[\s\S]*?(?=\n\s{4}#|\n\s{4}- id:)/);

  assert.ok(installStep, 'action.yml should include an action runtime install step');
  assert.match(installStep[0], /npm ci --ignore-scripts/);
  assert.match(installStep[0], /npm run build/);
  assert.doesNotMatch(installStep[0], /npm ci .*--omit=dev/);
});

test('composite action publishes a durable no-change report on a clean first run', () => {
  const publishStep = extractActionStep('- id: publish', '\\n\\s{4}- name: Upsert PR comment');
  const commentStep = extractActionStep('- name: Upsert PR comment', '\\n\\s{4}#|\\n\\s{4}- name:');

  assert.ok(publishStep, 'action.yml should include a report publish step');
  assert.ok(commentStep, 'action.yml should include a PR comment step');
  assert.doesNotMatch(publishStep[0], /if: steps\.diff\.outputs/);
  assert.match(publishStep[0], /rm -rf styleproof-report/);
  assert.match(publishStep[0], /styleproof-report\.mjs/);
  assert.doesNotMatch(publishStep[0], /styleproof-report\.mjs[^\n]*\|\| true/);
  assert.match(publishStep[0], /report_exit_code=\$\?/);
  assert.match(publishStep[0], /"\$report_exit_code" -ne 0.*"\$report_exit_code" -ne 1/);
  assert.match(publishStep[0], /styleproof-receipt head-sha:%s run-id:%s run-attempt:%s/);
  assert.match(commentStep[0], /const url =/);
  assert.doesNotMatch(commentStep[0], /if \(!report\)/);
  assert.doesNotMatch(
    dogfoodYml.match(/- id: clean[\s\S]*?(?=\n\s{6}- name: Assert clean output)/)[0],
    /fail-on-diff:/,
  );
});

test('certify mode fails only when the difference verdict changed', () => {
  const failOnDifferenceStep = actionYml.match(/- name: Fail on diff[\s\S]*?(?=\n\s{4}#|\n\s{4}- name:)/);

  assert.ok(failOnDifferenceStep, 'action.yml should include the certify-mode difference gate');
  assert.match(failOnDifferenceStep[0], /steps\.diff\.outputs\.changed == 'true'/);
  assert.doesNotMatch(failOnDifferenceStep[0], /steps\.diff\.outputs\.report == 'true'/);
});

test('composite action only compares explicit base/head directories', () => {
  assert.match(actionYml, /baseline-dir:[\s\S]*?required: true/);
  assert.doesNotMatch(actionYml, /base-ref:/);
  assert.doesNotMatch(actionYml, /--base-ref/);
  assert.match(actionYml, /styleproof-diff\.mjs" "\$\{\{ inputs\.baseline-dir \}\}" "\$\{\{ inputs\.fresh-dir \}\}"/);
  assert.match(actionYml, /styleproof-report\.mjs" "\$\{\{ inputs\.baseline-dir \}\}" "\$\{\{ inputs\.fresh-dir \}\}"/);
});

test('composite action publishes every generated report crop', () => {
  const publishStep = extractActionStep('- id: publish', '\\n\\s{4}- name: Upsert PR comment');

  assert.ok(publishStep, 'action.yml should include a report publish step');
  assert.match(publishStep[0], /cp styleproof-report\/crops\/\*\.png "\$TMP\/\$REPORT_PATH\/crops\/"/);
  assert.doesNotMatch(publishStep[0], /\*-composite\.png.*\*-annotated\.png.*\*-new\.png/);
});

test('composite action binds report commits and links to the exact report revision', () => {
  const publishStep = extractActionStep('- id: publish', '\\n\\s{4}- name: Upsert PR comment');

  assert.ok(publishStep, 'action.yml should include a report publish step');
  assert.match(publishStep[0], /REPORT_SHA='\$\{\{ steps\.context\.outputs\.head-sha \}\}'/);
  assert.match(publishStep[0], /REPORT_MSG="StyleProof report \$\{REPORT_PATH\} @ \$\{REPORT_SHA\}"/);
  assert.match(publishStep[0], /git -C "\$TMP" log -1 --format=%B \| grep -Fqx "\$REPORT_MSG"/);
  assert.match(publishStep[0], /REPORT_COMMIT="\$\(git -C "\$TMP" rev-parse HEAD\)"/);
  assert.match(publishStep[0], /blob\/\$\{REPORT_COMMIT\}\/\$\{REPORT_PATH\}\/report\.md/);
});

test('composite action marks certify-mode comments with their source head SHA', () => {
  const commentStep = extractActionStep('- name: Upsert PR comment', '\\n\\s{4}#|\\n\\s{4}- name:');

  assert.ok(commentStep, 'action.yml should include a PR comment step');
  assert.match(commentStep[0], /\.\.\.\(headSha \? \[`<!-- styleproof-sha:\$\{headSha\} -->`\] : \[\]\)/);
});

test('dogfood workflow runs the local composite action against clean, changed, new-surface, and removal maps', () => {
  assert.match(dogfoodYml, /uses: \.\/\n/g);
  assert.equal(dogfoodYml.match(/uses: \.\//g)?.length, 4);
  assert.match(dogfoodYml, /action-dogfood\/clean-base/);
  assert.match(dogfoodYml, /action-dogfood\/changed-base/);
  assert.match(dogfoodYml, /action-dogfood\/new-base/);
  assert.match(dogfoodYml, /action-dogfood\/removed-base/);
  assert.match(dogfoodYml, /steps\.clean\.outputs\.report-url }}'/);
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
  assert.match(gate[0], /i\.unacknowledged/);
  assert.match(gate[0], /staleAcknowledgements/, 'stale acknowledgements gate too — the ledger must not rot');
  assert.match(gate[0], /exit 1/);
  assert.doesNotMatch(gate[0], /require-approval/, 'the removal gate must fire in BOTH modes');
});

test('composite action fails closed on unexpected diff exit codes', () => {
  // A node crash / OOM / SIGTERM (127/137/143/…) must never read as "no changes".
  const diffStep = actionYml.match(/- id: diff[\s\S]*?(?=\n\s{4}- id:|\n\s{4}- name:)/);
  assert.ok(diffStep, 'action.yml should include the diff step');
  assert.match(diffStep[0], /-ne 0.*-ne 1.*-ne 3|failing closed/s, 'unexpected exit codes hard-fail');
});

test('composite action hard-gates certification failures the approve box cannot clear', () => {
  const gate = actionYml.match(
    /- name: Block on unapprovable certification failures[\s\S]*?(?=\n\s{4}- name:|\n\s{4}- id:|$)/,
  );
  assert.ok(gate, 'action.yml should include the provenance gate step');
  assert.match(gate[0], /coverage\?\.basis === 'incomplete'/);
  assert.match(gate[0], /determinism\?\.status === 'unproven'/);
  assert.match(gate[0], /dataResidue\?\.blocking/);
  assert.match(gate[0], /exit 1/);
  assert.doesNotMatch(gate[0], /require-approval/, 'the provenance gate must fire in BOTH modes');
});

test('composite action blocks unapproved changes by default (opt out with "blocking": false)', () => {
  // The policy default flipped in v4: absent/blank config → blocking ON, so the config
  // step emits 'true' unless the file explicitly sets "blocking": false.
  const configStep = actionYml.match(/- id: config[\s\S]*?(?=\n\s{4}- id:|\n\s{4}- name:)/);

  assert.ok(configStep, 'action.yml should include a config step');
  assert.match(
    configStep[0],
    /core\.setOutput\('blocking', cfg\.blocking === false \? 'false' : 'true'\);/,
    'blocking must default to true — only an explicit false opts out',
  );

  // The block step fails the job on UNAPPROVED review-gate changes, so a repo without a
  // branch-protection rule still gets a red check out of the box.
  const blockStep = actionYml.match(/- name: Block on unapproved changes[\s\S]*?(?=\n\s{4}- name:|\n\s{4}- id:|$)/);
  assert.ok(blockStep, 'action.yml should include the unapproved-changes block step');
  assert.match(blockStep[0], /inputs\.require-approval == 'true'/);
  assert.match(blockStep[0], /steps\.config\.outputs\.blocking == 'true'/);
  assert.match(blockStep[0], /steps\.diff\.outputs\.changed == 'true'/);
  assert.match(blockStep[0], /steps\.gate\.outputs\.approved != 'true'/);
  assert.match(blockStep[0], /exit 1/);

  // An APPROVED change must NOT hit the block step (approved != 'true' guards it), and
  // certify mode is untouched — the block step is review-gate only.
  assert.doesNotMatch(blockStep[0], /fail-on-diff/);
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
  assert.match(dogfoodYml, /blob\/\[0-9a-f\]\{40\}\/\$\{report_path\}/);
  assert.ok(dogfoodYml.includes('/issues/${PR_NUMBER}/comments'));
  assert.ok(dogfoodYml.includes('/contents/${report_path}?ref=${REPORT_BRANCH}'));
});
