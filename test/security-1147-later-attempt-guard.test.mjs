import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewRun, headCommit } from './review-gate-test-harness.mjs';

for (const stepIdentifier of ['comment', 'review-pending']) {
  for (const association of ['MEMBER', 'COLLABORATOR']) {
    for (const permission of ['read', 'write']) {
      test(`1147: ${association} with ${permission} permission controls ${stepIdentifier} delivery`, async () => {
        const run = reviewRun();
        const permissionCalls = [];
        run.comments.push({
          id: 99,
          user: { type: 'User', login: 'reviewer' },
          author_association: association,
          body: `<!-- styleproof-report -->\n<!-- styleproof-sha:${headCommit} -->\n<!-- styleproof-run-id:900 run-attempt:99 -->`,
        });
        run.github.rest.repos.getCollaboratorPermissionLevel = async (parameters) => {
          permissionCalls.push(parameters.username);

          return { data: { permission } };
        };

        const outputs = await run.runStep(stepIdentifier);
        assert.deepEqual(permissionCalls, ['reviewer']);
        assert.equal(outputs['stale-delivery'], permission === 'write' ? 'true' : 'false');
        assert.equal(run.statusWrites.length, stepIdentifier === 'review-pending' && permission === 'read' ? 1 : 0);
        assert.equal(run.commentWrites.length, stepIdentifier === 'comment' && permission === 'read' ? 1 : 0);
      });
    }
  }
}
