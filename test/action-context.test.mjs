import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveActionContext } from '../dist/action-context.js';

const repo = { owner: 'owner', repo: 'repo' };
const sha = 'a'.repeat(40);

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
    payload: { pull_request: { number: 12, head: { sha } } },
    repo,
    github: mock.client,
  });

  assert.deepEqual(result, { prNumber: '12', headSha: sha });
  assert.deepEqual(mock.calls, []);
});

test('resolveActionContext reads same-repo workflow_run identity from trusted pull_requests', async () => {
  const mock = github();
  const result = await resolveActionContext({
    eventName: 'workflow_run',
    payload: { workflow_run: { head_sha: sha, pull_requests: [{ number: 34 }] } },
    repo,
    github: mock.client,
  });

  assert.deepEqual(result, { prNumber: '34', headSha: sha });
  assert.deepEqual(mock.calls, []);
});

test('resolveActionContext falls back to the PR associated with the trusted workflow_run head SHA', async () => {
  const other = 'b'.repeat(40);
  const mock = github([
    { state: 'open', number: 1, head: { sha: other } },
    { state: 'closed', number: 2, head: { sha } },
    { state: 'open', number: 3, head: { sha } },
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

  assert.deepEqual(result, { prNumber: '3', headSha: sha });
  assert.deepEqual(mock.calls, [{ ...repo, commit_sha: sha }]);
});

test('resolveActionContext returns empty outputs when PR identity is missing', async () => {
  const mock = github([{ state: 'open', number: 9, head: { sha: 'c'.repeat(40) } }]);
  const result = await resolveActionContext({
    eventName: 'workflow_run',
    payload: { workflow_run: { head_sha: sha } },
    repo,
    github: mock.client,
  });

  assert.deepEqual(result, { prNumber: '', headSha: '' });
});
