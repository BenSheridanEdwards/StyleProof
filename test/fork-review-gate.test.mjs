import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Fork PRs never auto-green. In the capture/report split, the untrusted
 * `pull_request` capture job uploads BOTH map sets, so a fork can upload identical
 * maps and read as "no changes". These tests execute the Action's real status and
 * comment programs from action.yml: a fork capture must post a pending status and
 * an approval box, while same-repo behaviour stays exactly as before.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const actionYml = fs.readFileSync(path.join(root, 'action.yml'), 'utf8');
const nativeRequire = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const HEAD_SHA = 'c'.repeat(40);
const REPOSITORY = 'acme/app';
const ARTIFACT_URL = `https://github.com/${REPOSITORY}/actions/runs/9001/artifacts/77`;
const UNTRUSTED_DESCRIPTION = 'Fork PR — maps captured in an untrusted job; maintainer approval required';

/** Compile one github-script step with its env: block, substituting every expression. */
function stepProgram(stepName, values) {
  const step = actionYml.match(new RegExp(`- name: ${stepName}\\n[\\s\\S]*?(?=\\n {4}#|\\n {4}- name:|\\n {4}- id:)`));
  assert.ok(step, `action.yml should contain the ${stepName} step`);
  const resolve = (expression) => {
    assert.ok(Object.hasOwn(values, expression), `no test value for \${{ ${expression} }}`);
    return values[expression];
  };
  const environment = {};
  const envBlock = step[0].match(/\n {6}env:\n([\s\S]*?)\n {6}with:/);
  for (const [, name, expression] of envBlock?.[1].matchAll(/^ {8}([A-Z_]+): \$\{\{ (.+?) \}\}$/gm) ?? []) {
    environment[name] = resolve(expression);
  }
  const script = step[0]
    .match(/script: \|\n([\s\S]*)$/)[1]
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n')
    .replace(/\$\{\{ (.+?) \}\}/g, (_, expression) => resolve(expression));
  return { environment, program: new AsyncFunction('require', 'github', 'context', 'core', script) };
}

function values({ untrusted, trustState, changed, approved = false, mode = 'review-gate' }) {
  return {
    'steps.context.outputs.pr-number': '42',
    'steps.context.outputs.head-sha': HEAD_SHA,
    'steps.context.outputs.untrusted-capture': untrusted ? 'true' : 'false',
    'steps.diff.outputs.changed': changed ? 'true' : 'false',
    'steps.gate.outputs.approved': approved ? 'true' : 'false',
    'steps.gate.outputs.approver': approved ? 'maintainer' : '',
    'steps.verdict.outputs.state': trustState,
    'steps.config.outputs.blocking': 'true',
    'steps.publish.outputs.url || steps.report-artifact.outputs.artifact-url': ARTIFACT_URL,
    'steps.report-artifact.outputs.artifact-digest': 'd'.repeat(64),
    'steps.publish.outputs.sha': '',
    'steps.report.outputs.content-changes': '0',
    'toJSON(inputs.comment-marker)': JSON.stringify('<!-- styleproof-report -->'),
    'github.run_id': '9001',
    'github.run_attempt': '1',
    'inputs.mode': mode,
    'inputs.status-context': 'StyleProof',
    'inputs.base-capture-failed': 'false',
    'inputs.report-storage': 'artifact',
    'inputs.require-approval': 'false',
    'inputs.include-content': 'false',
    'inputs.report-retention-days': '30',
  };
}

