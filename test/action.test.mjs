import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const actionYml = fs.readFileSync(path.join(here, '..', 'action.yml'), 'utf8');
const dogfoodYml = fs.readFileSync(path.join(here, '..', '.github/workflows/action-dogfood.yml'), 'utf8');
const publishBin = fs.readFileSync(path.join(here, '..', 'bin', 'styleproof-publish-report.mjs'), 'utf8');
const publishModule = fs.readFileSync(path.join(here, '..', 'src', 'report-publish.ts'), 'utf8');

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
  // The run receipt is embedded by the API publisher before upload.
  assert.match(publishStep[0], /styleproof-publish-report\.mjs/);
  assert.match(publishBin, /styleproof-receipt head-sha:\$\{options\['head-sha'\]\} run-id:\$\{options\['run-id'\]\} run-attempt:\$\{options\['run-attempt'\]\}/);
  assert.match(commentStep[0], /const url =/);
  assert.doesNotMatch(commentStep[0], /if \(!report\)/);
  assert.doesNotMatch(
    dogfoodYml.match(/- id: clean[\s\S]*?(?=\n\s{6}- name: Assert clean output)/)[0],
    /fail-on-diff:/,
  );
});

test('composite action never clones the report branch to publish', () => {
  const publishStep = extractActionStep('- id: publish', '\\n\\s{4}- name: Upsert PR comment');

  assert.ok(publishStep, 'action.yml should include a report publish step');
  // Cloning makes publish cost the size of the whole branch and dies once the
  // branch reaches a few GB; the API publisher costs the size of this report.
  assert.doesNotMatch(publishStep[0], /git clone/);
  assert.doesNotMatch(publishStep[0], /git push/);
  // Transient API failures and the fast-forward race stay inside a bounded
  // retry loop in the publisher module.
  assert.match(publishModule, /maximumAttempts \?\? 5/);
  assert.match(publishModule, /force: false/);
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
  // collectReportFiles takes every crops/*.png, not a hardcoded suffix list.
  assert.match(publishBin, /collectReportFiles/);
  assert.match(publishModule, /cropFileName\.endsWith\('\.png'\)/);
  assert.doesNotMatch(publishModule, /-composite\.png|-annotated\.png|-new\.png/);
});

test('composite action binds report commits and links to the exact report revision', () => {
  const publishStep = extractActionStep('- id: publish', '\\n\\s{4}- name: Upsert PR comment');

  assert.ok(publishStep, 'action.yml should include a report publish step');
  assert.match(publishStep[0], /REPORT_SHA='\$\{\{ steps\.context\.outputs\.head-sha \}\}'/);
  // The commit message binds the folder to the exact head SHA, and the
  // advertised links pin the exact published commit.
  assert.match(publishBin, /StyleProof report \$\{options\['report-path'\]\} @ \$\{options\['head-sha'\]\}/);
  assert.match(publishBin, /blob\/\$\{commitSha\}\/\$\{options\['report-path'\]\}\/report\.md/);
  assert.match(publishBin, /raw\.githubusercontent\.com\/\$\{options\.repository\}\/\$\{commitSha\}/);
});

test('composite action marks certify-mode comments with their source head SHA', () => {
  const commentStep = extractActionStep('- name: Upsert PR comment', '\\n\\s{4}#|\\n\\s{4}- name:');

  assert.ok(commentStep, 'action.yml should include a PR comment step');
  assert.match(commentStep[0], /\.\.\.\(headSha \? \[`<!-- styleproof-sha:\$\{headSha\} -->`\] : \[\]\)/);
});

test('dogfood workflow runs the local composite action against every trust-state class', () => {
  assert.match(dogfoodYml, /uses: \.\/\n/g);
  assert.equal(dogfoodYml.match(/uses: \.\//g)?.length, 8);
  assert.match(dogfoodYml, /action-dogfood\/clean-base/);
  assert.match(dogfoodYml, /action-dogfood\/changed-base/);
  assert.match(dogfoodYml, /action-dogfood\/new-base/);
  assert.match(dogfoodYml, /action-dogfood\/residue-base/);
  assert.match(dogfoodYml, /action-dogfood\/removed-base/);
  assert.match(dogfoodYml, /action-dogfood\/degraded-base/);
  assert.match(dogfoodYml, /steps\.clean\.outputs\.report-url }}'/);
  assert.match(dogfoodYml, /steps\.changed\.outputs\.changed }}' = 'true'/);
  assert.match(dogfoodYml, /steps\.new-surface\.outputs\.changed }}' = 'true'/);
  assert.match(dogfoodYml, /steps\.clean\.outputs\.trust-state }}' = 'NO_VISUAL_CHANGES'/);
  assert.match(dogfoodYml, /steps\.changed\.outputs\.trust-state }}' = 'VISUAL_APPROVAL_REQUIRED'/);
  assert.match(dogfoodYml, /steps\.residue\.outputs\.trust-state }}' = 'DATA_RESIDUE_UNACKNOWLEDGED'/);
  assert.match(dogfoodYml, /action-dogfood\/partial-base/);
  assert.match(dogfoodYml, /steps\.partial-baseline\.outputs\.trust-state }}' = 'PARTIAL_BASELINE'/);
  assert.match(dogfoodYml, /steps\.degraded\.outputs\.trust-state }}' = 'DEGRADED_BASELINE'/);
  // The inventory removal must FAIL the action even with fail-on-diff off.
  assert.match(dogfoodYml, /steps\.removed\.outcome }}' = 'failure'/);
  assert.match(dogfoodYml, /steps\.removed\.outputs\.trust-state }}' = 'INVENTORY_REMOVAL_UNACKNOWLEDGED'/);
  // Unproven provenance is dogfooded end-to-end as CERTIFICATION_FAILED — the
  // state 4.6.2's content-geometry bug hid in, undetected because it was never
  // exercised here.
  assert.match(dogfoodYml, /action-dogfood\/certfail-base/);
  assert.match(dogfoodYml, /steps\.certfail\.outputs\.trust-state }}' = 'CERTIFICATION_FAILED'/);
  assert.match(dogfoodYml, /steps\.certfail\.outcome }}' = 'failure'/);
});

