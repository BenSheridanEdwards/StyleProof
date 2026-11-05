import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { reviewRun, signOffDescription } from './review-gate-test-harness.mjs';

for (const changed of [true, false]) {
  test(`unreadable status delivery ownership ends red with changed ${changed}`, async () => {
    const run = reviewRun({ changed });
    await run.runStep('review-pending');
    await run.runStep('gate');
    await run.runStep('comment');
    run.github.paginate = async () => {
      throw new Error('Ownership comments unavailable');
    };

    const output = await run.runStep('status');
    assert.equal(output.state, 'failure');
    assert.notEqual(output['stale-delivery'], 'true');
    assert.equal(run.statuses[0].state, 'failure');
    assert.equal(run.statuses[0].description, signOffDescription);
    assert.ok(run.statuses[0].target_url);
  });
}

test('a comment ownership read error allows a terminal red status instead of suppressing delivery', async () => {
  const run = reviewRun();
  await run.start();
  const original = run.github.paginate;
  let reads = 0;
  run.github.paginate = async (...parameters) => {
    if (++reads >= 2) throw new Error('Ownership comments unavailable');

    return original(...parameters);
  };

  const output = await run.runStep('comment');
  assert.equal(output['stale-delivery'], 'false');
  assert.equal(run.stepEnabled('status'), true);
  await run.runStep('status');
  assert.equal(run.statuses[0].state, 'failure');
  assert.equal(run.statuses[0].description, signOffDescription);
});

test('a deleted report comment does not suppress the terminal status', async () => {
  const run = reviewRun();
  await run.start();
  const original = run.github.rest.pulls.get;
  run.github.rest.pulls.get = async (...parameters) => {
    run.github.rest.pulls.get = original;
    run.comments.length = 0;

    return original(...parameters);
  };

  const output = await run.runStep('comment');
  assert.equal(output['stale-delivery'], 'false');
  assert.equal(run.stepEnabled('status'), true);
  await run.runStep('status');
  assert.equal(run.statuses[0].state, 'failure');
});

test('an outsider receipt with an unavailable permission lookup cannot block a valid report', async () => {
  const run = reviewRun();
  await run.start();
  const outsiderBody = '<!-- styleproof-report -->\n<!-- styleproof-run-id:900 run-attempt:9 -->';
  run.comments.push({ id: 99, user: { type: 'User', login: 'outsider' }, body: outsiderBody });
  run.github.rest.repos.getCollaboratorPermissionLevel = async () => {
    throw Object.assign(new Error('Not Found'), { status: 404 });
  };

  await run.runStep('comment');
  assert.equal(run.stepEnabled('status'), true);
  assert.equal(run.commentWrites.length, 1);
  await run.runStep('status');
  assert.equal(run.statuses[0].state, 'success');
  assert.equal(run.statuses[0].description, 'Approved by @reviewer (run 555)');
  assert.equal(run.comments[1].body, outsiderBody);
});

test('comment re-check exhaustion clears the tick despite a stale read proving an old approval', async () => {
  const run = reviewRun({ reportStorage: 'branch' });
  await run.start();
  let changes = 0;
  run.callbacks.beforeCommentWrite = () => {
    if (++changes > 7) throw new Error('Approval re-check limit missing');
    run.approve(`reviewer${changes}`, String(600 + changes));
  };

  const output = await run.runStep('comment');
  delete run.callbacks.beforeCommentWrite;
  assert.equal(output['approval-limit-reached'], 'true');
  await run.runStep('status');
  assert.equal(run.statuses[0].state, 'failure');
  const original = run.github.rest.repos.listCommitStatusesForRef;
  run.github.rest.repos.listCommitStatusesForRef = async (...parameters) => ({
    data: (await original(...parameters)).data.filter((status) => status.state !== 'failure'),
  });
  assert.equal((await run.runStep('gate')).approved, 'true', 'the stale read still proves approval');
  await run.reconcileComment();
  assert.match(run.comments[0].body, /- \[ \] \*\*Approve all changes\*\*/);
  assert.doesNotMatch(run.comments[0].body, /approved by|Signed off/);
  assert.equal(run.statuses[0].state, 'failure');
});

test('reconciliation of a near-limit multibyte report uses bounded environment values and preserves live content', async () => {
  const summary = '界'.repeat(64_000);
  const run = reviewRun({ reportMarkdown: `${summary}\n### Details\n` });
  await run.start();
  await run.runStep('comment');
  run.comments[0].body += '\n<!-- live report note -->';
  assert.ok(run.comments[0].body.length < 65_536);
  assert.ok(Buffer.byteLength(run.comments[0].body) > 128 * 1024);
  run.withdraw();
  await run.runStep('status');
  await run.reconcileComment();
  const environment = run.environments['Reconcile review comment'];

  for (const value of Object.values(environment)) assert.ok(Buffer.byteLength(value) < 128 * 1024);

  const launched = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { env: environment, encoding: 'utf8' });
  assert.equal(launched.error, undefined);
  assert.equal(launched.status, 0);
  assert.ok(run.comments[0].body.includes(summary));
  assert.ok(run.comments[0].body.includes('<!-- live report note -->'));
  assert.ok(/- \[ \] \*\*Approve all changes\*\*/.test(run.comments[0].body));
  assert.ok(!/approved by|Signed off/.test(run.comments[0].body));
});
