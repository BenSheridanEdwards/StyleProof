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
const MARKER = '<!-- styleproof-report -->';

/** Compile one github-script step with its env: block, substituting every expression. */
function stepProgram(stepName, values) {
  const step = actionYml.match(
    new RegExp(`- (?:name|id): ${stepName}\\n[\\s\\S]*?(?=\\n {4}#|\\n {4}- name:|\\n {4}- id:|$)`),
  );
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

/** Evaluate a step's real `if:` (the ==, !=, &&, || subset action.yml uses) against test values. */
function stepRuns(stepName, scenario) {
  const step = actionYml.match(
    new RegExp(`- name: ${stepName}\\n[\\s\\S]*?(?=\\n {4}#|\\n {4}- name:|\\n {4}- id:|$)`),
  );
  assert.ok(step, `action.yml should contain the ${stepName} step`);
  const condition = step[0].match(/\n {6}if: >-\n([\s\S]*?)\n {6}(?:uses|shell):/)[1];
  const given = values(scenario);
  const expression = condition
    .replace(/always\(\)/g, 'true')
    .replace(/failure\(\)/g, String(scenario.failed === true))
    .replace(/success\(\)/g, String(!scenario.failed))
    .replace(/'([^']*)'|([a-z_]+(?:\.[\w-]+)+)/g, (_, literal, name) => {
      if (literal !== undefined) return JSON.stringify(literal);
      assert.ok(Object.hasOwn(given, name), `no test value for ${name} in the ${stepName} if:`);
      return JSON.stringify(given[name]);
    });
  return new Function(`return ${expression};`)();
}

function values({
  untrusted,
  trustState,
  changed,
  approved = false,
  approver = 'maintainer',
  mode = 'review-gate',
  runAttempt = '1',
  event = 'pull_request',
  failOnDiff = true,
  requireApproval = false,
  staleDelivery = 'false',
  pendingSuperseded = 'false',
  statusSuperseded = 'false',
  statusState = '',
  statusOutcome = '',
  trust,
  failed = false,
  runSucceeded = !failed,
}) {
  return {
    'steps.certify-success.outputs.succeeded': runSucceeded ? 'true' : '',
    'github.event_name': event,
    'inputs.fail-on-diff': failOnDiff ? 'true' : 'false',
    'steps.comment.outputs.stale-delivery': staleDelivery,
    'steps.certify-pending.outputs.superseded': pendingSuperseded,
    'steps.status.outputs.superseded': statusSuperseded,
    'steps.status.outputs.state': statusState,
    'steps.status.outcome': statusOutcome,
    'steps.trust.outputs.state': trust ?? trustState,
    'steps.context.outputs.pr-number': '42',
    'steps.context.outputs.head-sha': HEAD_SHA,
    'steps.context.outputs.untrusted-capture': untrusted ? 'true' : 'false',
    'steps.diff.outputs.changed': changed ? 'true' : 'false',
    'steps.gate.outputs.approved': approved ? 'true' : 'false',
    'steps.gate.outputs.approver': approved ? approver : '',
    'steps.verdict.outputs.state': trustState,
    'steps.config.outputs.blocking': 'true',
    'steps.publish.outputs.url || steps.report-artifact.outputs.artifact-url': ARTIFACT_URL,
    'steps.report-artifact.outputs.artifact-digest': 'd'.repeat(64),
    'steps.publish.outputs.sha': '',
    'steps.report.outputs.content-changes': '0',
    'toJSON(inputs.comment-marker)': JSON.stringify(MARKER),
    'github.run_id': '9001',
    'github.run_attempt': runAttempt,
    'inputs.mode': mode,
    'inputs.status-context': 'StyleProof',
    'inputs.base-capture-failed': 'false',
    'inputs.report-storage': 'artifact',
    'inputs.require-approval': requireApproval ? 'true' : 'false',
    "inputs.fail-on-diff == 'true' && inputs.require-approval != 'true' && inputs.mode == 'certify'":
      failOnDiff && !requireApproval && mode === 'certify' ? 'true' : 'false',
    'inputs.include-content': 'false',
    'inputs.report-retention-days': '30',
  };
}

