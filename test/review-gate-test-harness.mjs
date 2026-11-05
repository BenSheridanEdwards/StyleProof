import assert from 'node:assert/strict';
import filesystem from 'node:fs';
import { createRequire } from 'node:module';
import { load as loadActionDocument } from 'js-yaml';

const actionRoot = new URL('../', import.meta.url).pathname;
const action = loadActionDocument(filesystem.readFileSync(new URL('../action.yml', import.meta.url), 'utf8'));
const nativeRequire = createRequire(import.meta.url);
const headCommit = 'a'.repeat(40);
const reviewDigest = 'd'.repeat(64);
const canonicalCreator = { type: 'Bot', login: 'github-actions[bot]' };
const reportLocation = 'https://github.com/owner/repo/actions/runs/900/artifacts/77';
const signOffDescription = 'StyleProof changes need sign-off — tick the box in the report comment';
const forkPendingDescription = 'Fork PR — maps captured in an untrusted job; maintainer approval required';

function reviewRun({
  existingComment = true,
  untrustedCapture = false,
  changed = true,
  mode = 'review-gate',
  reportStorage = 'artifact',
  reportMarkdown,
} = {}) {
  let clock = Date.parse('2026-11-04T10:00:00Z');
  let currentHeadCommit = headCommit;
  let statusIdentifier = 1;
  const workflowRuns = new Map();
  const statuses = [];

  const comments = existingComment
    ? [{ id: 77, user: canonicalCreator, body: '<!-- styleproof-report -->\nEarlier report' }]
    : [];

  const commentWrites = [];
  const statusWrites = [];
  const callbacks = {};
  const warnings = [];
  const messages = [];
  const environments = {};
  const files = reportMarkdown === undefined ? {} : { 'styleproof-report/report.md': reportMarkdown };

  function addStatus(parameters) {
    const status = {
      id: statusIdentifier++,
      context: 'StyleProof',
      created_at: new Date(clock++).toISOString(),
      creator: canonicalCreator,
      ...parameters,
    };

    statuses.unshift(status);

    return status;
  }

  function approve(approver = 'reviewer', workflowRunIdentifier = '555') {
    const start = new Date(clock).toISOString();

    const status = addStatus({
      state: 'success',
      description: `Approved by @${approver} (run ${workflowRunIdentifier})`,
    });

    workflowRuns.set(workflowRunIdentifier, {
      status: 'completed',
      conclusion: 'success',
      event: 'issue_comment',
      head_branch: 'main',
      triggering_actor: { login: approver },
      run_started_at: start,
      updated_at: status.created_at,
    });

    return status;
  }

  function withdraw() {
    addStatus({ state: 'failure', description: 'Approval withdrawn by @reviewer — re-run StyleProof for a verdict' });
  }

  approve();
  // Carry-forward has a newer timestamp than the original issue-comment receipt.
  clock += 60000;
  addStatus({ state: 'success', description: statuses[0].description });

  const values = {
    'inputs.mode': mode,
    'inputs.require-approval': 'false',
    'inputs.status-context': 'StyleProof',
    'inputs.comment-marker': '<!-- styleproof-report -->',
    'toJSON(inputs.comment-marker)': JSON.stringify('<!-- styleproof-report -->'),
    'inputs.report-storage': reportStorage,
    'inputs.report-retention-days': '14',
    'inputs.include-content': 'false',
    'github.event_name': 'pull_request',
    'github.run_id': '900',
    'github.run_attempt': '1',
    'steps.context.outputs.pr-number': '7',
    'steps.context.outputs.head-sha': headCommit,
    'steps.context.outputs.untrusted-capture': String(untrustedCapture),
    'steps.diff.outputs.changed': String(changed),
    'steps.verdict.outputs.state': changed ? 'STYLE_REVIEW_REQUIRED' : 'NO_REVIEWABLE_STYLE_CHANGES',
    'steps.verdict.outputs.diff-digest': reviewDigest,
    'steps.config.outputs.blocking': 'true',
    'steps.delivery.outputs.upload': 'true',
    'steps.report-artifact.outputs.artifact-digest': 'e'.repeat(64),
    'steps.publish.outputs.sha': 'c'.repeat(40),
    'steps.publish.outputs.url || steps.report-artifact.outputs.artifact-url':
      reportStorage === 'branch'
        ? `https://github.com/owner/repo/blob/${'c'.repeat(40)}/pr-7/report.md`
        : reportLocation,
  };

  const github = {
    paginate: async (route, parameters) => (await route(parameters)).data,
    rest: {
      actions: {
        getWorkflowRun: async ({ run_id }) => ({ data: workflowRuns.get(run_id) }),
        listWorkflowRunArtifacts: async () => ({
          data: { artifacts: [{ name: `styleproof-approval-7-${headCommit}-${reviewDigest}`, expired: false }] },
        }),
      },
      pulls: {
        get: async () => ({
          data: { state: 'open', head: { sha: currentHeadCommit }, user: { login: 'pull-request-author' } },
        }),
      },
      issues: {
        getComment: async () => ({ data: comments[0] }),
        listComments: async () => ({ data: comments }),
        createComment: async (parameters) => {
          await callbacks.beforeCommentWrite?.();
          const comment = { ...parameters, id: 88, user: canonicalCreator };
          comments.push(comment);
          commentWrites.push(comment.body);

          return { data: comment };
        },
        updateComment: async (parameters) => {
          await callbacks.beforeCommentWrite?.();
          const comment = comments.find((entry) => entry.id === parameters.comment_id);
          assert.ok(comment, 'corrective delivery must update the same comment');
          comment.body = parameters.body;
          commentWrites.push(comment.body);

          return { data: comment };
        },
      },
      repos: {
        getCollaboratorPermissionLevel: async () => ({ data: { permission: 'write' } }),
        listCommitStatusesForRef: async () => {
          await callbacks.beforeStatusRead?.();

          return { data: statuses.map((status) => ({ ...status })) };
        },
        getContent: async ({ path }) => ({
          data: {
            type: 'file',
            encoding: 'base64',
            content: Buffer.from(
              path.endsWith('report.md')
                ? `<!-- styleproof-receipt head-sha:${headCommit} run-id:${values['github.run_id']} run-attempt:${values['github.run_attempt']} -->`
                : JSON.stringify({ actionTrustState: 'STYLE_REVIEW_REQUIRED', reviewDigest }),
            ).toString('base64'),
          },
        }),
        createCommitStatus: async (parameters) => {
          await callbacks.beforeStatusWrite?.(parameters);
          const status = addStatus(parameters);
          statusWrites.push(status);

          return { data: status };
        },
      },
    },
  };

  function stepEnabled(name) {
    const step = action.runs.steps.find((entry) => entry.id === name || entry.name === name);

    const condition = String(step.if ?? 'success()')
      .replace(/\b(success|always)\(\)/g, 'true')
      .replace(/\b(?:inputs|steps|github)\.[\w.-]+/g, (key) => JSON.stringify(values[key] ?? ''));

    return Boolean(Function(`return (${condition})`)());
  }

  async function runStep(name) {
    const step = action.runs.steps.find((entry) => entry.id === name || entry.name === name);
    assert.ok(step, name);
    const resolve = (source) => String(source).replace(/\$\{\{ (.+?) \}\}/g, (_, key) => values[key] ?? '');
    assert.equal(stepEnabled(name), true, `${name} must run`);
    const environment = { GITHUB_ACTION_PATH: actionRoot };

    for (const [key, value] of Object.entries(step.env ?? {})) environment[key] = resolve(value);
    environments[name] = { ...environment };
    const outputs = {};
    const AsynchronousFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsynchronousFunction('github', 'context', 'core', 'process', 'require', resolve(step.with.script))(
      github,
      {
        repo: { owner: 'owner', repo: 'repo' },
        runId: Number(values['github.run_id']),
        eventName: 'pull_request',
        payload: { repository: { default_branch: 'main', private: false } },
      },
      {
        setOutput: (key, value) => (outputs[key] = value),
        info: (message) => messages.push(message),
        warning: (message) => warnings.push(message),
      },
      { env: environment },
      (name) =>
        name === 'fs'
          ? { existsSync: (file) => Object.hasOwn(files, file), readFileSync: (file) => files[file] }
          : nativeRequire(name),
    );

    for (const [key, value] of Object.entries(outputs)) values[`steps.${step.id}.outputs.${key}`] = value;
    values[`steps.${step.id}.outcome`] = 'success';

    return outputs;
  }

  async function reconcileComment() {
    if (
      action.runs.steps.some((step) => step.name === 'Reconcile review comment') &&
      stepEnabled('Reconcile review comment')
    ) {
      await runStep('Reconcile review comment');
    }
  }

  async function editReviewCheckbox(ticked, workflowRunIdentifier = '556') {
    comments[0].body = comments[0].body.replace(
      /- \[[ x]\] \*\*Approve all changes\*\*/,
      `- [${ticked ? 'x' : ' '}] **Approve all changes**`,
    );

    const workflow = loadActionDocument(
      filesystem.readFileSync(new URL('../.github/workflows/styleproof-approve-reusable.yml', import.meta.url), 'utf8'),
    );

    const source = workflow.jobs.approve.steps.find((step) => step.with?.script).with.script;
    const AsynchronousFunction = Object.getPrototypeOf(async function () {}).constructor;
    const outputs = {};
    const start = new Date(clock).toISOString();
    await new AsynchronousFunction('github', 'context', 'core', 'require', 'process', source)(
      github,
      {
        repo: { owner: 'owner', repo: 'repo' },
        runId: Number(workflowRunIdentifier),
        payload: { sender: { login: 'reviewer' }, comment: { id: comments[0].id }, issue: { number: 7 } },
      },
      { setOutput: (key, value) => (outputs[key] = value) },
      () => ({ writeFileSync() {} }),
      {
        env: {
          STYLEPROOF_STATUS_CONTEXT: 'StyleProof',
          STYLEPROOF_RUN_ATTEMPT: '1',
          STYLEPROOF_TRIGGERING_ACTOR: 'reviewer',
        },
      },
    );

    if (outputs['approved-sha']) {
      assert.equal(outputs['approval-artifact'], `styleproof-approval-7-${headCommit}-${reviewDigest}`);
      workflowRuns.set(workflowRunIdentifier, {
        status: 'completed',
        conclusion: 'success',
        event: 'issue_comment',
        head_branch: 'main',
        triggering_actor: { login: 'reviewer' },
        run_started_at: start,
        updated_at: new Date(clock).toISOString(),
      });
    }

    return outputs;
  }

  async function start() {
    await runStep('review-pending');
    assert.equal((await runStep('gate')).approved, 'true', 'original receipt must survive pending and carry-forward');
  }

  async function deliverNewerReport({ runIdentifier = '901', runAttempt = '1' } = {}) {
    const priorValues = { ...values };
    values['github.run_id'] = runIdentifier;
    values['github.run_attempt'] = runAttempt;
    values['steps.publish.outputs.sha'] = 'e'.repeat(40);
    values['steps.publish.outputs.url || steps.report-artifact.outputs.artifact-url'] =
      `https://github.com/owner/repo/blob/${'e'.repeat(40)}/pr-7/report.md`;
    await runStep('review-pending');
    await runStep('gate');
    await runStep('comment');
    await runStep('status');
    const deliveryValues = { ...values };
    Object.assign(values, priorValues);

    return deliveryValues;
  }

  function assertSignOffRequired() {
    assert.equal(statuses[0].state, 'failure', 'withdrawn approval must never leave a green status');
    assert.equal(statuses[0].description, signOffDescription);
    assert.equal(statuses[0].target_url, reportLocation);
  }

  return {
    github,
    warnings,
    messages,
    environments,
    start,
    stepEnabled,
    runStep,
    reconcileComment,
    editReviewCheckbox,
    deliverNewerReport,
    advanceClock: () => {
      clock += 60000;
    },
    moveHead: () => {
      currentHeadCommit = 'b'.repeat(40);
    },
    values,
    approve,
    withdraw,
    addStatus,
    statuses,
    comments,
    commentWrites,
    statusWrites,
    callbacks,
    assertSignOffRequired,
  };
}

export { reviewRun, headCommit, reportLocation, signOffDescription, forkPendingDescription };
