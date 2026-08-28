import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveActionContext } from '../dist/action-context.js';

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

  assert.deepEqual(result, { prNumber: '12', baseSha, headSha: sha });
  assert.deepEqual(mock.calls, []);
});

test('resolveActionContext reads same-repo workflow_run identity from trusted pull_requests', async () => {
  const mock = github();
  const result = await resolveActionContext({
    eventName: 'workflow_run',
    payload: {
      workflow_run: { head_sha: sha, pull_requests: [{ number: 34, base: { sha: baseSha }, head: { sha } }] },
    },
    repo,
    github: mock.client,
  });

  assert.deepEqual(result, { prNumber: '34', baseSha, headSha: sha });
  assert.deepEqual(mock.calls, []);
});

test('resolveActionContext rejects a non-corresponding embedded workflow_run PR and uses exact-head lookup', async () => {
  const unrelatedHead = 'c'.repeat(40);
  const fallbackBase = 'e'.repeat(40);
  const mock = github([{ state: 'open', number: 35, base: { sha: fallbackBase }, head: { sha } }]);
  const result = await resolveActionContext({
    eventName: 'workflow_run',
    payload: {
      workflow_run: {
        head_sha: sha,
        pull_requests: [{ number: 34, base: { sha: baseSha }, head: { sha: unrelatedHead } }],
      },
    },
    repo,
    github: mock.client,
  });

  assert.deepEqual(result, { prNumber: '35', baseSha: fallbackBase, headSha: sha });
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
        // Artifact content is attacker-controlled in the fork-safe flow; it must not
        // affect which PR or commit receives the privileged comment/status.
        artifact: { prNumber: 999, headSha: other },
      },
    },
    repo,
    github: mock.client,
  });

  assert.deepEqual(result, { prNumber: '3', baseSha, headSha: sha });
  assert.deepEqual(mock.calls, [{ ...repo, commit_sha: sha }]);
});

test('resolveActionContext rejects incomplete or malformed SHA provenance', async () => {
  const mock = github();
  const result = await resolveActionContext({
    eventName: 'pull_request',
    payload: { pull_request: { number: 12, base: { sha: 'short' }, head: { sha } } },
    repo,
    github: mock.client,
  });

  assert.deepEqual(result, { prNumber: '', baseSha: '', headSha: '' });
});

test('resolveActionContext returns empty outputs when PR identity is missing', async () => {
  const mock = github([{ state: 'open', number: 9, head: { sha: 'c'.repeat(40) } }]);
  const result = await resolveActionContext({
    eventName: 'workflow_run',
    payload: { workflow_run: { head_sha: sha } },
    repo,
    github: mock.client,
  });

  assert.deepEqual(result, { prNumber: '', baseSha: '', headSha: '' });
});
