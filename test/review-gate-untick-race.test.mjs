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
const forkPendingDescription = 'Fork PR — maps captured in an untrusted job; maintainer approval required';

function reviewRun({
  existingComment = true,
  untrustedCapture = false,
  changed = true,
  mode = 'review-gate',
  reportStorage = 'artifact',
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
                ? `<!-- styleproof-receipt head-sha:${headCommit} run-id:900 run-attempt:1 -->`
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
    reconcileComment,
    editReviewCheckbox,
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
  assert.equal(run.statuses[0].description, 'Approved by @another-reviewer (run 556)');
  assert.equal(run.statusWrites.length, 3, 'pending, stale success and corrected current approval');
  run.advanceClock();
  await run.start();
  await run.runStep('comment');
  await run.runStep('status');
  assert.equal(run.statuses[0].description, 'Approved by @another-reviewer (run 556)');
  assert.equal(run.stepEnabled('Block on unapproved changes'), false);
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

test('withdrawing a clean fork approval during a run restores pending maintainer review', async () => {
  const run = reviewRun({ untrustedCapture: true, changed: false });
  await run.start();
  run.withdraw();
  await run.runStep('comment');
  await run.runStep('status');
  assert.equal(run.statuses[0].state, 'pending');
  assert.equal(run.statuses[0].description, forkPendingDescription);
  assert.equal(run.statuses[0].target_url, reportLocation);
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

test('a withdrawn fork approval remains pending maintainer review even in advisory mode', async () => {
  const run = reviewRun({ mode: 'advisory', untrustedCapture: true });
  await run.start();
  run.withdraw();
  await run.runStep('status');
  assert.equal(run.statuses[0].state, 'pending');
  assert.equal(run.statuses[0].description, forkPendingDescription);
  assert.equal(run.statuses[0].target_url, reportLocation);
});

test('a different reviewer re-ticking during comment upsert replaces the attribution', async () => {
  const run = reviewRun();
  await run.start();
  run.callbacks.beforeCommentWrite = () => {
    delete run.callbacks.beforeCommentWrite;
    run.withdraw();
    run.approve('another-reviewer', '556');
  };

  await run.runStep('comment');
  assert.equal(run.commentWrites.length, 2);
  assert.match(run.comments[0].body, /approved by @another-reviewer/);
  assert.doesNotMatch(run.comments[0].body, /approved by @reviewer_/);
});

test('a withdrawal during the corrected attribution upsert still leaves the comment unticked', async () => {
  const run = reviewRun();
  await run.start();
  let writes = 0;

  run.callbacks.beforeCommentWrite = () => {
    writes += 1;
    run.withdraw();

    if (writes === 1) run.approve('another-reviewer', '556');
    else delete run.callbacks.beforeCommentWrite;
  };

  await run.runStep('comment');
  assert.equal(run.commentWrites.length, 3);
  assert.match(run.comments[0].body, /- \[ \] \*\*Approve all changes\*\*/);
  assert.doesNotMatch(run.comments[0].body, /approved by|Signed off/);
});

test('final status reconciliation preserves a report already replaced for a new head', async () => {
  const run = reviewRun();
  await run.start();
  await run.runStep('comment');
  run.withdraw();
  await run.runStep('status');
  run.moveHead();
  run.comments[0].body = 'Report for the newer head';
  await run.reconcileComment();
  assert.equal(run.comments[0].body, 'Report for the newer head');
});

for (const timing of ['initial', 'corrective']) {
  test(`a push during ${timing} comment approval revalidation preserves the newer head report`, async () => {
    const run = reviewRun();
    await run.start();

    if (timing === 'corrective') {
      run.callbacks.beforeCommentWrite = () => {
        delete run.callbacks.beforeCommentWrite;
        run.withdraw();
        run.callbacks.beforeStatusRead = moveHead;
      };
    } else run.callbacks.beforeStatusRead = moveHead;

    function moveHead() {
      delete run.callbacks.beforeStatusRead;
      run.moveHead();
      run.comments[0].body = 'Report for the newer head';
    }

    await run.runStep('comment');
    assert.equal(run.comments[0].body, 'Report for the newer head');
    assert.equal(run.commentWrites.length, timing === 'initial' ? 0 : 1);
  });
}

for (const interruption of ['withdrawal', 'non-approval status', 'read error']) {
  test(`a final non-green status after ${interruption} corrects the ticked comment`, async () => {
    const run = reviewRun();
    await run.start();
    await run.runStep('comment');
    run.callbacks.beforeStatusWrite = () => {
      delete run.callbacks.beforeStatusWrite;

      if (interruption === 'withdrawal') run.withdraw();
      else if (interruption === 'non-approval status')
        run.addStatus({ state: 'failure', description: 'Evidence incomplete' });
      else
        run.callbacks.beforeStatusRead = () => {
          delete run.callbacks.beforeStatusRead;
          throw new Error('Status read unavailable');
        };
    };

    await run.runStep('status');
    await run.reconcileComment();
    run.assertSignOffRequired();
    assert.match(run.comments[0].body, /- \[ \] \*\*Approve all changes\*\*/);
    assert.doesNotMatch(run.comments[0].body, /approved by|Signed off/);
  });
}

for (const step of ['review-pending', 'comment']) {
  test(`a stale delivery identified by ${step} cannot block a newer approved run`, async () => {
    const run = reviewRun();
    run.values[`steps.${step}.outputs.stale-delivery`] = 'true';
    assert.equal(run.stepEnabled('status'), false);
    assert.equal(run.stepEnabled('Block on unapproved changes'), false);
  });
}

test('a withdrawal during the corrected current-approval status write still wins', async () => {
  const run = reviewRun();
  await run.start();
  let writes = 0;
  run.callbacks.beforeStatusWrite = () => {
    writes += 1;
    run.withdraw();

    if (writes === 1) run.approve('another-reviewer', '556');
    else delete run.callbacks.beforeStatusWrite;
  };

  await run.runStep('status');
  run.assertSignOffRequired();
});

test('a fork withdrawal during the status write restores pending and unticks the comment', async () => {
  const run = reviewRun({ untrustedCapture: true });
  await run.start();
  await run.runStep('comment');
  run.callbacks.beforeStatusWrite = () => {
    delete run.callbacks.beforeStatusWrite;
    run.withdraw();
  };

  await run.runStep('status');
  await run.reconcileComment();
  assert.equal(run.statuses[0].state, 'pending');
  assert.equal(run.statuses[0].description, forkPendingDescription);
  assert.equal(run.statuses[0].target_url, reportLocation);
  assert.match(run.comments[0].body, /- \[ \] \*\*Approve all changes\*\*/);
  assert.match(run.comments[0].body, /check stays pending until a maintainer/);
});

test('withdrawal finishes red, the real approval workflow accepts a later re-tick, and the next run carries it forward', async () => {
  const run = reviewRun({ reportStorage: 'branch' });
  await run.start();
  await run.runStep('comment');
  await run.editReviewCheckbox(false);
  assert.match(run.statuses[0].description, /^Approval withdrawn/);
  assert.deepEqual(
    await run.editReviewCheckbox(true),
    {},
    'the real workflow refuses an immediate re-tick of a withdrawal',
  );
  // Restore the reviewer withdrawal: the refused tick has no status write.
  await run.runStep('status');
  await run.reconcileComment();
  assert.equal(run.statuses[0].description, signOffDescription);
  assert.match(run.comments[0].body, /- \[ \] \*\*Approve all changes\*\*/);
  const outputs = await run.editReviewCheckbox(true);
  assert.equal(outputs['approved-sha'], headCommit);
  assert.equal(run.statuses[0].description, 'Approved by @reviewer (run 556)');
  run.advanceClock();
  await run.start();
  await run.runStep('comment');
  await run.runStep('status');
  assert.equal(run.statuses[0].state, 'success');
  assert.equal(run.statuses[0].description, 'Approved by @reviewer (run 556)');
  assert.equal(run.stepEnabled('Block on unapproved changes'), false);
  assert.match(run.comments[0].body, /- \[x\] \*\*Approve all changes\*\* — _approved by @reviewer_/);
});
