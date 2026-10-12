import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveActionContext } from '../dist/action-context.js';
import * as reviewStatus from '../dist/review-status.js';

const repo = { owner: 'owner', repo: 'repo' };
const sha = 'a'.repeat(40);
const baseSha = 'd'.repeat(40);

function github(data = []) {
  const calls = [];
  return {
    calls,
    client: {
      rest: {
        repos: {
          async listPullRequestsAssociatedWithCommit(args) {
            calls.push(args);
            return { data };
          },
        },
      },
    },
  };
}

test('resolveActionContext reads pull_request identity directly from the event', async () => {
  const mock = github();
  const result = await resolveActionContext({
    eventName: 'pull_request',
    payload: { pull_request: { number: 12, base: { sha: baseSha }, head: { sha } } },
    repo,
    github: mock.client,
  });

  assert.deepEqual(result, { prNumber: '12', baseSha, headSha: sha, untrustedCapture: false });
  assert.deepEqual(mock.calls, []);
});

test('resolveActionContext reads same-repo workflow_run identity from trusted pull_requests', async () => {
  const mock = github();
  const result = await resolveActionContext({
    eventName: 'workflow_run',
    payload: {
      workflow_run: {
        head_sha: sha,
        // The same repository, named in another case: GitHub repository names are case-insensitive.
        head_repository: { full_name: 'OWNER/repo' },
        pull_requests: [{ number: 34, base: { sha: baseSha }, head: { sha } }],
      },
    },
    repo,
    github: mock.client,
  });

  assert.deepEqual(result, { prNumber: '34', baseSha, headSha: sha, untrustedCapture: false });
  assert.deepEqual(mock.calls, []);
});

test('resolveActionContext rejects a non-corresponding embedded workflow_run PR and uses exact-head lookup', async () => {
  const unrelatedHead = 'c'.repeat(40);
  const fallbackBase = 'e'.repeat(40);
  const mock = github([
    // An open PR associated with the commit whose head has since moved on: not the exact head.
    { state: 'open', number: 36, base: { sha: baseSha }, head: { sha: unrelatedHead } },
    { state: 'open', number: 35, base: { sha: fallbackBase }, head: { sha } },
  ]);
  const result = await resolveActionContext({
    eventName: 'workflow_run',
    payload: {
      workflow_run: {
        head_sha: sha,
        head_repository: { full_name: 'Owner/Repo' },
        pull_requests: [{ number: 34, base: { sha: baseSha }, head: { sha: unrelatedHead } }],
      },
    },
    repo,
    github: mock.client,
  });

  assert.deepEqual(result, { prNumber: '35', baseSha: fallbackBase, headSha: sha, untrustedCapture: false });
  assert.deepEqual(mock.calls, [{ ...repo, commit_sha: sha }]);
});

test('resolveActionContext falls back to the PR associated with the trusted workflow_run head SHA', async () => {
  const other = 'b'.repeat(40);
  const mock = github([
    { state: 'open', number: 1, base: { sha: 'e'.repeat(40) }, head: { sha: other } },
    { state: 'closed', number: 2, base: { sha: 'f'.repeat(40) }, head: { sha } },
    { state: 'open', number: 3, base: { sha: baseSha }, head: { sha } },
  ]);
  const result = await resolveActionContext({
    eventName: 'workflow_run',
    payload: {
      workflow_run: {
        head_sha: sha,
        head_repository: { full_name: 'fork-owner/repo' },
        // Artifact content is attacker-controlled in the fork-safe flow; it must not
        // affect which PR or commit receives the privileged comment/status.
        artifact: { prNumber: 999, headSha: other },
      },
    },
    repo,
    github: mock.client,
  });

  assert.deepEqual(result, { prNumber: '3', baseSha, headSha: sha, untrustedCapture: true });
  assert.deepEqual(mock.calls, [{ ...repo, commit_sha: sha }]);

  // An embedded exact-head PR without a base SHA is incomplete: the lookup supplies that PR's base.
  const partial = github([
    { state: 'open', number: 4, base: { sha: 'e'.repeat(40) }, head: { sha } },
    { state: 'open', number: 3, base: { sha: baseSha }, head: { sha } },
  ]);
  const completed = await resolveActionContext({
    eventName: 'workflow_run',
    payload: {
      workflow_run: {
        head_sha: sha,
        head_repository: { full_name: 'owner/repo' },
        pull_requests: [{ number: 3, head: { sha } }],
      },
    },
    repo,
    github: partial.client,
  });
  assert.deepEqual(completed, { prNumber: '3', baseSha, headSha: sha, untrustedCapture: false });
  assert.deepEqual(partial.calls, [{ ...repo, commit_sha: sha }]);
});

test('resolveActionContext rejects incomplete or malformed SHA provenance', async () => {
  for (const [label, base, head] of [
    ['short base', { sha: 'short' }, { sha }],
    ['missing base', {}, { sha }],
    ['missing head', { sha: baseSha }, {}],
    ['over-long base', { sha: `${baseSha}0` }, { sha }],
    ['over-long head', { sha: baseSha }, { sha: `${sha}0` }],
    ['non-hex head', { sha: baseSha }, { sha: 'g'.repeat(40) }],
  ]) {
    const result = await resolveActionContext({
      eventName: 'pull_request',
      payload: { pull_request: { number: 12, base, head } },
      repo,
      github: github().client,
    });
    assert.deepEqual(result, { prNumber: '', baseSha: '', headSha: '', untrustedCapture: false }, label);
  }
});