test('composite action exposes one precedence-ordered machine-readable trust verdict', () => {
  assert.match(actionYml, /trust-state:[\s\S]*?steps\.trust\.outputs\.state/);
  assert.match(actionYml, /data-residue-keys:[\s\S]*?steps\.verdict\.outputs\.data-residue-keys/);
  const verdict = actionYml.match(/- id: verdict[\s\S]*?(?=\n\s{4}- id:|\n\s{4}- name:|\n\s{4}#)/);
  assert.ok(verdict, 'action.yml should classify the diff before approval/status logic');
  const residue = verdict[0].indexOf('DATA_RESIDUE_UNACKNOWLEDGED');
  const inventory = verdict[0].indexOf('INVENTORY_REMOVAL_UNACKNOWLEDGED');
  const certification = verdict[0].indexOf('CERTIFICATION_FAILED');
  const partial = verdict[0].indexOf('PARTIAL_BASELINE');
  const degraded = verdict[0].indexOf('DEGRADED_BASELINE');
  const visual = verdict[0].indexOf('VISUAL_APPROVAL_REQUIRED');
  assert.ok(
    residue > 0 &&
      inventory > residue &&
      certification > inventory &&
      partial > certification &&
      degraded > partial &&
      visual > degraded,
  );
  // The verdict's degraded-baseline check must accept the same values the
  // GitHub-expression gate downstream accepts (case-insensitive 'true').
  assert.match(verdict[0], /base-capture-failed[^\n]*\.toLowerCase\(\) === 'true'/);
  const terminal = actionYml.match(/- id: trust[\s\S]*$/);
  assert.ok(terminal, 'action.yml should always expose a terminal trust state');
  assert.match(terminal[0], /if: always\(\)/);
  assert.match(terminal[0], /REPORT_PUBLICATION_FAILED/);
  // The trust step names failure DOMAINS, not just "publish wasn't success":
  // publish failure and delivery (comment/status) failure both mean the reviewer
  // may be looking at a stale or absent report; a merely-skipped publish must NOT
  // masquerade as a publication failure.
  assert.match(terminal[0], /publishOutcome === 'failure'/);
  assert.match(terminal[0], /publishOutcome !== 'success'/);
  assert.match(terminal[0], /steps\.comment\.outcome/);
  assert.match(terminal[0], /steps\.status\.outcome/);
  assert.match(actionYml, /- name: Upsert PR comment\n\s+id: comment/);
  assert.match(actionYml, /- name: Set review status\n\s+id: status/);
});

test('composite action hard-gates partial baseline repair debt', () => {
  assert.match(actionYml, /PARTIAL_BASELINE/);
  const gate = actionYml.match(/- name: Block on partial baseline[\s\S]*?(?=\n\s{4}- name:|\n\s{4}- id:|$)/);
  assert.ok(gate, 'action.yml should fail rather than certify ledger-explained baseline gaps');
  assert.match(gate[0], /verdict\.outputs\.state == 'PARTIAL_BASELINE'/);
  assert.match(gate[0], /exit 1/);
  assert.doesNotMatch(gate[0], /require-approval/, 'visual approval cannot clear partial baseline');
});

test('composite action exposes and hard-gates degraded head-only evidence', () => {
  assert.match(actionYml, /base-capture-failed:[\s\S]*?default: 'false'/);
  assert.match(actionYml, /DEGRADED_BASELINE/);
  const gate = actionYml.match(/- name: Block on degraded baseline[\s\S]*?(?=\n\s{4}- name:|\n\s{4}- id:|$)/);
  assert.ok(gate, 'action.yml should fail rather than certify a head-only report');
  assert.match(gate[0], /inputs\.base-capture-failed == 'true'/);
  assert.match(gate[0], /exit 1/);
  assert.doesNotMatch(gate[0], /require-approval/, 'visual approval cannot turn degraded evidence into a comparison');
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
  assert.match(gate[0], /reportConsistency/, 'raw-only report/diff contradiction hard-gates');
  assert.match(gate[0], /exit 1/);
  assert.doesNotMatch(gate[0], /require-approval/, 'the provenance gate must fire in BOTH modes');
});

test('composite action maps raw-only report inconsistency to CERTIFICATION_FAILED not visual approval', () => {
  const verdict = actionYml.match(/- id: verdict[\s\S]*?(?=\n\s{4}- id:|\n\s{4}- name:|\n\s{4}#)/);
  assert.ok(verdict, 'action.yml should classify the diff before approval/status logic');
  assert.match(verdict[0], /reportConsistency/);
  assert.match(verdict[0], /rawOnlyNoReviewable|raw_only_no_reviewable/);
  // Assignment order: raw-only shares the CERTIFICATION_FAILED branch, which must
  // appear before the VISUAL_APPROVAL_REQUIRED assignment (state = '…' only).
  const certAssign = verdict[0].indexOf("state = 'CERTIFICATION_FAILED'");
  const visualAssign = verdict[0].indexOf("state = 'VISUAL_APPROVAL_REQUIRED'");
  assert.ok(
    certAssign > 0 && visualAssign > certAssign,
    'CERTIFICATION_FAILED assignment must outrank visual approval',
  );
  assert.match(verdict[0], /rawOnlyNoReviewable\) state = 'CERTIFICATION_FAILED'/);
  // Approval checkbox only for VISUAL_APPROVAL_REQUIRED — never for consistency failure.
  const commentStep = extractActionStep('- name: Upsert PR comment', '\\n\\s{4}#|\\n\\s{4}- name:');
  assert.ok(commentStep, 'PR comment step present');
  assert.match(commentStep[0], /trustState === 'VISUAL_APPROVAL_REQUIRED'/);
  assert.match(commentStep[0], /report\/diff consistency|reflow source/i);
});

test('composite action blocks unapproved changes by default (opt out with "blocking": false)', () => {
  // The policy default flipped in v4: absent/blank config → blocking ON, so the config
  // step emits 'true' unless the file explicitly sets "blocking": false.
  const configStep = actionYml.match(/- id: config[\s\S]*?(?=\n\s{4}- id:|\n\s{4}- name:)/);

  assert.ok(configStep, 'action.yml should include a config step');
  assert.match(configStep[0], /loadStyleProofConfig/);
  assert.doesNotMatch(configStep[0], /ignoring unreadable styleproof\.config\.json/);
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
  assert.match(blockStep[0], /steps\.verdict\.outputs\.state == 'VISUAL_APPROVAL_REQUIRED'/);
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

test('composite action self-verifies the published receipt before advertising the report URL', () => {
  const publishStep = extractActionStep('- id: publish', '\n\\s{4}- name: Upsert PR comment');

  assert.ok(publishStep, 'action.yml should include a report publish step');
  // The read-back: fetch the report at the EXACT commit being advertised and
  // require the receipt embedded for this run (head SHA + run id + attempt).
  assert.match(publishModule, /application\/vnd\.github\.raw/);
  assert.match(publishModule, /report\.md\?ref=\$\{options\.commitSha\}/);
  assert.match(publishModule, /published\.includes\(options\.expectedReceipt\)/);
  // Fail CLOSED on a dead or mismatched report — never a green run with a bad URL.
  assert.match(publishModule, /do not trust this run's report/);
  // The url/raw-base outputs exist ONLY once verification passed.
  const verifiedIndex = publishBin.indexOf('await verifyPublishedReceipt(');
  const urlIndex = publishBin.indexOf('url=https://github.com/');
  assert.ok(verifiedIndex > 0 && urlIndex > verifiedIndex, 'outputs are written only after the receipt verifies');
});

test('composite action retries transient GitHub API failures on networked github-script steps', () => {
  const networkedSteps = [
    /- id: context[\s\S]*?github-token:[^\n]+\n\s+retries: 3/,
    /- id: gate[\s\S]*?github-token:[^\n]+\n\s+retries: 3/,
    /- name: Upsert PR comment[\s\S]*?github-token:[^\n]+\n\s+retries: 3/,
    /- name: Set review status[\s\S]*?github-token:[^\n]+\n\s+retries: 3/,
  ];
  for (const pattern of networkedSteps) assert.match(actionYml, pattern);
});

test('composite action verdict honors the gateInventoryRemovals opt-out end to end', () => {
  const verdict = extractActionStep('- id: verdict', '\n\\s{4}- id:|\n\\s{4}- name:');
  assert.ok(verdict, 'action.yml should include the verdict step');
  // The opt-out must reach the CLASSIFICATION, not just the job-fail step:
  // without it the commit status stayed an unclearable red (the approval box is
  // only rendered for VISUAL_APPROVAL_REQUIRED).
  assert.match(verdict[0], /steps\.config\.outputs\.gate-inventory-removals/);
  assert.match(
    verdict[0],
    /gateInventoryRemovals\s*\n?\s*\? \(diff\.inventory|gateInventoryRemovals[\s\S]{0,120}inventory/,
  );
});
