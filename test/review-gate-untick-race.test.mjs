import assert from 'node:assert/strict';
import test from 'node:test';
import {
  reviewRun,
  headCommit,
  reportLocation,
  signOffDescription,
  forkPendingDescription,
} from './review-gate-test-harness.mjs';

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

test('a valid re-tick after gate denied approval restores the final success status', async () => {
  const run = reviewRun();
  await run.runStep('review-pending');
  run.withdraw();
  assert.equal((await run.runStep('gate')).approved, 'false');
  run.approve('another-reviewer', '556');
  await run.runStep('comment');
  await run.runStep('status');
  assert.equal(run.statuses[0].state, 'success');
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
          throw new Error('Status read unavailable');
        };

      if (interruption === 'read error')
        run.callbacks.beforeStatusWrite = () => {
          delete run.callbacks.beforeStatusWrite;
          delete run.callbacks.beforeStatusRead;
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
  assert.match(run.comments[0].body, /- \[x\] \*\*Approve all changes\*\* — _approved by @reviewer_/);
});

test('reconciliation preserves a fresh approval accepted by the real approval workflow', async () => {
  const run = reviewRun({ reportStorage: 'branch' });
  await run.start();
  await run.runStep('comment');
  await run.editReviewCheckbox(false);
  await run.runStep('status');
  assert.equal(run.statuses[0].state, 'failure');
  const approval = await run.editReviewCheckbox(true);
  assert.equal(approval['approved-sha'], headCommit);
  assert.equal(run.statuses[0].description, 'Approved by @reviewer (run 556)');
  const approvedBody = run.comments[0].body;
  const writesBeforeReconciliation = run.commentWrites.length;
  await run.reconcileComment();
  assert.equal(run.comments[0].body, approvedBody);
  assert.equal(run.commentWrites.length, writesBeforeReconciliation);
  assert.match(run.comments[0].body, /- \[x\] \*\*Approve all changes\*\* — _approved by @reviewer_/);
});

for (const description of ['No reviewable computed-style changes', 'Approved by @reviewer (run 557)']) {
  test(`reconciliation preserves the comment when the newest review status succeeds: ${description}`, async () => {
    const run = reviewRun();
    await run.start();
    await run.runStep('comment');
    run.withdraw();
    await run.runStep('status');
    run.addStatus({ state: 'success', description });
    const previousBody = run.comments[0].body;
    const writesBeforeReconciliation = run.commentWrites.length;
    await run.reconcileComment();
    assert.equal(run.comments[0].body, previousBody);
    assert.equal(run.commentWrites.length, writesBeforeReconciliation);
  });
}

for (const [delivery, runIdentifier, runAttempt] of [
  ['newer run', '901', '1'],
  ['later attempt', '900', '2'],
]) {
  test(`reconciliation preserves a ${delivery} report delivered by the real comment step`, async () => {
    const run = reviewRun({ reportStorage: 'branch' });
    await run.start();
    await run.runStep('comment');
    run.withdraw();
    await run.runStep('status');
    const deliveryValues = await run.deliverNewerReport({ runIdentifier, runAttempt });
    const newerBody = run.comments[0].body;
    const writesBeforeReconciliation = run.commentWrites.length;
    assert.match(newerBody, new RegExp(`styleproof-run-id:${runIdentifier} run-attempt:${runAttempt}`));
    await run.reconcileComment();
    assert.equal(run.comments[0].body, newerBody);
    assert.equal(run.commentWrites.length, writesBeforeReconciliation);
    Object.assign(run.values, deliveryValues);
    assert.equal(
      (await run.editReviewCheckbox(true))['approved-sha'],
      headCommit,
      'the current report remains approvable',
    );
  });
}

for (const receipt of ['', '<!-- styleproof-run-id:899 run-attempt:1 -->']) {
  test(`reconciliation ${receipt ? 'skips another run receipt' : 'accepts an unmarked legacy comment'}`, async () => {
    const run = reviewRun();
    await run.start();
    await run.runStep('comment');
    run.withdraw();
    await run.runStep('status');
    run.comments[0].body = run.comments[0].body.replace(/<!-- styleproof-run-id:\d+ run-attempt:\d+ -->/, receipt);
    const currentBody = run.comments[0].body;
    const writesBeforeReconciliation = run.commentWrites.length;
    await run.reconcileComment();

    if (receipt) {
      assert.equal(run.comments[0].body, currentBody);
      assert.equal(run.commentWrites.length, writesBeforeReconciliation);
    } else {
      assert.match(run.comments[0].body, /- \[ \] \*\*Approve all changes\*\*/);
      assert.doesNotMatch(run.comments[0].body, /styleproof-run-id:/);
      assert.equal(run.commentWrites.length, writesBeforeReconciliation + 1);
    }
  });
}

test('reconciliation checks the live receipt after approval revalidation delivers a newer report', async () => {
  const run = reviewRun({ reportStorage: 'branch' });
  await run.start();
  await run.runStep('comment');
  run.withdraw();
  await run.runStep('status');
  let reads = 0;
  let newerBody;
  run.callbacks.beforeStatusRead = async () => {
    reads += 1;

    if (reads !== 2) return;
    delete run.callbacks.beforeStatusRead;
    await run.deliverNewerReport();
    newerBody = run.comments[0].body;
  };

  await run.reconcileComment();
  assert.ok(newerBody, 'the newer report must arrive during reconciliation');
  assert.equal(run.comments[0].body, newerBody);
});

test('an unrelated successful status does not prevent unticking a red review report', async () => {
  const run = reviewRun();
  await run.start();
  await run.runStep('comment');
  run.withdraw();
  await run.runStep('status');
  run.addStatus({ context: 'Another check', state: 'success', description: 'Passed' });
  await run.reconcileComment();
  assert.match(run.comments[0].body, /- \[ \] \*\*Approve all changes\*\*/);
});