test('resolveActionContext returns empty outputs when PR identity is missing', async () => {
  // The only associated PR is for another head, though its base SHA is complete.
  const mock = github([{ state: 'open', number: 9, base: { sha: baseSha }, head: { sha: 'c'.repeat(40) } }]);
  const result = await resolveActionContext({
    eventName: 'workflow_run',
    payload: { workflow_run: { head_sha: sha } },
    repo,
    github: mock.client,
  });

  assert.deepEqual(result, { prNumber: '', baseSha: '', headSha: '', untrustedCapture: false });

  const unnumbered = await resolveActionContext({
    eventName: 'pull_request',
    payload: { pull_request: { base: { sha: baseSha }, head: { sha } } },
    repo,
    github: github().client,
  });
  assert.deepEqual(unnumbered, { prNumber: '', baseSha: '', headSha: '', untrustedCapture: false });
});

test('resolveActionContext flags fork captures as untrusted and fails closed without a head repository', async () => {
  const run = (payload, eventName = 'workflow_run') =>
    resolveActionContext({ eventName, payload, repo, github: github().client });
  const pullRequests = [{ number: 34, base: { sha: baseSha }, head: { sha } }];
  const fork = await run({
    workflow_run: { head_sha: sha, head_repository: { full_name: 'fork-owner/repo' }, pull_requests: pullRequests },
  });
  assert.equal(fork.untrustedCapture, true, 'a fork head repository is untrusted');
  const missing = await run({ workflow_run: { head_sha: sha, pull_requests: pullRequests } });
  assert.equal(missing.untrustedCapture, true, 'an unnamed head repository fails closed');
  const deleted = await run({ workflow_run: { head_sha: sha, head_repository: null, pull_requests: pullRequests } });
  assert.equal(deleted.untrustedCapture, true, 'a null (deleted) head repository fails closed');
  const prefixed = await run({
    workflow_run: { head_sha: sha, head_repository: { full_name: 'owner/repo-fork' }, pull_requests: pullRequests },
  });
  assert.equal(prefixed.untrustedCapture, true, 'another repository whose name starts with this one is untrusted');
  const sameRepo = await run({
    workflow_run: { head_sha: sha, head_repository: { full_name: 'owner/repo' }, pull_requests: pullRequests },
  });
  assert.equal(sameRepo.untrustedCapture, false, 'same-repo (incl. Dependabot) captures are unchanged');
  const forkPullRequest = await run(
    { pull_request: { number: 12, base: { sha: baseSha }, head: { sha, repo: { full_name: 'fork-owner/repo' } } } },
    'pull_request',
  );
  assert.equal(forkPullRequest.untrustedCapture, true);
});

test('decideReviewStatus never turns a fork capture green automatically', () => {
  const decide = (trustState, overrides = {}) =>
    reviewStatus.decideReviewStatus({
      trustState,
      approved: false,
      advisoryMode: false,
      untrustedCapture: true,
      ...overrides,
    });
  // Identical fork-uploaded maps read as "no changes": still pending, approvable.
  assert.deepEqual(decide('NO_REVIEWABLE_STYLE_CHANGES'), {
    state: 'pending',
    approvable: true,
    awaitingMaintainer: true,
  });
  assert.deepEqual(decide('STYLE_REVIEW_REQUIRED'), { state: 'pending', approvable: true, awaitingMaintainer: true });
  assert.equal(decide('NO_REVIEWABLE_STYLE_CHANGES', { advisoryMode: true }).state, 'pending');
  assert.equal(decide('CERTIFICATION_FAILED').state, 'failure');
  assert.equal(decide('CERTIFICATION_FAILED', { advisoryMode: true }).state, 'pending');
  // Advisory mode never turns a fork green either, whatever the verdict.
  for (const trustState of [
    'STYLE_REVIEW_REQUIRED',
    'DATA_RESIDUE_UNACKNOWLEDGED',
    'INVENTORY_REMOVAL_UNACKNOWLEDGED',
    'PARTIAL_BASELINE',
    'DEGRADED_BASELINE',
  ]) {
    assert.equal(decide(trustState, { advisoryMode: true }).state, 'pending', trustState);
  }
  // Only a maintainer approval turns it green.
  assert.equal(decide('NO_REVIEWABLE_STYLE_CHANGES', { approved: true }).state, 'success');
  assert.equal(decide('STYLE_REVIEW_REQUIRED', { approved: true }).state, 'success');
  assert.match(reviewStatus.UNTRUSTED_CAPTURE_STATUS_DESCRIPTION, /^Fork PR — .*maintainer approval required$/);
});

test('decideReviewStatus leaves same-repo verdicts unchanged', () => {
  const decide = (trustState, overrides = {}) =>
    reviewStatus.decideReviewStatus({
      trustState,
      approved: false,
      advisoryMode: false,
      untrustedCapture: false,
      ...overrides,
    });
  assert.deepEqual(decide('NO_REVIEWABLE_STYLE_CHANGES'), {
    state: 'success',
    approvable: false,
    awaitingMaintainer: false,
  });
  assert.deepEqual(decide('STYLE_REVIEW_REQUIRED'), { state: 'failure', approvable: true, awaitingMaintainer: false });
  assert.equal(decide('STYLE_REVIEW_REQUIRED', { approved: true }).state, 'success');
  assert.equal(decide('CERTIFICATION_FAILED').state, 'failure');
  assert.equal(decide('CERTIFICATION_FAILED', { approved: true }).state, 'failure');
  assert.equal(decide('CERTIFICATION_FAILED', { advisoryMode: true }).state, 'success');
});
