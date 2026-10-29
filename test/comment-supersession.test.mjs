import assert from 'node:assert/strict';
import test from 'node:test';
import { findLaterAttemptReceipt } from '../dist/comment-supersession.js';

test('later receipts cache writer checks and distrust permission lookup errors', async () => {
  const lookups = [];

  const github = {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async ({ username }) => {
          lookups.push(username);

          if (username === 'unavailable') throw new Error('unavailable');

          return { data: { permission: username } };
        },
      },
    },
  };

  const check = (logins) =>
    findLaterAttemptReceipt({
      github,
      repo: { owner: 'owner', repo: 'repo' },
      runId: '42',
      runAttempt: '1',
      comments: logins.map((login) => ({
        body: '<!-- styleproof-run-id:42 run-attempt:2 -->',
        user: { login, type: 'User' },
      })),
    });

  assert.equal(await check(['read', 'READ', 'unavailable']), false);
  assert.deepEqual(lookups, ['read', 'unavailable']);

  for (const permission of ['write', 'maintain', 'admin']) assert.equal(await check([permission]), true);
});
