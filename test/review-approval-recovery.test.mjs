import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewRun, headCommit, signOffDescription } from './review-gate-test-harness.mjs';

function failFirstApprovalRunRead(run) {
  const original = run.github.rest.actions.getWorkflowRun;
  run.github.rest.actions.getWorkflowRun = async () => {
    run.github.rest.actions.getWorkflowRun = original;
    throw Object.assign(new Error('Approval run temporarily unavailable'), { status: 403 });
  };
}

test('a recovered approval replaces the running status with its validated success', async () => {
  const run = reviewRun();
  await run.start();
  await run.runStep('comment');
  failFirstApprovalRunRead(run);
  const outputs = await run.runStep('status');
  await run.reconcileComment();
  assert.equal(outputs.state, 'success');
  assert.equal(run.statuses[0].state, 'success');
  assert.equal(run.statuses[0].description, 'Approved by @reviewer (run 555)');
  assert.equal((await run.runStep('gate')).approved, 'true');
});

for (const existingComment of [true, false]) {
  test(`a recovered approval publishes the ticked report with existing comment ${existingComment}`, async () => {
    const run = reviewRun({ existingComment });
    await run.start();
    failFirstApprovalRunRead(run);
    const outputs = await run.runStep('comment');
    assert.equal(outputs.approved, 'true');
    assert.equal(run.commentWrites.length, 1);
    assert.match(run.comments[0].body, /- \[x\] \*\*Approve all changes\*\*/);
    assert.match(run.comments[0].body, /styleproof-run-id:900 run-attempt:1/);
  });
}

for (const reportStorage of ['branch', 'artifact']) {
  test(`${reportStorage}: ownership API failure preserves the already pending newer run`, async () => {
    const run = reviewRun({ reportStorage });
    await run.start();
    await run.runStep('comment');
    run.addStatus({
      state: 'pending',
      description: 'StyleProof report running — no verdict yet',
      target_url: 'https://github.com/owner/repo/actions/runs/901',
    });
    const original = run.github.rest.repos.listCommitStatusesForRef;
    let reads = 0;
    run.github.rest.repos.listCommitStatusesForRef = async (parameters) => {
      if (++reads === 2) throw new Error('Ownership API unavailable');

      return original(parameters);
    };

    await run.runStep('status');
    assert.equal(run.statuses[0].state, 'pending');
    assert.equal(run.statuses[0].target_url, 'https://github.com/owner/repo/actions/runs/901');
    assert.match(run.warnings.join('\n'), /ownership could not be proven/);
  });
}

test('a withdrawal seen in the reconciliation guard leaves the checkbox unticked', async () => {
  const run = reviewRun({ reportStorage: 'branch' });
  await run.start();
  run.withdraw();
  await run.runStep('comment');
  await run.runStep('status');
  assert.equal((await run.editReviewCheckbox(true, '556'))['approved-sha'], headCommit);
  await run.runStep('status');
  const original = run.github.rest.repos.listCommitStatusesForRef;
  let reads = 0;
  let observed;
  run.github.rest.repos.listCommitStatusesForRef = async (parameters) => {
    const position = ++reads;

    if (position === 2) await run.editReviewCheckbox(false);
    const response = await original(parameters);

    if (position === 2) observed = response.data[0].state;

    return response;
  };

  await run.reconcileComment();
  assert.equal(observed, 'failure', 'the ownership guard read the withdrawal');
  assert.equal(run.statuses[0].state, 'failure');
  assert.doesNotMatch(run.comments[0].body, /- \[x\]/);
});

test('an ownership read error cannot publish a ticked comment', async () => {
  const run = reviewRun();
  await run.start();
  const original = run.github.rest.repos.listCommitStatusesForRef;
  let reads = 0;
  run.github.rest.repos.listCommitStatusesForRef = async (parameters) => {
    if (++reads === 2) throw new Error('Ownership API unavailable');

    return original(parameters);
  };

  await run.runStep('comment');
  assert.equal(run.commentWrites.length, 0);
  assert.match(run.warnings.join('\n'), /ownership could not be proven/);
});

