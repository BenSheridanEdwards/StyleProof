import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import yaml from 'js-yaml';
import { ciWorkflow, PACKAGE_MANAGERS } from '../bin/init/templates.mjs';

const action = yaml.load(fs.readFileSync(new URL('../action.yml', import.meta.url), 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

test('1145: a bot status without an approve-workflow run cannot carry approval forward', async () => {
  const outputs = {};

  const github = {
    rest: {
      repos: {
        listCommitStatusesForRef: async () => ({
          data: [
            {
              context: 'StyleProof',
              state: 'success',
              description: 'Approved by @someReviewer',
              creator: { login: 'github-actions[bot]', type: 'Bot' },
              target_url: 'https://github.com/owner/repo/actions/runs/123',
            },
          ],
        }),
      },
      actions: {
        getWorkflowRun: async () => ({
          data: { id: 123, path: '.github/workflows/capture.yml', event: 'pull_request', head_branch: 'feature' },
        }),
        listWorkflowRuns: async () => ({ data: { total_count: 0, workflow_runs: [] } }),
      },
    },
  };

  const source = action.runs.steps
    .find((step) => step.id === 'gate')
    .with.script.replaceAll('${{ steps.diff.outputs.changed }}', 'true')
    .replaceAll('${{ steps.context.outputs.head-sha }}', 'a'.repeat(40))
    .replaceAll('${{ steps.context.outputs.untrusted-capture }}', 'false');

  const previousPrior = process.env.STYLEPROOF_PRIOR_STATUS;
  process.env.STYLEPROOF_PRIOR_STATUS = JSON.stringify((await github.rest.repos.listCommitStatusesForRef()).data[0]);
  const previous = process.env.STYLEPROOF_STATUS_CONTEXT;
  process.env.STYLEPROOF_STATUS_CONTEXT = 'StyleProof';

  try {
    await new AsyncFunction('github', 'context', 'core', source)(
      github,
      { repo: { owner: 'owner', repo: 'repo' } },
      {
        setOutput: (key, value) => {
          outputs[key] = value;
        },
      },
    );
  } finally {
    if (previousPrior === undefined) delete process.env.STYLEPROOF_PRIOR_STATUS;
    else process.env.STYLEPROOF_PRIOR_STATUS = previousPrior;

    if (previous === undefined) delete process.env.STYLEPROOF_STATUS_CONTEXT;
    else process.env.STYLEPROOF_STATUS_CONTEXT = previous;
  }

  assert.equal(outputs.approved, 'false', 'a capture job can impersonate the approval bot with its GITHUB_TOKEN');
  assert.equal(outputs.approver, '');
});

test('1145: generated branch-storage capture cannot use a status-writing job token', () => {
  const workflow = yaml.load(
    ciWorkflow({
      scaffold: { workflow: 'single', storage: 'branch', gate: 'review-gate', branch: 'main' },
      PM: PACKAGE_MANAGERS.npm,
    }),
  );

  for (const job of Object.values(workflow.jobs)) {
    const permission = (job.permissions ?? workflow.permissions)?.statuses;

    for (const step of job.steps ?? []) {
      if (step.env?.STYLEPROOF_MAP_STORE_TOKEN === '${{ github.token }}') {
        assert.notEqual(permission, 'write', 'PR-code capture receives github.token in a job with statuses: write');
      }
    }
  }
});
