import assert from 'node:assert/strict';
import test from 'node:test';
import { readReviewApproval } from '../dist/review-approval.js';

const headCommit = 'a'.repeat(40);
const reviewDigest = 'd'.repeat(64);
const canonicalCreator = { type: 'Bot', login: 'github-actions[bot]' };

const originalApproval = {
  id: 1,
  context: 'StyleProof',
  state: 'success',
  description: 'Approved by @reviewer (run 555)',
  created_at: '2026-11-04T09:00:30Z',
  creator: canonicalCreator,
};

const workflowRun = {
  status: 'completed',
  conclusion: 'success',
  event: 'issue_comment',
  head_branch: 'main',
  triggering_actor: { login: 'reviewer' },
  run_started_at: '2026-11-04T09:00:00Z',
  updated_at: '2026-11-04T09:01:00Z',
};

const artifact = { name: `styleproof-approval-7-${headCommit}-${reviewDigest}`, expired: false };

const pending = {
  ...originalApproval,
  id: 2,
  state: 'pending',
  description: 'StyleProof report running — no verdict yet',
  created_at: '2026-11-04T10:00:00Z',
};

const withdrawal = {
  ...pending,
  id: 3,
  state: 'failure',
  description: 'Approval withdrawn by @reviewer — re-run StyleProof for a verdict',
};

function approvalInput({ statuses = [pending, originalApproval], run = workflowRun, artifacts = [artifact] } = {}) {
  return {
    github: {
      rest: {
        repos: { listCommitStatusesForRef: async () => ({ data: statuses }) },
        actions: {
          getWorkflowRun: async () => ({ data: run }),
          listWorkflowRunArtifacts: async () => ({ data: { artifacts } }),
        },
      },
    },
    repository: { owner: 'owner', repo: 'repository' },
    headCommit,
    pullRequestNumber: 7,
    statusContext: 'StyleProof',
    defaultBranch: 'main',
    reviewDigest,
  };
}

test('live approval validates original and carry-forward receipts through canonical running statuses', async () => {
  const carryForward = { ...originalApproval, id: 4, created_at: '2026-11-04T10:00:30Z' };
  const input = approvalInput({ statuses: [pending, carryForward, originalApproval] });
  assert.deepEqual(await readReviewApproval(input), {
    approved: true,
    approver: 'reviewer',
    description: originalApproval.description,
    withdrawn: false,
  });
});

for (const [name, status] of [
  ['foreign bot', { creator: { type: 'Bot', login: 'another-bot[bot]' } }],
  ['human creator', { creator: { type: 'User', login: 'github-actions[bot]' } }],
  ['wrong context', { context: 'Another check' }],
  ['anonymous approval', { description: 'StyleProof changes approved' }],
  ['missing run', { description: 'Approved by @reviewer' }],
  ['zero run', { description: 'Approved by @reviewer (run 0)' }],
  ['failed approval', { state: 'failure' }],
  ['invalid timestamp', { created_at: 'unknown' }],
  ['receipt before run', { created_at: '2026-11-04T08:59:59Z' }],
  ['receipt beyond run window', { created_at: '2026-11-04T09:01:06Z' }],
]) {
  test(`live approval rejects ${name}`, async () => {
    const input = approvalInput({ statuses: [{ ...originalApproval, ...status }] });
    assert.equal((await readReviewApproval(input)).approved, false);
  });
}

for (const [name, change] of [
  ['unfinished workflow', { status: 'in_progress' }],
  ['unsuccessful workflow', { conclusion: 'failure' }],
  ['different event', { event: 'push' }],
  ['different branch', { head_branch: 'feature' }],
  ['different actor', { triggering_actor: { login: 'another-reviewer' } }],
  ['missing actor', { triggering_actor: null }],
  ['invalid start', { run_started_at: 'unknown' }],
  ['invalid end', { updated_at: 'unknown' }],
  ['end before start', { updated_at: '2026-11-04T08:00:00Z' }],
]) {
  test(`live approval rejects ${name}`, async () => {
    assert.equal((await readReviewApproval(approvalInput({ run: { ...workflowRun, ...change } }))).approved, false);
  });
}

for (const [name, change] of [
  ['another digest', { reviewDigest: 'e'.repeat(64) }],
  ['malformed digest', { reviewDigest: 'invalid' }],
  ['another head', { headCommit: 'b'.repeat(40) }],
  ['another pull request', { pullRequestNumber: 8 }],
  ['unknown default branch', { defaultBranch: '' }],
]) {
  test(`live approval rejects ${name}`, async () => {
    assert.equal((await readReviewApproval({ ...approvalInput(), ...change })).approved, false);
  });
}

for (const [name, artifacts] of [
  ['missing artifact', []],
  ['expired artifact', [{ ...artifact, expired: true }]],
]) {
  test(`live approval rejects ${name}`, async () => {
    assert.equal((await readReviewApproval(approvalInput({ artifacts }))).approved, false);
  });
}

test('carry-forward cannot substitute for a missing original receipt', async () => {
  const carried = { ...originalApproval, created_at: '2026-11-04T10:00:00Z' };
  assert.equal((await readReviewApproval(approvalInput({ statuses: [carried] }))).approved, false);
});