for (const unavailable of ['comments', 'permission']) {
  test(`unavailable ${unavailable} ownership evidence cannot publish a ticked comment`, async () => {
    const run = reviewRun();
    await run.start();

    if (unavailable === 'comments') {
      const original = run.github.paginate;
      let reads = 0;
      run.github.paginate = async (...parameters) => {
        if (++reads === 2) throw new Error('Comments API unavailable');

        return original(...parameters);
      };
    } else {
      run.comments.push({
        id: 99,
        user: { type: 'User', login: 'later-reviewer' },
        body: `<!-- styleproof-report -->\n<!-- styleproof-sha:${headCommit} -->\n<!-- styleproof-run-id:900 run-attempt:2 -->`,
      });
      run.github.rest.repos.getCollaboratorPermissionLevel = async () => {
        throw new Error('Permission API unavailable');
      };
    }

    await run.runStep('comment');
    assert.equal(run.commentWrites.length, 0);
    assert.match(run.warnings.join('\n'), /ownership could not be proven/);
  });
}

for (const step of ['comment', 'status']) {
  test(`${step} approval churn reaches its limit and leaves fresh sign-off re-tickable`, async () => {
    const run = reviewRun({ reportStorage: 'branch' });
    await run.start();

    if (step === 'status') await run.runStep('comment');

    let changes = 0;

    const changeApproval = () => {
      if (++changes > 7) throw new Error('Approval re-check loop exceeded its limit');
      run.approve(`reviewer${changes}`, String(600 + changes));
    };

    if (step === 'comment') run.callbacks.beforeCommentWrite = changeApproval;
    else
      run.callbacks.beforeStatusWrite = (parameters) => {
        if (parameters.state === 'success') changeApproval();
      };

    await run.runStep(step);
    delete run.callbacks.beforeCommentWrite;
    delete run.callbacks.beforeStatusWrite;

    if (step === 'comment') {
      assert.equal(run.values['steps.comment.outputs.approval-limit-reached'], 'true');
      await run.runStep('status');
    }

    await run.reconcileComment();
    assert.match(run.warnings.join('\n'), /re-check limit reached/);
    assert.ok(changes <= 6, 'five re-checks bound publication work');
    assert.equal(run.statuses[0].state, 'failure');
    assert.equal(run.statuses[0].description, signOffDescription);
    assert.equal(
      run.statuses[0].target_url,
      run.values['steps.publish.outputs.url || steps.report-artifact.outputs.artifact-url'],
    );
    assert.match(run.comments[0].body, /- \[ \] \*\*Approve all changes\*\*/);
    assert.equal((await run.editReviewCheckbox(true, '700'))['approved-sha'], headCommit);
    assert.equal(run.statuses[0].state, 'success');
  });
}

test('an unfinished approval run can leave sign-off red and remains re-tickable after completion', async () => {
  const run = reviewRun({ reportStorage: 'branch' });
  await run.start();
  await run.runStep('comment');
  const original = run.github.rest.actions.getWorkflowRun;
  let unfinished = false;
  run.github.rest.actions.getWorkflowRun = async (parameters) => {
    const response = await original(parameters);

    return parameters.run_id === '557' && unfinished
      ? { data: { ...response.data, status: 'in_progress', conclusion: null } }
      : response;
  };

  let accepted;
  run.callbacks.beforeStatusRead = async () => {
    if (run.statusWrites.length !== 2 || accepted) return;
    accepted = {};
    await run.editReviewCheckbox(false, '556');
    accepted = await run.editReviewCheckbox(true, '557');
    unfinished = true;
  };

  await run.runStep('status');
  delete run.callbacks.beforeStatusRead;
  unfinished = false;
  await run.reconcileComment();
  assert.equal(accepted['approved-sha'], headCommit);
  assert.equal(run.statuses[0].state, 'failure');
  assert.match(run.comments[0].body, /- \[ \] \*\*Approve all changes\*\*/);
  assert.equal((await run.editReviewCheckbox(true, '558'))['approved-sha'], headCommit);
  assert.equal(run.statuses[0].state, 'success');
});
