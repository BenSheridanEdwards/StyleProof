import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APPROVER,
  GATE_AUTHOR,
  STATUS_CONTEXT,
  enforcementProblems,
  run,
  signoffComment,
} from '../scripts/enforcement-approval.mjs';

test('1149: a bot status from PR code cannot preserve a forged enforcement sign-off', async () => {
  const head = 'a'.repeat(40);
  const path = '.husky/pre-commit';
  const problems = enforcementProblems([{ path, before: 'npm run lint', after: 'true' }]);

  const comment = {
    id: 1,
    user: { login: GATE_AUTHOR, type: 'Bot' },
    body: signoffComment({
      head,
      problems,
      approval: { name: 'Reviewer', login: APPROVER, at: new Date('2026-10-12T14:00:00Z') },
    }),
  };

  const statuses = [];
  const updates = [];

  const github = {
    rest: {
      pulls: {
        get: async () => ({ data: { head: { sha: head }, base: { sha: 'base' } } }),
        listFiles: async () => ({ data: [{ filename: path }] }),
      },
      issues: {
        listComments: async () => ({ data: [comment] }),
        updateComment: async (parameters) => {
          updates.push(parameters);
        },
      },
      repos: {
        compareCommitsWithBasehead: async () => ({ data: { merge_base_commit: { sha: 'base' } } }),
        getContent: async ({ ref }) => ({ data: ref === head ? 'true' : 'npm run lint' }),
        listCommitStatusesForRef: async () => ({
          data: [
            {
              context: STATUS_CONTEXT,
              creator: { login: GATE_AUTHOR, type: 'Bot' },
              state: 'success',
              description: `${APPROVER} signed off at ${head.slice(0, 7)}`,
              target_url: 'https://github.com/owner/repo/actions/runs/123',
            },
          ],
        }),
        createCommitStatus: async (parameters) => {
          statuses.push(parameters);
        },
      },
      actions: {
        getWorkflowRun: async () => ({
          data: { id: 123, path: '.github/workflows/capture.yml', head_branch: 'feature', event: 'pull_request' },
        }),
        listWorkflowRuns: async () => ({ data: { total_count: 0, workflow_runs: [] } }),
      },
    },
  };

  github.paginate = async (method, parameters) => (await method(parameters)).data;
  await run({
    github,
    context: {
      repo: { owner: 'owner', repo: 'repo' },
      eventName: 'pull_request_target',
      payload: { action: 'synchronize', pull_request: { number: 7 }, repository: { default_branch: 'main' } },
    },
    core: { info: () => {} },
  });
  assert.equal(
    statuses.at(-1)?.state,
    'pending',
    'forged bot success remains standing without a default-branch enforcement approval run',
  );
  assert.equal(updates.at(-1)?.body, signoffComment({ head, problems }), 'forged approval label must be cleared');
});