async function run(stepName, scenario) {
  const { environment, program } = stepProgram(stepName, values(scenario));
  const statuses = [];
  const comments = [];
  const github = {
    rest: {
      repos: { createCommitStatus: async (input) => statuses.push(input) },
      issues: {
        listComments: async () => ({ data: [] }),
        createComment: async (input) => comments.push(input),
        updateComment: async () => assert.fail('unexpected comment update'),
      },
    },
  };
  const context = { repo: { owner: 'acme', repo: 'app' }, runId: 9001, payload: { repository: { private: false } } };
  const core = { setOutput() {}, info() {} };
  const requireForScript = (specifier) => (specifier === 'fs' ? { existsSync: () => false } : nativeRequire(specifier));
  const previous = { ...process.env };
  Object.assign(process.env, environment, { GITHUB_ACTION_PATH: root });
  try {
    await program(requireForScript, github, context, core);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
  return { statuses, comments };
}

const APPROVE_BOX = /^- \[ \] \*\*Approve all changes\*\*$/m;

test('a fork capture with identical maps is pending, never auto-green, and carries the approval box', async () => {
  for (const mode of ['review-gate', 'migration', 'advisory']) {
    const scenario = { untrusted: true, trustState: 'NO_REVIEWABLE_STYLE_CHANGES', changed: false, mode };
    const { statuses } = await run('Set review status', scenario);
    assert.deepEqual(statuses, [
      {
        owner: 'acme',
        repo: 'app',
        sha: HEAD_SHA,
        context: 'StyleProof',
        state: 'pending',
        description: UNTRUSTED_DESCRIPTION,
        target_url: ARTIFACT_URL,
      },
    ]);
    const { comments } = await run('Upsert PR comment', scenario);
    assert.equal(comments.length, 1);
    assert.match(comments[0].body, APPROVE_BOX, `${mode}: a maintainer needs the box to sign off`);
    assert.match(comments[0].body, /Fork PR — these maps were captured in an untrusted job/);
    assert.doesNotMatch(comments[0].body, /check is green|check remains green/);
  }
});

test('a fork capture with changes is pending until a maintainer approves it', async () => {
  const scenario = { untrusted: true, trustState: 'STYLE_REVIEW_REQUIRED', changed: true };
  const { statuses } = await run('Set review status', scenario);
  assert.equal(statuses[0].state, 'pending');
  assert.equal(statuses[0].description, UNTRUSTED_DESCRIPTION);
  const approved = await run('Set review status', { ...scenario, approved: true });
  assert.equal(approved.statuses[0].state, 'success', 'only a maintainer approval turns a fork green');
  const cleanApproved = await run('Set review status', {
    untrusted: true,
    trustState: 'NO_REVIEWABLE_STYLE_CHANGES',
    changed: false,
    approved: true,
  });
  assert.deepEqual(
    { state: cleanApproved.statuses[0].state, description: cleanApproved.statuses[0].description },
    { state: 'success', description: 'StyleProof changes approved' },
  );
});

test('a fork certification failure stays red and unapprovable', async () => {
  const scenario = { untrusted: true, trustState: 'CERTIFICATION_FAILED', changed: false };
  const { statuses } = await run('Set review status', scenario);
  assert.equal(statuses[0].state, 'failure');
  const { comments } = await run('Upsert PR comment', scenario);
  assert.doesNotMatch(comments[0].body, APPROVE_BOX);
});

test('same-repo verdicts are unchanged: clean is green with no box, changes are red with the box', async () => {
  const clean = { untrusted: false, trustState: 'NO_REVIEWABLE_STYLE_CHANGES', changed: false };
  const cleanStatus = await run('Set review status', clean);
  assert.deepEqual(
    { state: cleanStatus.statuses[0].state, description: cleanStatus.statuses[0].description },
    { state: 'success', description: 'No reviewable computed-style changes' },
  );
  assert.equal(cleanStatus.statuses[0].target_url, undefined);
  const cleanComment = await run('Upsert PR comment', clean);
  assert.doesNotMatch(cleanComment.comments[0].body, APPROVE_BOX);
  assert.doesNotMatch(cleanComment.comments[0].body, /Fork PR/);

  const changed = { untrusted: false, trustState: 'STYLE_REVIEW_REQUIRED', changed: true };
  const changedStatus = await run('Set review status', changed);
  assert.equal(changedStatus.statuses[0].state, 'failure');
  assert.equal(
    changedStatus.statuses[0].description,
    'StyleProof changes need sign-off — tick the box in the report comment',
  );
  const changedComment = await run('Upsert PR comment', changed);
  assert.match(changedComment.comments[0].body, APPROVE_BOX);

  const advisory = await run('Set review status', { ...clean, mode: 'advisory' });
  assert.equal(advisory.statuses[0].state, 'success');
});

test('the verdict step records the trusted untrusted-capture flag and the gate reads fork approvals', () => {
  const verdictStep = actionYml.match(/- id: verdict[\s\S]*?(?=\n {4}#|\n {4}- id:|\n {4}- name:)/)[0];
  assert.match(verdictStep, /STYLEPROOF_UNTRUSTED_CAPTURE: \$\{\{ steps\.context\.outputs\.untrusted-capture \}\}/);
  assert.match(verdictStep, /report\.untrustedCapture = process\.env\.STYLEPROOF_UNTRUSTED_CAPTURE === 'true';/);
  const gateStep = actionYml.match(/- id: gate[\s\S]*?(?=\n {4}#|\n {4}- id:|\n {4}- name:)/)[0];
  assert.match(gateStep, /if \(changed \|\| untrustedCapture\)/);
  assert.match(gateStep, /inputs\.mode == 'advisory'/);
  const contextStep = actionYml.match(/- id: context[\s\S]*?(?=\n {4}#|\n {4}- id:)/)[0];
  assert.match(contextStep, /core\.setOutput\('untrusted-capture', resolved && untrustedCapture \? 'true' : 'false'\)/);
});
