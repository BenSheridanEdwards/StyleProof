import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewRun, headCommit } from './review-gate-test-harness.mjs';

async function prepareReconciliation() {
  const run = reviewRun({ reportStorage: 'branch' });
  await run.start();
  await run.runStep('comment');
  await run.editReviewCheckbox(false);
  await run.runStep('status');

  return run;
}

test('reconciliation preserves a real re-tick after its earlier status snapshot', async () => {
  const run = await prepareReconciliation();
  const original = run.github.rest.repos.listCommitStatusesForRef;
  let reads = 0;
  let accepted;
  run.github.rest.repos.listCommitStatusesForRef = async (...parameters) => {
    const response = structuredClone(await original(...parameters));
    reads += 1;

    if (reads === 3) accepted = await run.editReviewCheckbox(true, '556');

    return response;
  };

  await run.reconcileComment();
  assert.equal(accepted['approved-sha'], headCommit);
  assert.match(run.comments[0].body, /- \[x\] \*\*Approve all changes\*\*/);
});

test('reconciliation preserves a newer report delivered during its head read', async () => {
  const run = await prepareReconciliation();
  const original = run.github.rest.pulls.get;
  let expectedBody;
  let newerValues;
  run.github.rest.pulls.get = async (...parameters) => {
    run.github.rest.pulls.get = original;
    const response = structuredClone(await original(...parameters));
    newerValues = await run.deliverNewerReport();
    expectedBody = run.comments[0].body;

    return response;
  };

  await run.reconcileComment();
  assert.equal(run.comments[0].body, expectedBody, 'the newer body survives until the reviewer edits it');
  Object.assign(run.values, newerValues);
  assert.equal((await run.editReviewCheckbox(true, '557'))['approved-sha'], headCommit);
  assert.match(run.comments[0].body, /styleproof-run-id:901 run-attempt:1/);
});

test('corrective comment upsert preserves a newer report delivered after the first write', async () => {
  const run = reviewRun({ reportStorage: 'branch' });
  await run.start();
  const original = run.github.rest.issues.updateComment;
  run.github.rest.issues.updateComment = async (...parameters) => {
    run.github.rest.issues.updateComment = original;
    const response = structuredClone(await original(...parameters));
    await run.editReviewCheckbox(false);
    await run.deliverNewerReport();

    return response;
  };

  await run.runStep('comment');

  if (run.stepEnabled('status')) await run.runStep('status');
  await run.reconcileComment();
  assert.match(run.comments[0].body, /styleproof-run-id:901 run-attempt:1/);
});

test('an older status step preserves a newer report target and its approval eligibility', async () => {
  const run = reviewRun({ reportStorage: 'branch' });
  await run.start();
  await run.runStep('comment');
  await run.editReviewCheckbox(false);
  const newerValues = await run.deliverNewerReport();
  const newerTarget = run.statuses[0].target_url;
  await run.runStep('status');
  await run.reconcileComment();
  assert.equal(run.statuses[0].target_url, newerTarget);
  Object.assign(run.values, newerValues);
  assert.equal((await run.editReviewCheckbox(true, '557'))['approved-sha'], headCommit);
});

test('a real re-tick before corrective failure delivery survives the next gate', async () => {
  const run = reviewRun({ reportStorage: 'branch' });
  await run.start();
  await run.runStep('comment');
  const originalWrite = run.github.rest.repos.createCommitStatus;
  const originalRead = run.github.rest.repos.listCommitStatusesForRef;
  let successWritten = false;
  let accepted;
  run.github.rest.repos.createCommitStatus = async (parameters) => {
    const response = await originalWrite(parameters);

    if (parameters.state === 'success') successWritten = true;

    return response;
  };

  run.github.rest.repos.listCommitStatusesForRef = async (...parameters) => {
    if (!successWritten) return originalRead(...parameters);
    run.github.rest.repos.listCommitStatusesForRef = originalRead;
    await run.editReviewCheckbox(false);
    const response = structuredClone(await originalRead(...parameters));
    accepted = await run.editReviewCheckbox(true, '556');

    return response;
  };

  await run.runStep('status');
  await run.reconcileComment();
  run.advanceClock();
  assert.equal(accepted['approved-sha'], headCommit);
  assert.equal((await run.runStep('gate')).approved, 'true');
});

test('reconciliation ticks an unticked render after the final status carries current approval', async () => {
  const run = reviewRun();
  await run.start();
  run.withdraw();
  await run.runStep('comment');
  assert.match(run.comments[0].body, /- \[ \] \*\*Approve all changes\*\*/);
  run.approve('another-reviewer', '556');
  await run.runStep('status');
  await run.reconcileComment();
  assert.match(run.comments[0].body, /- \[x\] \*\*Approve all changes\*\* — _approved by @another-reviewer_/);
  assert.match(run.comments[0].body, /Signed off — the \*\*StyleProof\*\* check is green/);
});

test('reconciliation warns instead of failing when a comment request returns not found', async () => {
  const run = await prepareReconciliation();
  run.github.rest.issues.updateComment = async () => {
    throw Object.assign(new Error('Not Found'), { status: 404 });
  };

  await assert.doesNotReject(run.reconcileComment());
  assert.match(run.warnings.join('\n'), /reconciliation could not complete: Not Found/);
});

test('initial publication can claim an older report receipt', async () => {
  const run = reviewRun();
  await run.start();
  run.comments[0].body = `<!-- styleproof-report -->\n<!-- styleproof-sha:${headCommit} -->\n<!-- styleproof-run-id:899 run-attempt:1 -->`;
  await run.runStep('comment');
  assert.match(run.comments[0].body, /styleproof-run-id:900 run-attempt:1/);
});
