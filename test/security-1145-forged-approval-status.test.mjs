import assert from 'node:assert/strict';
import test from 'node:test';
import yaml from 'js-yaml';
import { reviewRun } from './review-gate-test-harness.mjs';
import { ciWorkflow, PACKAGE_MANAGERS } from '../bin/init/templates.mjs';

for (const untrustedCapture of [false, true]) {
  test(`1145: deciding comment and status reject forged approval for ${untrustedCapture ? 'fork' : 'same-repository'} capture`, async () => {
    const run = reviewRun({ untrustedCapture });
    run.statuses.length = 0;
    run.addStatus({
      state: 'success',
      description: 'Approved by @someReviewer',
      creator: { login: 'github-actions[bot]', type: 'Bot' },
    });
    // Diagnostic outputs cannot grant authority to either deciding step.
    run.values['steps.gate.outputs.approved'] = 'true';
    run.values['steps.gate.outputs.approver'] = 'someReviewer';
    await run.runStep('comment');
    await run.runStep('status');
    assert.equal(run.statuses[0].state, untrustedCapture ? 'pending' : 'failure');
    assert.match(run.comments[0].body, /- \[ \] \*\*Approve all changes\*\*/);
    assert.doesNotMatch(run.comments[0].body, /approved by|Signed off/);
  });
}

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