/** `prior` is what GitHub already holds for HEAD_SHA, newest first. */
async function run(stepName, scenario, prior = [], thread = []) {
  const { environment, program } = stepProgram(stepName, values(scenario));
  const statuses = scenario.statuses ?? [];
  const comments = [];
  const updated = [];
  const outputs = {};
  const runsLookups = [];
  const workflowRun = {
    id: 500,
    run_attempt: 1,
    created_at: '2026-10-20T10:00:00Z',
    workflow_id: 7,
    head_sha: HEAD_SHA,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    ...scenario.workflowRun,
  };
  const github = {
    paginate: async (route, params) => (await route(params)).data,
    rest: {
      actions: {
        listWorkflowRuns: async (input) => {
          runsLookups.push(input);
          assert.notEqual(scenario.forbidRunsLookup, true, 'capture ordering is certify-only');
          if (scenario.runsLookupError) throw new Error('capture run lookup unavailable');
          const workflowRuns = scenario.workflowRuns ?? [workflowRun];
          return { data: { total_count: scenario.totalCount ?? workflowRuns.length, workflow_runs: workflowRuns } };
        },
      },
      repos: {
        createCommitStatus: async (input) => {
          await scenario.beforeStatusWrite?.(input);
          statuses.push(input);
        },
        listCommitStatusesForRef: async () => ({ data: prior }),
      },
      issues: {
        listComments: async () => ({ data: thread }),
        createComment: async (input) => comments.push(input),
        updateComment: async (input) => {
          assert.ok(
            thread.some(({ id }) => id === input.comment_id),
            'unexpected comment update',
          );
          updated.push(input);
        },
      },
    },
  };
  const context = {
    repo: { owner: 'acme', repo: 'app' },
    runId: 9001,
    eventName: scenario.event ?? 'pull_request',
    payload: { repository: { private: false }, workflow_run: workflowRun },
  };
  const core = { setOutput: (name, value) => (outputs[name] = value), info() {}, warning() {} };
  const requireForScript = (specifier) => (specifier === 'fs' ? { existsSync: () => false } : nativeRequire(specifier));
  const previous = { ...process.env };
  Object.assign(process.env, environment, { GITHUB_ACTION_PATH: root });
  try {
    await program(requireForScript, github, context, core);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
  return { statuses, comments, updated, outputs, runsLookups };
}

/** Execute comment delivery and respect the status step's stale-delivery condition. */
async function deliver(scenario, thread) {
  const statusStep = actionYml.match(/- name: Set review status\n[\s\S]*?(?=\n {4}#|\n {4}- name:|\n {4}- id:)/);
  assert.ok(statusStep, 'action.yml should contain the Set review status step');
  assert.match(statusStep[0], /steps\.comment\.outputs\.stale-delivery != 'true'/);
  const { comments, updated, outputs } = await run('Upsert PR comment', scenario, [], thread);
  const stale = outputs['stale-delivery'] === 'true';
  const { statuses } = stale ? { statuses: [] } : await run('Set review status', scenario);
  return { comments, updated, statuses, stale };
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
    { state: 'success', description: 'Approved by @maintainer' },
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

const BOT = { login: 'github-actions[bot]', type: 'Bot' };
const receipt = (attempt) => `<!-- styleproof-run-id:9001 run-attempt:${attempt} -->`;

test('a later PAT report prevents an earlier clean attempt from writing a comment or success status', async () => {
  const result = await deliver(
    { untrusted: false, trustState: 'NO_REVIEWABLE_STYLE_CHANGES', changed: false, runAttempt: '1' },
    [
      {
        id: 5,
        user: { login: 'maintainer', type: 'User' },
        author_association: 'MEMBER',
        body: `${MARKER}\n## needs sign-off\n${receipt(2)}`,
      },
    ],
  );
  assert.deepEqual(result, { comments: [], updated: [], statuses: [], stale: true });
});

test('a newer attempt creates a report and failure status without editing an earlier PAT report', async () => {
  const result = await deliver(
    { untrusted: false, trustState: 'STYLE_REVIEW_REQUIRED', changed: true, runAttempt: '2' },
    [
      {
        id: 5,
        user: { login: 'maintainer', type: 'User' },
        author_association: 'MEMBER',
        body: `${MARKER}\n## needs sign-off\n${receipt(1)}`,
      },
    ],
  );
  assert.equal(result.comments.length, 1);
  assert.deepEqual(result.updated, []);
  assert.equal(result.statuses.length, 1);
  assert.equal(result.statuses[0].state, 'failure');
  assert.equal(result.stale, false);
});

test('forged later receipts from accounts without write access cannot suppress a review-required delivery', async () => {
  const result = await deliver(
    { untrusted: false, trustState: 'STYLE_REVIEW_REQUIRED', changed: true, runAttempt: '1' },
    ['CONTRIBUTOR', 'NONE'].map((association, index) => ({
      id: index + 1,
      user: { login: `contributor-${index}`, type: 'User' },
      author_association: association,
      body: `${MARKER}\n${receipt(99)}`,
    })),
  );
  assert.equal(result.comments.length, 1);
  assert.deepEqual(result.updated, []);
  assert.equal(result.statuses.length, 1);
  assert.equal(result.statuses[0].state, 'failure');
  assert.equal(result.stale, false);
});

test('a later bot report prevents an earlier clean attempt from writing a comment or success status', async () => {
  const result = await deliver(
    { untrusted: false, trustState: 'NO_REVIEWABLE_STYLE_CHANGES', changed: false, runAttempt: '1' },
    [{ id: 6, user: BOT, author_association: 'NONE', body: `${MARKER}\n${receipt(2)}` }],
  );
  assert.deepEqual(result, { comments: [], updated: [], statuses: [], stale: true });
});

/** A later same-repo review-gate run with changes on HEAD_SHA, which already carries `prior`. */
async function rerunWithChanges(prior) {
  const scenario = { untrusted: false, trustState: 'STYLE_REVIEW_REQUIRED', changed: true };
  const { outputs: gate } = await run('gate', scenario, [prior]);
  const { statuses } = await run('Set review status', {
    ...scenario,
    approved: gate.approved === 'true',
    approver: gate.approver,
  });
  return { gate, status: { state: statuses[0].state, description: statuses[0].description } };
}

test('a clean or advisory green on the same head SHA is not a sign-off for a later run with changes (#936)', async () => {
  const clean = await run('Set review status', {
    untrusted: false,
    trustState: 'NO_REVIEWABLE_STYLE_CHANGES',
    changed: false,
  });
  const advisory = await run('Set review status', {
    untrusted: false,
    trustState: 'STYLE_REVIEW_REQUIRED',
    changed: true,
    mode: 'advisory',
  });
  for (const [label, { statuses }] of [
    ['clean', clean],
    ['advisory', advisory],
  ]) {
    assert.equal(statuses[0].state, 'success', `${label}: the earlier run's own verdict is green`);
    assert.deepEqual(
      await rerunWithChanges({ ...statuses[0], creator: BOT }),
      {
        gate: { approved: 'false', approver: '' },
        status: {
          state: 'failure',
          description: 'StyleProof changes need sign-off — tick the box in the report comment',
        },
      },
      `${label}: nobody approved, so the changes still need sign-off`,
    );
  }
});

test('an upgrade rejects the anonymous approval left by a buggy rerun of a clean status', async () => {
  const { statuses } = await run('Set review status', {
    untrusted: false,
    trustState: 'NO_REVIEWABLE_STYLE_CHANGES',
    changed: false,
  });
  assert.equal(statuses[0].state, 'success');
  // The old gate mistook this clean green for a sign-off, then wrote this anonymous approval.
  const legacyApproval = { ...statuses[0], description: 'StyleProof changes approved', creator: BOT };
  assert.deepEqual(await rerunWithChanges(legacyApproval), {
    gate: { approved: 'false', approver: '' },
    status: {
      state: 'failure',
      description: 'StyleProof changes need sign-off — tick the box in the report comment',
    },
  });
  const fork = { untrusted: true, trustState: 'NO_REVIEWABLE_STYLE_CHANGES', changed: false };
  const { outputs: gate } = await run('gate', fork, [legacyApproval]);
  assert.deepEqual(gate, { approved: 'false', approver: '' });
  const pending = await run('Set review status', { ...fork, approved: gate.approved === 'true' });
  assert.equal(pending.statuses[0].state, 'pending');
});

test('a real sign-off on the same head SHA preserves its identity across reruns, from the canonical writer only', async () => {
  const signOff = (description, creator = BOT) => ({ context: 'StyleProof', state: 'success', description, creator });
  for (const approver of ['maintainer', 'octocat_acme']) {
    const description = `Approved by @${approver}`;
    const first = await rerunWithChanges(signOff(description));
    assert.deepEqual(first, {
      gate: { approved: 'true', approver },
      status: { state: 'success', description },
    });
    assert.deepEqual(await rerunWithChanges({ ...first.status, context: 'StyleProof', creator: BOT }), first);

    const fork = { untrusted: true, trustState: 'NO_REVIEWABLE_STYLE_CHANGES', changed: false };
    const { outputs: gate } = await run('gate', fork, [signOff(description)]);
    assert.deepEqual(gate, { approved: 'true', approver });
    const { statuses } = await run('Set review status', { ...fork, approved: gate.approved === 'true', approver });
    assert.equal(statuses[0].state, 'success');
    assert.equal(statuses[0].description, description);
    assert.deepEqual((await run('gate', fork, [{ ...statuses[0], creator: BOT }])).outputs, gate);
  }
  const foreign = await rerunWithChanges(signOff('Approved by @maintainer', { login: 'some-app[bot]', type: 'Bot' }));
  assert.deepEqual(foreign.gate, { approved: 'false', approver: '' });
});

test('a split-layout certify run puts a red StyleProof status on the PR head (#937)', async () => {
  // The inputs `styleproof-init --workflow split --mode certify` passes from its
  // workflow_run report job. That job runs on the default branch, so its own
  // "Fail on diff" failure never reaches the PR: the status is the PR's only verdict.
  const certify = { mode: 'certify', event: 'workflow_run' };
  const changed = { ...certify, untrusted: false, trustState: 'STYLE_REVIEW_REQUIRED', changed: true };
  assert.equal(stepRuns('Set review status', changed), true, 'certify from workflow_run must set the status');
  const certifyDiff = 'Style changes detected — certify mode fails on any diff';
  const changedResult = await run('Set review status', changed);
  assert.equal(changedResult.outputs.state, 'failure');
  assert.deepEqual(changedResult.statuses, [
    {
      owner: 'acme',
      repo: 'app',
      sha: HEAD_SHA,
      context: 'StyleProof',
      state: 'failure',
      description: certifyDiff,
      target_url: ARTIFACT_URL,
    },
  ]);
  // Certify allows no sign-off: neither approve workflow treats this status as approvable.
  for (const approve of ['.github/workflows/styleproof-approve-reusable.yml', 'example/styleproof-approve.yml']) {
    assert.equal(fs.readFileSync(path.join(root, approve), 'utf8').includes(certifyDiff), false, approve);
  }

  const clean = { ...certify, untrusted: false, trustState: 'NO_REVIEWABLE_STYLE_CHANGES', changed: false };
  const cleanResult = await run('Set review status', clean);
  const cleanStatus = cleanResult.statuses[0];
  assert.equal(cleanResult.outputs.state, cleanStatus.state);
  assert.deepEqual(
    { state: cleanStatus.state, description: cleanStatus.description },
    { state: 'success', description: 'No reviewable computed-style changes' },
  );
  // A fork's clean capture is only its own claim: pending, never success. A fork diff still fails.
  const forkCleanResult = await run('Set review status', { ...clean, untrusted: true });
  const forkClean = forkCleanResult.statuses[0];
  assert.equal(forkCleanResult.outputs.state, forkClean.state);
  assert.deepEqual(
    { state: forkClean.state, description: forkClean.description },
    { state: 'pending', description: UNTRUSTED_DESCRIPTION },
  );
  const forkChanged = (await run('Set review status', { ...changed, untrusted: true })).statuses[0];
  assert.deepEqual(
    { state: forkChanged.state, description: forkChanged.description },
    { state: 'failure', description: certifyDiff },
  );
  const forkFailed = { ...certify, untrusted: true, trustState: 'CERTIFICATION_FAILED', changed: false };
  assert.equal((await run('Set review status', forkFailed)).statuses[0].state, 'failure');

  // Single-workflow certify keeps its failing pull_request job as the gate, and
  // fail-on-diff: false never blocks, so neither sets the status.
  assert.equal(stepRuns('Set review status', { ...changed, event: 'pull_request' }), false);
  assert.equal(stepRuns('Set review status', { ...changed, failOnDiff: false }), false);
  // Every status-setting mode keeps setting it from either event.
  for (const mode of ['review-gate', 'migration', 'advisory'])
    for (const event of ['pull_request', 'workflow_run'])
      assert.equal(stepRuns('Set review status', { ...changed, mode, event }), true, `${mode} from ${event}`);
});

test('a failed split certify rerun cannot leave an earlier success on the PR head (#937)', async () => {
  const clean = {
    mode: 'certify',
    event: 'workflow_run',
    untrusted: false,
    trustState: 'NO_REVIEWABLE_STYLE_CHANGES',
    changed: false,
  };
  const prior = (await run('Set review status', clean)).statuses;
  assert.equal(prior[0].state, 'success');
  assert.equal(stepRuns('Mark certify status pending', clean), true);
  const pending = await run('Mark certify status pending', clean, prior);
  assert.equal(pending.statuses.length, 1);
  assert.equal(pending.outputs.superseded, 'false');
  assert.equal(pending.statuses[0].state, 'pending');
  assert.equal(pending.statuses[0].sha, HEAD_SHA);
  assert.equal(pending.statuses[0].target_url, `https://github.com/${REPOSITORY}/actions/runs/9001`);

  // Publish/comment failure skips the verdict status, so the final step must replace the old green.
  const failed = { ...clean, failed: true };
  assert.equal(stepRuns('Set certify failure status', failed), true);
  assert.equal(stepRuns('Confirm certify run success', failed), false);
  const failure = await run('Set certify failure status', failed, [...pending.statuses, ...prior]);
  assert.equal(failure.statuses.length, 1);
  assert.equal(failure.statuses[0].state, 'failure');
  assert.equal(failure.statuses[0].sha, HEAD_SHA);
  assert.equal(failure.statuses[0].target_url, pending.statuses[0].target_url);
  assert.deepEqual(
    [...prior, ...pending.statuses, ...failure.statuses].map(({ state }) => state),
    ['success', 'pending', 'failure'],
  );
  for (const { description } of [...pending.statuses, ...failure.statuses]) {
    assert.notEqual(description, UNTRUSTED_DESCRIPTION);
    assert.ok(description.length <= 140, 'GitHub commit status descriptions fit the API limit');
    for (const approve of ['.github/workflows/styleproof-approve-reusable.yml', 'example/styleproof-approve.yml']) {
      assert.equal(fs.readFileSync(path.join(root, approve), 'utf8').includes(description), false, approve);
    }
  }
  assert.equal(
    stepRuns('Set certify failure status', { ...clean, failed: false, trust: 'REPORT_PUBLICATION_FAILED' }),
    true,
    'a failed status write still requires a failure status',
  );
  assert.equal(stepRuns('Set certify failure status', { ...failed, statusState: 'failure' }), false);
  assert.equal(
    stepRuns('Set certify failure status', { ...clean, statusState: 'success' }),
    true,
    'a successful write requires a final freshness check',
  );
  const confirmedClean = await run('Set certify failure status', { ...clean, statusState: 'success' });
  assert.equal(stepRuns('Confirm certify run success', clean), true);
  assert.match(actionYml, /- name: Confirm certify run success[\s\S]*?run: echo 'succeeded=true' >> "\$GITHUB_OUTPUT"/);
  assert.equal(confirmedClean.runsLookups.length, 1);
  assert.deepEqual(confirmedClean.statuses, [], 'a current clean success stays green without another write');
  const failedAfterSuccess = await run('Set certify failure status', { ...failed, statusState: 'success' });
  assert.equal(failedAfterSuccess.statuses.length, 1);
  assert.equal(
    failedAfterSuccess.statuses[0].state,
    'failure',
    'a later run failure invalidates even a current success',
  );
  const unconfirmed = await run('Set certify failure status', {
    ...clean,
    statusState: 'success',
    runSucceeded: false,
  });
  assert.equal(unconfirmed.statuses[0].state, 'failure', 'missing success confirmation must fail closed');
  assert.equal(stepRuns('Set certify failure status', { ...clean, untrusted: true, statusState: 'pending' }), false);
  for (const stale of [{ staleDelivery: 'true' }, { pendingSuperseded: 'true' }, { statusSuperseded: 'true' }]) {
    assert.equal(stepRuns('Set certify failure status', { ...failed, ...stale }), false);
  }
  for (const outsideScope of [
    { event: 'pull_request' },
    { failOnDiff: false },
    { requireApproval: true },
    { mode: 'review-gate' },
    { mode: 'migration' },
    { mode: 'advisory' },
  ]) {
    for (const step of ['Mark certify status pending', 'Set certify failure status', 'Confirm certify run success']) {
      assert.equal(stepRuns(step, { ...failed, ...outsideScope }), false, `${step}: ${JSON.stringify(outsideScope)}`);
      assert.equal(stepRuns(step, { ...clean, ...outsideScope }), false, `${step}: ${JSON.stringify(outsideScope)}`);
    }
  }
});

test("a superseded capture run's report writes no certify status, in either delivery order", async () => {
  const older = {
    id: 500,
    run_attempt: 1,
    created_at: '2026-10-20T10:00:00Z',
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
  };
  const newer = { ...older, id: 501, created_at: '2026-10-20T10:01:00Z' };
  const clean = {
    mode: 'certify',
    event: 'workflow_run',
    untrusted: false,
    trustState: 'NO_REVIEWABLE_STYLE_CHANGES',
    changed: false,
    workflowRun: older,
    workflowRuns: [older, newer],
  };
  for (const step of ['Mark certify status pending', 'Set review status', 'Set certify failure status']) {
    const result = await run(step, clean);
    assert.deepEqual(result.statuses, [], step);
    if (step !== 'Set certify failure status') assert.equal(result.outputs.superseded, 'true', step);
    assert.deepEqual(result.runsLookups, [
      { owner: 'acme', repo: 'app', workflow_id: 7, head_sha: HEAD_SHA, per_page: 100 },
    ]);
  }
  for (const order of [
    [older, newer],
    [newer, older],
  ]) {
    const statuses = [];
    let newestStarted = false;
    for (const workflowRun of order) {
      const changed = workflowRun.id === newer.id;
      newestStarted ||= changed;
      await run('Set review status', {
        ...clean,
        statuses,
        workflowRun,
        workflowRuns: newestStarted ? [older, newer] : [older],
        changed,
        trustState: changed ? 'STYLE_REVIEW_REQUIRED' : 'NO_REVIEWABLE_STYLE_CHANGES',
      });
    }
    assert.equal(statuses.at(-1).sha, HEAD_SHA);
    assert.equal(statuses.at(-1).state, 'failure', `delivery order: ${order.map(({ id }) => id).join(', ')}`);
    assert.equal(statuses.at(-1).description, 'Style changes detected — certify mode fails on any diff');
  }
});

test('a newer unsuccessful or unfinished capture cannot leave an earlier certify success standing', async () => {
  const clean = {
    mode: 'certify',
    event: 'workflow_run',
    untrusted: false,
    trustState: 'NO_REVIEWABLE_STYLE_CHANGES',
    changed: false,
  };
  for (const lifecycle of [
    { status: 'completed', conclusion: 'failure' },
    { status: 'completed', conclusion: 'cancelled' },
    { status: 'queued', conclusion: null },
    { status: 'in_progress', conclusion: null },
    {},
  ]) {
    const statuses = (await run('Set review status', clean)).statuses;
    const scenario = {
      ...clean,
      statuses,
      workflowRuns: [
        {
          id: 501,
          run_attempt: 1,
          created_at: '2026-10-20T10:01:00Z',
          event: 'pull_request',
          ...lifecycle,
        },
      ],
    };
    for (const step of ['Mark certify status pending', 'Set review status']) {
      await assert.rejects(run(step, scenario), /newer capture run has not completed successfully/);
    }
    const failed = { ...scenario, failed: true };
    assert.equal(stepRuns('Set certify failure status', failed), true);
    await run('Set certify failure status', failed);
    assert.deepEqual(
      statuses.map(({ state }) => state),
      ['success', 'failure'],
      JSON.stringify(lifecycle),
    );
    assert.equal(statuses.at(-1).sha, HEAD_SHA);
  }
});

test('a delayed older success is replaced with failure after a newer capture verdict lands', async () => {
  const older = {
    id: 500,
    run_attempt: 1,
    created_at: '2026-10-20T10:00:00Z',
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
  };
  const newer = { ...older, id: 501, created_at: '2026-10-20T10:01:00Z' };
  const statuses = [];
  const clean = {
    mode: 'certify',
    event: 'workflow_run',
    untrusted: false,
    trustState: 'NO_REVIEWABLE_STYLE_CHANGES',
    changed: false,
    workflowRun: older,
    statuses,
  };
  let reachedWrite;
  const writeStarted = new Promise((resolve) => (reachedWrite = resolve));
  let releaseWrite;
  const delayedWrite = new Promise((resolve) => (releaseWrite = resolve));
  const olderDelivery = run('Set review status', {
    ...clean,
    workflowRuns: [older],
    beforeStatusWrite: async ({ state }) => {
      assert.equal(state, 'success');
      reachedWrite();
      await delayedWrite;
    },
  });
  await Promise.race([writeStarted, olderDelivery.then(() => assert.fail('the older success must reach the write'))]);
  try {
    await run('Set review status', {
      ...clean,
      workflowRun: newer,
      workflowRuns: [older, newer],
      changed: true,
      trustState: 'STYLE_REVIEW_REQUIRED',
    });
    assert.equal(statuses.at(-1).state, 'failure');
  } finally {
    releaseWrite();
  }
  const olderResult = await olderDelivery;
  assert.deepEqual(
    statuses.map(({ state }) => state),
    ['failure', 'success'],
  );
  const finalize = { ...clean, workflowRuns: [older, newer], statusState: olderResult.outputs.state };
  assert.equal(stepRuns('Set certify failure status', finalize), true);
  await run('Set certify failure status', finalize);
  assert.equal(statuses.at(-1).sha, HEAD_SHA);
  assert.equal(statuses.at(-1).state, 'failure', 'the completed older delivery must not leave its stale green');
});

test('a superseded status write with a lost response cannot leave its applied success standing', async () => {
  const older = {
    id: 500,
    run_attempt: 1,
    created_at: '2026-10-20T10:00:00Z',
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
  };
  const newer = { ...older, id: 501, created_at: '2026-10-20T10:01:00Z' };
  const statuses = [];
  const clean = {
    mode: 'certify',
    event: 'workflow_run',
    untrusted: false,
    trustState: 'NO_REVIEWABLE_STYLE_CHANGES',
    changed: false,
    workflowRun: older,
    statuses,
  };
  await assert.rejects(
    run('Set review status', {
      ...clean,
      workflowRuns: [older],
      beforeStatusWrite: async (input) => {
        await run('Set review status', {
          ...clean,
          workflowRun: newer,
          workflowRuns: [older, newer],
          changed: true,
          trustState: 'STYLE_REVIEW_REQUIRED',
        });
        assert.equal(statuses.at(-1).state, 'failure');
        // GitHub applied the older POST, but its missing response prevents the state output.
        statuses.push(input);
        throw new Error('status response lost after the write');
      },
    }),
    /status response lost after the write/,
  );
  assert.deepEqual(
    statuses.map(({ state }) => state),
    ['failure', 'success'],
  );
  const finalize = {
    ...clean,
    failed: true,
    trust: 'REPORT_PUBLICATION_FAILED',
    statusOutcome: 'failure',
    statusState: '',
    workflowRuns: [older, newer],
  };
  assert.equal(stepRuns('Set certify failure status', finalize), true);
  await run('Set certify failure status', finalize);
  assert.equal(statuses.at(-1).sha, HEAD_SHA);
  assert.equal(statuses.at(-1).state, 'failure', 'an ambiguous failed POST may have left stale success on GitHub');
});

test('split certify fails closed when capture-run order cannot be read', async () => {
  const clean = {
    mode: 'certify',
    event: 'workflow_run',
    untrusted: false,
    trustState: 'NO_REVIEWABLE_STYLE_CHANGES',
    changed: false,
    runsLookupError: true,
  };
  for (const step of ['Mark certify status pending', 'Set review status']) {
    const statuses = [];
    await assert.rejects(run(step, { ...clean, statuses }), /capture run lookup unavailable/);
    assert.deepEqual(statuses, [], `${step}: uncertain run order cannot write a successful verdict`);
  }
  const fallback = await run('Set certify failure status', { ...clean, failed: true, trust: '' });
  assert.equal(fallback.statuses.length, 1);
  assert.equal(fallback.statuses[0].state, 'failure');
  assert.equal(fallback.statuses[0].sha, HEAD_SHA);
  assert.match(fallback.statuses[0].description, /no verdict/);
  const afterSuccess = { ...clean, statusState: 'success' };
  assert.equal(stepRuns('Set certify failure status', afterSuccess), true);
  const unknownFreshness = await run('Set certify failure status', afterSuccess);
  assert.equal(unknownFreshness.statuses.length, 1);
  assert.equal(unknownFreshness.statuses[0].state, 'failure', 'an unconfirmed successful write must fail closed');
  assert.equal(unknownFreshness.statuses[0].sha, HEAD_SHA);
});

test('review-gate split status does not consult capture-run ordering', async () => {
  const result = await run('Set review status', {
    mode: 'review-gate',
    event: 'workflow_run',
    untrusted: false,
    trustState: 'STYLE_REVIEW_REQUIRED',
    changed: true,
    forbidRunsLookup: true,
  });
  assert.equal(result.statuses.length, 1);
  assert.equal(result.statuses[0].state, 'failure');
  assert.deepEqual(result.runsLookups, []);
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
