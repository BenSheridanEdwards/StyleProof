import assert from 'node:assert/strict';
import filesystem from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { load as loadActionDocument } from 'js-yaml';

const actionRoot = new URL('../', import.meta.url).pathname;
const action = loadActionDocument(filesystem.readFileSync(new URL('../action.yml', import.meta.url), 'utf8'));
const nativeRequire = createRequire(import.meta.url);
const headCommit = 'a'.repeat(40);
const reviewDigest = 'd'.repeat(64);
const canonicalCreator = { type: 'Bot', login: 'github-actions[bot]' };
const reportLocation = 'https://github.com/owner/repo/actions/runs/900/artifacts/77';
const signOffDescription = 'StyleProof changes need sign-off — tick the box in the report comment';

function reviewRun({ existingComment = true, untrustedCapture = false, changed = true, mode = 'review-gate' } = {}) {
  let clock = Date.parse('2026-11-04T10:00:00Z');
  let statusIdentifier = 1;
  const workflowRuns = new Map();
  const statuses = [];

  const comments = existingComment
    ? [{ id: 77, user: canonicalCreator, body: '<!-- styleproof-report -->\nEarlier report' }]
    : [];

  const commentWrites = [];
  const statusWrites = [];
  const callbacks = {};

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
    'inputs.report-storage': 'artifact',
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
    'steps.publish.outputs.url || steps.report-artifact.outputs.artifact-url': reportLocation,
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
      pulls: { get: async () => ({ data: { state: 'open', head: { sha: headCommit } } }) },
      issues: {
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
        getCollaboratorPermissionLevel: async () => ({ data: { permission: 'read' } }),
        listCommitStatusesForRef: async () => ({ data: statuses.map((status) => ({ ...status })) }),
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
    const outputs = {};
    const AsynchronousFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsynchronousFunction('github', 'context', 'core', 'process', 'require', resolve(step.with.script))(
      github,
      {
        repo: { owner: 'owner', repo: 'repo' },
        runId: 900,
        eventName: 'pull_request',
        payload: { repository: { default_branch: 'main', private: false } },
      },
      { setOutput: (key, value) => (outputs[key] = value), info() {}, warning() {} },
      { env: environment },
      (name) => (name === 'fs' ? { existsSync: () => false } : nativeRequire(name)),
    );

    for (const [key, value] of Object.entries(outputs)) values[`steps.${step.id}.outputs.${key}`] = value;

    return outputs;
  }

  async function start() {
    await runStep('review-pending');
    assert.equal((await runStep('gate')).approved, 'true', 'original receipt must survive pending and carry-forward');
  }

  function assertSignOffRequired() {
    assert.equal(statuses[0].state, 'failure', 'withdrawn approval must never leave a green status');
    assert.equal(statuses[0].description, signOffDescription);
    assert.equal(statuses[0].target_url, reportLocation);

    if (changed && mode !== 'advisory') {
      assert.equal(stepEnabled('Block on unapproved changes'), true, 'the job must also require sign-off');
    }
  }

  return {
    start,
    stepEnabled,
    runStep,
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

test('untick after gate leaves the comment unticked and the status red with the report target', async () => {
  const run = reviewRun();
  await run.start();
  run.withdraw();
  const comment = await run.runStep('comment');
  await run.runStep('status');
  run.assertSignOffRequired();
  assert.match(run.comments[0].body, /- \[ \] \*\*Approve all changes\*\*/);
  assert.doesNotMatch(run.comments[0].body, /approved by|Signed off/);
  assert.equal(comment.approved, 'false');
});

for (const existingComment of [true, false]) {
  test(`untick during comment ${existingComment ? 'update' : 'creation'} corrects the same comment to unticked`, async () => {
    const run = reviewRun({ existingComment });
    await run.start();
    run.callbacks.beforeCommentWrite = () => {
      delete run.callbacks.beforeCommentWrite;
      run.withdraw();
    };

    const comment = await run.runStep('comment');
    await run.runStep('status');
    assert.match(run.commentWrites[0], /- \[x\] \*\*Approve all changes\*\*/);
    assert.equal(run.commentWrites.length, 2);
    assert.equal(run.comments.length, 1, 'correction must not create a duplicate report');
    assert.match(run.comments[0].body, /- \[ \] \*\*Approve all changes\*\*/);
    assert.doesNotMatch(run.comments[0].body, /approved by|Signed off/);
    assert.equal(comment.approved, 'false');
    run.assertSignOffRequired();
  });
}

for (const interrupt of ['withdrawal', 'non-approval status']) {
  test(`${interrupt} after status pre-check is detected after the success write`, async () => {
    const run = reviewRun();
    await run.start();
    run.callbacks.beforeStatusWrite = () => {
      delete run.callbacks.beforeStatusWrite;

      if (interrupt === 'withdrawal') run.withdraw();
      else run.addStatus({ state: 'failure', description: 'StyleProof run failed — see the run' });
    };

    const output = await run.runStep('status');
    assert.equal(run.statusWrites.at(-2).state, 'success', 'exercise the stale success write');
    run.assertSignOffRequired();
    assert.equal(output.state, 'failure');
  });
}

test('untick then valid re-tick after gate uses the new approval identity for comment and green status', async () => {
  const run = reviewRun();
  await run.start();
  run.withdraw();
  run.approve('another-reviewer', '556');
  const comment = await run.runStep('comment');
  await run.runStep('status');
  assert.equal(run.statuses[0].state, 'success');
  assert.equal(run.statuses[0].description, 'Approved by @another-reviewer (run 556)');
  assert.match(run.comments[0].body, /- \[x\] \*\*Approve all changes\*\* — _approved by @another-reviewer_/);
  assert.equal(comment.approved, 'true');
});

test('untick then valid re-tick during the status write still counts', async () => {
  const run = reviewRun();
  await run.start();
  run.callbacks.beforeStatusWrite = () => {
    delete run.callbacks.beforeStatusWrite;
    run.withdraw();
    run.approve('another-reviewer', '556');
  };

  const output = await run.runStep('status');
  assert.equal(run.statuses[0].state, 'success');
  assert.equal(output.state, 'success');
  assert.equal(run.statusWrites.length, 2, 'pending and final success only');
});

test('no untick preserves carry-forward approval, its description and the existing ticked comment', async () => {
  const run = reviewRun();
  await run.start();
  await run.runStep('comment');
  await run.runStep('status');
  assert.equal(run.statuses[0].state, 'success');
  assert.equal(run.statuses[0].description, 'Approved by @reviewer (run 555)');
  assert.equal(run.statuses[0].target_url, undefined);
  assert.equal(run.commentWrites.length, 1);
  assert.match(run.comments[0].body, /- \[x\] \*\*Approve all changes\*\* — _approved by @reviewer_/);
});

test('withdrawing a clean fork approval during a run leaves red sign-off instead of stale green', async () => {
  const run = reviewRun({ untrustedCapture: true, changed: false });
  await run.start();
  run.withdraw();
  await run.runStep('comment');
  await run.runStep('status');
  run.assertSignOffRequired();
  assert.match(run.comments[0].body, /- \[ \] \*\*Approve all changes\*\*/);
});

test('a valid re-tick after gate denied approval clears the final job block', async () => {
  const run = reviewRun();
  await run.runStep('review-pending');
  run.withdraw();
  assert.equal((await run.runStep('gate')).approved, 'false');
  run.approve('another-reviewer', '556');
  await run.runStep('comment');
  await run.runStep('status');
  assert.equal(run.statuses[0].state, 'success');
  assert.equal(run.stepEnabled('Block on unapproved changes'), false);
});

test('same-repository advisory success does not depend on a withdrawn approval', async () => {
  const run = reviewRun({ mode: 'advisory' });
  await run.start();
  run.callbacks.beforeStatusWrite = () => {
    delete run.callbacks.beforeStatusWrite;
    run.withdraw();
  };

  await run.runStep('status');
  assert.equal(run.statuses[0].state, 'success');
});

test('a withdrawn fork approval remains red sign-off even in advisory mode', async () => {
  const run = reviewRun({ mode: 'advisory', untrustedCapture: true });
  await run.start();
  run.withdraw();
  await run.runStep('status');
  assert.equal(run.statuses[0].state, 'failure');
  assert.equal(run.statuses[0].description, signOffDescription);
  assert.equal(run.statuses[0].target_url, reportLocation);
});