for (const interrupt of [
  withdrawal,
  { ...pending, state: 'failure', description: 'Evidence incomplete' },
  { ...pending, creator: { type: 'Bot', login: 'another-bot[bot]' } },
]) {
  test(`an intervening ${interrupt.description} revokes carry-forward`, async () => {
    const carried = { ...originalApproval, id: 4, created_at: '2026-11-04T11:00:00Z' };
    const input = approvalInput({ statuses: [carried, interrupt, pending, originalApproval] });
    assert.equal((await readReviewApproval(input)).approved, false);
  });
}

test('new valid approval supersedes withdrawal without falling back to the saved receipt', async () => {
  const retick = {
    ...originalApproval,
    id: 4,
    description: 'Approved by @Reviewer (run 556)',
    created_at: '2026-11-04T10:01:00Z',
  };

  const input = approvalInput({
    statuses: [retick, withdrawal, pending, originalApproval],
    run: { ...workflowRun, run_started_at: retick.created_at, updated_at: retick.created_at },
  });

  assert.equal((await readReviewApproval(input)).approved, true);
  // Invalid latest approvals must not cause a fallback across the withdrawal.
  input.github.rest.actions.listWorkflowRunArtifacts = async () => ({ data: { artifacts: [] } });
  assert.equal((await readReviewApproval(input)).approved, false);
});

test('compare-and-set excludes only its own success and observes a valid re-tick underneath', async () => {
  const retick = {
    ...originalApproval,
    id: 4,
    description: 'Approved by @reviewer (run 556)',
    created_at: '2026-11-04T10:01:00Z',
  };

  const ownSuccess = { ...originalApproval, id: 5, created_at: '2026-11-04T10:02:00Z' };

  const input = approvalInput({
    statuses: [ownSuccess, retick, withdrawal, pending, originalApproval],
    run: { ...workflowRun, run_started_at: retick.created_at, updated_at: retick.created_at },
  });

  assert.equal((await readReviewApproval(input)).approved, false);
  assert.equal((await readReviewApproval({ ...input, ignoredStatusIdentifier: 5 })).approved, true);
  assert.equal((await readReviewApproval({ ...input, ignoredStatusIdentifier: 3 })).approved, false);
});

test('the live withdrawal is exposed for the red sign-off status, with unrelated contexts ignored', async () => {
  const input = approvalInput({
    statuses: [{ ...originalApproval, context: 'Another check' }, withdrawal, pending, originalApproval],
  });

  assert.deepEqual(await readReviewApproval(input), {
    approved: false,
    approver: '',
    description: '',
    withdrawn: true,
  });
});

test('a newer genuine receipt survives stale carry-forward from an older approval on subsequent reads', async () => {
  const fresh = {
    ...originalApproval,
    id: 4,
    description: 'Approved by @reviewer (run 556)',
    created_at: '2026-11-04T10:01:00Z',
  };

  const stale = { ...originalApproval, id: 5, created_at: '2026-11-04T10:02:00Z' };
  const corrected = { ...fresh, id: 6, created_at: '2026-11-04T10:03:00Z' };
  const statuses = [corrected, stale, fresh, withdrawal, pending, originalApproval];
  const input = approvalInput({ statuses });
  input.github.rest.actions.getWorkflowRun = async ({ run_id }) => ({
    data:
      run_id === '555'
        ? workflowRun
        : { ...workflowRun, run_started_at: fresh.created_at, updated_at: fresh.created_at },
  });
  assert.equal((await readReviewApproval(input)).description, fresh.description);
  assert.equal((await readReviewApproval({ ...input, ignoredStatusIdentifier: 6 })).description, fresh.description);
  // Proof for an older copied description is still required; an arbitrary success
  // above the fresh receipt cannot be silently skipped.
  statuses[1] = { ...stale, description: 'Approved by @another-reviewer (run 557)' };
  assert.equal((await readReviewApproval(input)).approved, false);
});

test('a carry-forward inside the workflow timestamp window cannot revive an original revoked receipt', async () => {
  const carried = { ...originalApproval, id: 4, created_at: '2026-11-04T09:00:32Z' };

  const input = approvalInput({
    statuses: [carried, { ...withdrawal, created_at: '2026-11-04T09:00:31Z' }, originalApproval],
  });

  assert.equal((await readReviewApproval(input)).approved, false);
});

test('an unavailable older approval run cannot invalidate a newer genuine receipt', async () => {
  const fresh = { ...originalApproval, description: 'Approved by @reviewer (run 556)' };
  const input = approvalInput({ statuses: [fresh, originalApproval] });
  input.github.rest.actions.getWorkflowRun = async ({ run_id }) => {
    assert.equal(run_id, '556', 'older history cannot revoke a newer original receipt');

    return { data: workflowRun };
  };

  assert.equal((await readReviewApproval(input)).description, fresh.description);
});

for (const endpoint of ['listCommitStatusesForRef', 'getWorkflowRun', 'listWorkflowRunArtifacts']) {
  test(`live approval fails closed when ${endpoint} is unavailable`, async () => {
    const input = approvalInput();
    const client = endpoint === 'listCommitStatusesForRef' ? input.github.rest.repos : input.github.rest.actions;
    client[endpoint] = async () => {
      throw new Error('unavailable');
    };

    assert.equal((await readReviewApproval(input)).approved, false);
  });
}
