import assert from 'node:assert/strict';
import test from 'node:test';
import { findLaterAttemptReceipt, reviewRunSuperseded } from '../dist/comment-supersession.js';

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

test('later run receipts suppress delivery only for the same head and a trusted writer', async () => {
  const headSha = 'a'.repeat(40);
  const body = (sha, runId = '200') =>
    `<!-- styleproof-sha:${sha} -->\n<!-- styleproof-run-id:${runId} run-attempt:1 -->`;
  for (const [sha, runId, type, permission, later] of [
    [headSha, '200', 'Bot', 'read', true],
    ['b'.repeat(40), '200', 'Bot', 'read', false],
    [headSha, '99', 'Bot', 'read', false],
    [headSha, '200', 'User', 'read', false],
    [headSha, '200', 'User', 'write', false],
  ]) {
    assert.equal(
      await findLaterAttemptReceipt({
        github: { rest: { repos: { getCollaboratorPermissionLevel: async () => ({ data: { permission } }) } } },
        repo: { owner: 'owner', repo: 'repo' },
        headSha,
        runId: '100',
        runAttempt: '2',
        comments: [
          { body: body(sha, runId), user: { type, login: type === 'Bot' ? 'github-actions[bot]' : 'reviewer' } },
        ],
      }),
      later,
    );
  }
});

test('terminal supersession requires a matching latest status URL or trusted same-head receipt', async () => {
  const headSha = 'a'.repeat(40);
  const prefix = 'https://github.com/owner/repo/actions/runs/';
  const body = `<!-- styleproof-report -->\n<!-- styleproof-sha:${headSha} -->\n<!-- styleproof-run-id:200 run-attempt:1 -->`;
  const status = (runId, context = 'StyleProof') => ({ context, target_url: `${prefix}${runId}` });
  const bot = (text = body) => ({ user: { type: 'Bot', login: 'github-actions[bot]' }, body: text });
  for (const [statuses, comments, expected] of [
    [[status('200')], [], true],
    [[status('200/artifacts/77')], [], true],
    [[status('200/attempts/2')], [], true],
    [[status('99')], [], false],
    [[status('100')], [], false],
    [[status('100'), status('200')], [], false],
    [[status('200', 'Other')], [], false],
    [[{ ...status('200'), target_url: `${prefix}200/other` }], [], false],
    [
      [{ ...status('200'), target_url: 'https://github.com/BenSheridanEdwards/StyleProof/actions/runs/200' }],
      [],
      false,
    ],
    [[], [bot()], true],
    [[], [{ ...bot(), user: { type: 'Bot', login: 'other-app[bot]' } }], false],
    [[], [{ ...bot(), user: { type: 'Bot' } }], false],
    [[], [bot(body.replace(headSha, 'b'.repeat(40)))], false],
    [[], [bot(body.replace('<!-- styleproof-report -->', 'other'))], false],
    [[], [{ ...bot(), user: { type: 'User' } }], false],
    [[], [bot('legacy comment')], false],
  ]) {
    const refs = [];
    assert.equal(
      await reviewRunSuperseded({
        github: {
          rest: {
            repos: {
              listCommitStatusesForRef: async ({ ref }) => {
                refs.push(ref);
                return { data: statuses };
              },
            },
            issues: { listComments() {} },
          },
          paginate: async () => comments,
        },
        repo: { owner: 'owner', repo: 'repo' },
        headSha,
        prNumber: 7,
        runId: '100',
        runAttempt: '1',
        statusContext: 'StyleProof',
        commentMarker: '<!-- styleproof-report -->',
      }),
      expected,
    );
    assert.deepEqual(refs, [headSha]);
  }
});

for (const [runId, type, login, permission, expected] of [
  ['200', 'Bot', 'github-actions[bot]', 'read', true],
  ['200', 'Bot', 'other-app[bot]', 'write', false],
  ['200', 'Bot', undefined, 'read', false],
  ['200', 'User', 'writer', 'write', false],
  ['100', 'Bot', 'other-app[bot]', 'read', true],
  ['100', 'User', 'writer', 'write', true],
  ['100', 'User', 'reader', 'read', false],
]) {
  test(`receipt trust for run ${runId}, ${type} ${login}, permission ${permission}`, async () => {
    let lookups = 0;
    const result = await findLaterAttemptReceipt({
      github: {
        rest: {
          repos: {
            getCollaboratorPermissionLevel: async () => {
              lookups += 1;
              return { data: { permission } };
            },
          },
        },
      },
      repo: { owner: 'owner', repo: 'repo' },
      headSha: 'a'.repeat(40),
      runId: '100',
      runAttempt: '1',
      comments: [
        {
          user: { type, login },
          body: `<!-- styleproof-sha:${'a'.repeat(40)} -->\n<!-- styleproof-run-id:${runId} run-attempt:2 -->`,
        },
      ],
    });
    assert.equal(result, expected);
    if (runId !== '100') assert.equal(lookups, 0);
  });
}
