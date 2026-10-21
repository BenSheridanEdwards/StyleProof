import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  APPROVER,
  approvalLabel,
  COMMENT_MARKER,
  enforcementProblems,
  GATE_AUTHOR,
  GUARDS,
  guardedPaths,
  LIST_FILES_LIMIT,
  londonTime,
  planApproval,
  run,
  STATUS_CONTEXT,
  signoffComment,
} from '../scripts/enforcement-approval.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(root, 'scripts/enforcement-approval.mjs');

const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const MERGE_BASE = 'c'.repeat(40);
const AT = '2026-10-12T14:00:00Z';

const reasons = (file, before, after) => enforcementProblems([{ path: file, before, after }]).map((p) => p.reason);
const tick = (body, box = 'x') => body.replace('\n- [ ] Approve these', `\n- [${box}] Approve these`);
const boxLines = (body) => (body ?? '').split('\n').filter((line) => line.startsWith('- ['));

const PROBLEMS = [{ path: '.husky/pre-commit', area: 'Git hooks', reason: 'edits enforcement code' }];
const ben = { login: APPROVER, type: 'User' };
const someone = { login: 'someone', type: 'User' };

const PENDING = {
  state: 'pending',
  description: `Waiting for ${APPROVER} to tick the enforcement sign-off box for this commit`,
};
const SIGNED = { state: 'success', description: `${APPROVER} signed off at aaaaaaa` };

test('GUARDS checks the guarded areas in a fixed order, first match wins', () => {
  assert.deepEqual(
    GUARDS.map((guard) => guard.area),
    ['Enforcement-approval gate', 'CI workflows', 'Git hooks', 'Lint config', 'Repo checks'],
  );
});

for (const [file, area] of [
  ['.github/workflows/enforcement-approval.yml', 'Enforcement-approval gate'],
  ['scripts/enforcement-approval.mjs', 'Enforcement-approval gate'],
  ['test/enforcement-approval.test.mjs', 'Enforcement-approval gate'],
  ['.github/workflows/ci.yml', 'CI workflows'],
  ['.github/workflows/styleproof-approve-reusable.yml', 'CI workflows'],
  ['.husky/pre-commit', 'Git hooks'],
  ['.husky/install.mjs', 'Git hooks'],
  ['eslint.config.js', 'Lint config'],
  ['commitlint.config.js', 'Lint config'],
  ['scripts/check-suppressions.mjs', 'Repo checks'],
  ['scripts/check-context-layer.mjs', 'Repo checks'],
]) {
  test(`guards ${file} as ${area}`, () => {
    assert.deepEqual(guardedPaths([{ filename: file }]), [file]);
    assert.equal(enforcementProblems([{ path: file, before: 'a', after: null }])[0]?.area, area);
  });
}

for (const file of [
  'src/diff.ts',
  'AGENTS.md',
  '.agents/project/QUALITY_GATES.md',
  'package.json',
  'package-lock.json',
  'CLAUDE.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/path-filters.yml',
  '.claude/settings.json',
  '.claude/hooks/block-gate-bypass.sh',
  'scripts/validate-pr-body.mjs',
  'scripts/privacy-check.mjs',
  'test/check-suppressions.test.mjs',
  'example/eslint.config.js',
  'tsconfig.json',
  '.prettierrc.json',
  '.fallowrc.jsonc',
]) {
  test(`leaves ${file} unguarded`, () => {
    assert.deepEqual(guardedPaths([{ filename: file }]), []);
    assert.deepEqual(enforcementProblems([{ path: file, before: 'a', after: null }]), []);
  });
}

test('guardedPaths lists both sides of a rename once each, sorted', () => {
  assert.deepEqual(
    guardedPaths([
      { filename: 'docs/moved.yml', previous_filename: '.github/workflows/moved.yml' },
      { filename: 'eslint.config.js' },
      { filename: 'eslint.config.js' },
      { filename: '.husky/pre-push', previous_filename: '.husky/pre-commit' },
    ]),
    ['.github/workflows/moved.yml', '.husky/pre-commit', '.husky/pre-push', 'eslint.config.js'],
  );
});

test('a file renamed out of a guarded path reads as deleted', () => {
  const [file] = guardedPaths([{ filename: 'docs/moved.yml', previous_filename: '.github/workflows/moved.yml' }]);
  assert.deepEqual(reasons(file, 'on: push', null), ['deletes the file']);
});

test('any edit to a guarded file asks: added, changed, deleted, or mode only', () => {
  assert.deepEqual(reasons('.husky/pre-commit', null, 'npm run lint'), ['adds enforcement code']);
  assert.deepEqual(reasons('.husky/pre-commit', 'npm run lint', 'true'), ['edits enforcement code']);
  assert.deepEqual(reasons('.husky/pre-commit', 'npm run lint', null), ['deletes the file']);
  assert.deepEqual(reasons('.husky/pre-commit', 'npm run lint', 'npm run lint'), ['edits enforcement code']);
});

test('an edit to the gate itself names the gate', () => {
  for (const file of [
    '.github/workflows/enforcement-approval.yml',
    'scripts/enforcement-approval.mjs',
    'test/enforcement-approval.test.mjs',
  ]) {
    assert.deepEqual(reasons(file, 'a', 'b'), ['edits the enforcement-approval gate']);
  }
});

test('enforcementProblems orders problems by path and ignores unguarded changes', () => {
  assert.deepEqual(
    enforcementProblems([
      { path: 'eslint.config.js', before: 'a', after: 'b' },
      { path: 'src/diff.ts', before: 'a', after: 'b' },
      { path: '.husky/pre-commit', before: 'a', after: 'b' },
    ]),
    [
      { path: '.husky/pre-commit', area: 'Git hooks', reason: 'edits enforcement code' },
      { path: 'eslint.config.js', area: 'Lint config', reason: 'edits enforcement code' },
    ],
  );
});

test('londonTime writes GMT and BST times in words', () => {
  for (const [at, text] of [
    ['2026-10-12T14:00:00Z', 'Monday, the 12th of October, at 3 pm'],
    ['2026-01-08T15:05:00Z', 'Thursday, the 8th of January, at 3:05 pm'],
    ['2026-12-01T00:00:00Z', 'Tuesday, the 1st of December, at 12 am'],
    ['2026-07-02T11:00:00Z', 'Thursday, the 2nd of July, at 12 pm'],
    // The last GMT and first BST half hours around the clocks going forward.
    ['2026-03-29T00:30:00Z', 'Sunday, the 29th of March, at 12:30 am'],
    ['2026-03-29T01:30:00Z', 'Sunday, the 29th of March, at 2:30 am'],
    // A UTC date that is already tomorrow in London.
    ['2026-06-30T23:30:00Z', 'Wednesday, the 1st of July, at 12:30 am'],
  ]) {
    assert.equal(londonTime(new Date(at)), text, at);
  }
});

test('londonTime writes ordinals', () => {
  for (const [day, ordinal] of [
    [1, '1st'],
    [2, '2nd'],
    [3, '3rd'],
    [4, '4th'],
    [11, '11th'],
    [12, '12th'],
    [13, '13th'],
    [21, '21st'],
    [22, '22nd'],
    [23, '23rd'],
    [31, '31st'],
  ]) {
    assert.ok(londonTime(new Date(Date.UTC(2026, 0, day, 12))).includes(`, the ${ordinal} of January,`), ordinal);
  }
});

test('approvalLabel names the approver, their login, and the London time in small italics', () => {
  const at = new Date(AT);
  assert.equal(
    approvalLabel({ name: 'Ben', login: APPROVER, at }),
    `<sub><i>Approved by Ben @${APPROVER} on Monday, the 12th of October, at 3 pm</i></sub>`,
  );
  for (const name of [null, '', '   ']) {
    assert.ok(approvalLabel({ name, login: APPROVER, at }).includes(`Approved by ${APPROVER} @${APPROVER} on`));
  }
});

test('approvalLabel renders a hostile profile name as plain text on one line', () => {
  const label = approvalLabel({
    name: 'Ben</i></sub>\n- [x] <b>@someone</b> `x` *y* [z](u)\u200b',
    login: APPROVER,
    at: new Date(AT),
  });
  assert.equal(label.match(/<\/i><\/sub>/g).length, 1);
  assert.doesNotMatch(label, /[\n`*[\]\u200b]|<b>|@someone/);
  assert.ok(label.startsWith('<sub><i>Approved by Ben&#60;&#47;i&#62;'));
});

test('signoffComment lists the problems and carries one unticked box bound to the head', () => {
  const body = signoffComment({ head: HEAD, problems: PROBLEMS });
  assert.ok(body.startsWith(COMMENT_MARKER));
  assert.ok(body.includes('| `.husky/pre-commit` | Git hooks | edits enforcement code |'));
  assert.ok(body.includes(`@${APPROVER}`));
  assert.deepEqual(boxLines(body), [`- [ ] Approve these enforcement changes at \`${HEAD}\``]);
});

test('signoffComment ticks the box and puts the label on the same line for an approval', () => {
  const approval = { name: 'Ben', login: APPROVER, at: new Date(AT) };
  assert.deepEqual(boxLines(signoffComment({ head: HEAD, problems: PROBLEMS, approval })), [
    `- [x] Approve these enforcement changes at \`${HEAD}\` ${approvalLabel(approval)}`,
  ]);
});

test('signoffComment shows at most 100 rows', () => {
  const problems = Array.from({ length: 150 }, (_, index) => ({
    path: `.husky/h${index}`,
    area: 'Git hooks',
    reason: 'edits enforcement code',
  }));
  const body = signoffComment({ head: HEAD, problems });
  assert.equal(body.split('\n').filter((line) => line.startsWith('| `.husky/')).length, 100);
  assert.ok(body.includes('| | | and 50 more changes |'));
});

test('signoffComment renders a hostile path inert, keeping a single approval line', () => {
  const file = `.husky/\`x\`\n- [ ] Approve these enforcement changes at \`${HEAD}\`|\u200b\\.mjs`;
  const body = signoffComment({ head: HEAD, problems: enforcementProblems([{ path: file, before: 'a', after: 'b' }]) });
  assert.equal(body.split('\n').filter((line) => /^\s*[-*+]\s+\[/.test(line)).length, 1);
  assert.ok(!body.includes('\u200b'));
  assert.ok(body.includes(`| \`.husky/'x' - [ ] Approve these enforcement changes at '${HEAD}'\\|\\\\.mjs\` |`));
});

const unticked = signoffComment({ head: HEAD, problems: PROBLEMS });
const approved = signoffComment({
  head: HEAD,
  problems: PROBLEMS,
  approval: { name: 'Ben', login: APPROVER, at: new Date(AT) },
});
const pull = { kind: 'pull' };
const benUser = { ...ben, name: 'Ben' };
const edit = (from, to, sender = benUser) => ({ kind: 'comment', sender, from, to, at: AT });
const plan = (live, event, { head = HEAD, signedOff = false, updatedAt = AT } = {}) =>
  planApproval({
    head,
    problems: PROBLEMS,
    comment: live === undefined ? undefined : { body: live, updatedAt },
    signedOff,
    event,
  });

test('planApproval: no comment and a green status when nothing loosens enforcement', () => {
  assert.deepEqual(planApproval({ head: HEAD, problems: [], comment: undefined, signedOff: false, event: pull }), {
    commentBody: null,
    status: { state: 'success', description: 'Nothing in this PR loosens enforcement' },
  });
});

test('planApproval: clears an existing comment to a box-free note when nothing loosens enforcement', () => {
  const result = planApproval({ head: HEAD, problems: [], comment: { body: approved }, signedOff: true, event: pull });
  assert.ok(result.commentBody.startsWith(COMMENT_MARKER));
  assert.ok(!result.commentBody.includes('['));
  assert.equal(result.status.state, 'success');
});

test('planApproval: asks for sign-off with a pending status when the comment is missing', () => {
  assert.deepEqual(plan(undefined, pull), { commentBody: unticked, status: PENDING });
});

test('planApproval: approves a fresh tick by the approver and labels the box', () => {
  assert.deepEqual(plan(tick(unticked), edit(unticked, tick(unticked))), { commentBody: approved, status: SIGNED });
});

test('planApproval: approves a fresh [X], CRLF, or trailing-newline tick', () => {
  for (const ticked of [tick(unticked, 'X'), tick(unticked).replaceAll('\n', '\r\n'), `${tick(unticked)}\n`]) {
    assert.deepEqual(plan(ticked, edit(unticked, ticked)).status, SIGNED);
  }
});

test('planApproval: falls back to the login when the approver has no profile name', () => {
  const result = plan(tick(unticked), edit(unticked, tick(unticked), { ...ben, name: null }));
  assert.ok(result.commentBody.includes(`Approved by ${APPROVER} @${APPROVER} on`));
});

for (const [name, sender] of [
  ['a Bot that shares the approver login', { login: APPROVER, type: 'Bot' }],
  ['github-actions', { login: GATE_AUTHOR, type: 'Bot' }],
  ['another user', { login: 'someone', type: 'User', name: 'Ben' }],
  ['a lowercased login', { login: APPROVER.toLowerCase(), type: 'User' }],
]) {
  test(`planApproval: clears a tick by ${name}, shows no label, and names them`, () => {
    const result = plan(tick(unticked), edit(unticked, tick(unticked), sender));
    assert.equal(result.commentBody, signoffComment({ head: HEAD, problems: PROBLEMS, refusedBy: sender.login }));
    assert.ok(result.commentBody.includes(`A tick by \`${sender.login}\` was cleared.`));
    assert.ok(result.commentBody.includes(`\n- [ ] Approve these enforcement changes at \`${HEAD}\`\n`));
    assert.ok(!result.commentBody.includes('Approved by'));
    assert.deepEqual(result.status, PENDING);
  });
}

test('planApproval: approves a fresh tick on a comment that names a cleared tick, and drops the note', () => {
  const noted = signoffComment({ head: HEAD, problems: PROBLEMS, refusedBy: 'someone' });
  assert.deepEqual(plan(tick(noted), edit(noted, tick(noted))), { commentBody: approved, status: SIGNED });
});

test('planApproval: clears an approver edit that changes other text and keeps the tick', () => {
  const reworded = tick(unticked).replace('This PR loosens', 'This PR quietly loosens');
  assert.deepEqual(plan(reworded, edit(tick(unticked), reworded)), { commentBody: unticked, status: PENDING });
});

test('planApproval: clears an approver edit that re-saves an approved comment without the label', () => {
  assert.deepEqual(plan(tick(unticked), edit(approved, tick(unticked))).status, PENDING);
});

test('planApproval: clears a tick that rewrites the head commit in the box line', () => {
  const forged = tick(unticked).replace(`\`${HEAD}\``, `\`${NEXT}\``);
  assert.deepEqual(plan(forged, edit(unticked, forged)), { commentBody: unticked, status: PENDING });
});

test('planApproval: clears a label typed into the comment, whoever types it', () => {
  assert.deepEqual(plan(approved, edit(unticked, approved)), { commentBody: unticked, status: PENDING });
  assert.deepEqual(plan(approved, edit(unticked, approved, someone)), {
    commentBody: signoffComment({ head: HEAD, problems: PROBLEMS, refusedBy: 'someone' }),
    status: PENDING,
  });
});

test('planApproval: clears a tick on the comment for an earlier head', () => {
  const old = signoffComment({ head: NEXT, problems: PROBLEMS });
  assert.deepEqual(plan(tick(old), edit(old, tick(old))), { commentBody: unticked, status: PENDING });
});

test('planApproval: clears a body edit the event reports without a previous body', () => {
  assert.deepEqual(plan(tick(unticked), edit(null, tick(unticked))).status, PENDING);
});

test('planApproval: removes the label when the approver unticks', () => {
  const untick = approved.replace('- [x] ', '- [ ] ');
  assert.deepEqual(plan(untick, edit(approved, untick)), { commentBody: unticked, status: PENDING });
});

test('planApproval: an untick wins over the label the gate wrote for the tick just before it', () => {
  const untick = tick(unticked).replace('- [x] ', '- [ ] ');
  assert.deepEqual(plan(approved, edit(tick(unticked), untick)), { commentBody: unticked, status: PENDING });
});

test('planApproval: does not approve a tick the comment has since moved past', () => {
  assert.deepEqual(plan(unticked, edit(unticked, tick(unticked))), { commentBody: unticked, status: PENDING });
});

test('planApproval: does not approve a tick when the comment was edited again since, even to the same body', () => {
  assert.deepEqual(plan(tick(unticked), edit(unticked, tick(unticked)), { updatedAt: '2026-10-12T14:06:00Z' }), {
    commentBody: unticked,
    status: PENDING,
  });
});

test('planApproval: keeps the label and posts no status when the tick run is rerun', () => {
  assert.deepEqual(plan(approved, edit(unticked, tick(unticked)), { signedOff: true, updatedAt: 'later' }), {
    commentBody: approved,
    status: null,
  });
});

test('planApproval: keeps the label for its head on a PR event and posts no status', () => {
  assert.deepEqual(plan(approved, pull, { signedOff: true }), { commentBody: approved, status: null });
});

test('planApproval: clears a label on a PR event when the gate has not signed off this head', () => {
  assert.deepEqual(plan(approved, pull), { commentBody: unticked, status: PENDING });
});

test('planApproval: rewrites an approved comment for an earlier head unticked for the new head', () => {
  assert.deepEqual(plan(approved, pull, { head: NEXT, signedOff: true }), {
    commentBody: signoffComment({ head: NEXT, problems: PROBLEMS }),
    status: PENDING,
  });
});

test('planApproval: clears a bare tick found on a PR event', () => {
  assert.deepEqual(plan(tick(unticked), pull), { commentBody: unticked, status: PENDING });
});

test('planApproval: every status description fits the 140-character limit', () => {
  const plans = [
    plan(undefined, pull),
    plan(tick(unticked), edit(unticked, tick(unticked))),
    planApproval({ head: HEAD, problems: [], comment: undefined, signedOff: false, event: pull }),
  ];
  for (const { status } of plans) assert.ok(status.description.length < 140, status.description);
});

const repo = { owner: 'o', repo: 'r' };
const core = { info: () => undefined };
const pullRequestContext = {
  eventName: 'pull_request_target',
  repo,
  payload: { action: 'synchronize', pull_request: { number: 7, head: { sha: HEAD } } },
};

/** An in-memory GitHub with just the calls the gate makes. */
function fakeGitHub({ files, contents, comments = [] }) {
  const state = { head: HEAD, profiles: { [APPROVER]: 'Ben' } };
  const calls = { createComment: [], updateComment: 0, createCommitStatus: [] };
  const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });
  const rest = {
    pulls: {
      get: async () => ({ data: { head: { sha: state.head }, base: { sha: 'base-sha' } } }),
      listFiles: async () => ({ data: files }),
    },
    issues: {
      listComments: async () => ({ data: comments }),
      createComment: async ({ body }) => {
        calls.createComment.push(body);
        comments.push({ id: comments.length + 1, body, user: { login: GATE_AUTHOR, type: 'Bot' } });
        return { data: {} };
      },
      updateComment: async ({ comment_id, body }) => {
        calls.updateComment += 1;
        const comment = comments.find((entry) => entry.id === comment_id);
        if (comment) {
          comment.body = body;
          comment.updated_at = `gate write ${calls.updateComment}`;
        }
        return { data: {} };
      },
    },
    repos: {
      compareCommitsWithBasehead: async ({ basehead }) => {
        assert.equal(basehead, `base-sha...${state.head}`);
        return { data: { merge_base_commit: { sha: MERGE_BASE } } };
      },
      getContent: async ({ path: file, ref }) => {
        const content = contents[ref]?.[file];
        if (content === undefined) throw notFound();
        return { data: content };
      },
      createCommitStatus: async (parameters) => {
        calls.createCommitStatus.push(parameters);
        return { data: {} };
      },
      listCommitStatusesForRef: async ({ ref }) => ({
        data: calls.createCommitStatus
          .filter((status) => status.sha === ref)
          .map((status) => ({ ...status, creator: { login: GATE_AUTHOR } }))
          .reverse(),
      }),
    },
    users: {
      getByUsername: async ({ username }) => ({ data: { login: username, name: state.profiles[username] ?? null } }),
    },
  };
  const github = { rest, paginate: async (method, parameters) => (await method(parameters)).data };
  /** Edit the gate's comment as `sender` and return the issue_comment context GitHub sends. */
  const editBy = (sender, change, at = AT) => {
    const comment = comments[0];
    const from = comment.body;
    comment.body = change(from);
    comment.updated_at = at;
    return {
      eventName: 'issue_comment',
      repo,
      payload: {
        action: 'edited',
        issue: { number: 7, pull_request: {} },
        comment: { ...comment },
        changes: { body: { from } },
        sender: { login: sender.login, type: sender.type },
      },
    };
  };
  return { github, comments, calls, state, editBy };
}

const loosening = () => ({
  files: [{ filename: '.husky/pre-commit' }],
  contents: {
    [MERGE_BASE]: { '.husky/pre-commit': 'npm run lint' },
    [HEAD]: { '.husky/pre-commit': 'true' },
    [NEXT]: { '.husky/pre-commit': 'exit 0' },
  },
});
const LABEL = `<sub><i>Approved by Ben @${APPROVER} on Monday, the 12th of October, at 3 pm</i></sub>`;
const lastStatus = (calls) => calls.createCommitStatus.at(-1);

test('run: posts one sign-off comment and a pending status on the head, then stays idle on a rerun', async () => {
  const { github, comments, calls } = fakeGitHub(loosening());
  await run({ github, context: pullRequestContext, core });
  assert.deepEqual(
    comments.map((comment) => comment.body),
    [unticked],
  );
  assert.deepEqual(calls.createCommitStatus, [{ ...repo, sha: HEAD, context: STATUS_CONTEXT, ...PENDING }]);

  await run({ github, context: pullRequestContext, core });
  assert.equal(calls.createComment.length, 1);
  assert.equal(calls.updateComment, 0);
});

test('run: reads a file absent at the merge base as added', async () => {
  const { github, comments } = fakeGitHub({
    files: [{ filename: '.husky/pre-push' }],
    contents: { [HEAD]: { '.husky/pre-push': 'npm test' } },
  });
  await run({ github, context: pullRequestContext, core });
  assert.ok(comments[0].body.includes('| `.husky/pre-push` | Git hooks | adds enforcement code |'));
});

test('run: fails loudly when reading a file fails for any reason but absence', async () => {
  const fake = fakeGitHub(loosening());
  fake.github.rest.repos.getContent = async () => {
    throw Object.assign(new Error('Server Error'), { status: 500 });
  };
  await assert.rejects(run({ github: fake.github, context: pullRequestContext, core }), /Server Error/);
});

test("run: the approver's tick labels the box with the London time and turns the head green", async () => {
  const { github, comments, calls, editBy } = fakeGitHub(loosening());
  await run({ github, context: pullRequestContext, core });
  assert.equal(lastStatus(calls).state, 'pending');
  await run({ github, context: editBy(ben, (body) => tick(body)), core });
  assert.deepEqual(boxLines(comments[0].body), [`- [x] Approve these enforcement changes at \`${HEAD}\` ${LABEL}`]);
  assert.deepEqual(lastStatus(calls), { ...repo, sha: HEAD, context: STATUS_CONTEXT, ...SIGNED });
  assert.equal(calls.createComment.length, 1);
});

test('run: accepts the trailing newline a GitHub checkbox click appends', async () => {
  const { github, calls, editBy } = fakeGitHub(loosening());
  await run({ github, context: pullRequestContext, core });
  await run({ github, context: editBy(ben, (body) => `${tick(body)}\n`), core });
  assert.equal(lastStatus(calls).state, 'success');
});

test('run: writes nothing and posts no status when the tick run is rerun', async () => {
  const { github, comments, calls, editBy } = fakeGitHub(loosening());
  await run({ github, context: pullRequestContext, core });
  const tickContext = editBy(ben, (body) => tick(body));
  await run({ github, context: tickContext, core });
  const labelled = comments[0].body;
  const writes = [calls.updateComment, calls.createCommitStatus.length];
  await run({ github, context: tickContext, core });
  assert.equal(comments[0].body, labelled);
  assert.deepEqual([calls.updateComment, calls.createCommitStatus.length], writes);
});

test('run: does not re-approve when a tick run is rerun after the approver unticked', async () => {
  const { github, comments, calls, editBy } = fakeGitHub(loosening());
  await run({ github, context: pullRequestContext, core });
  const tickContext = editBy(ben, (body) => tick(body));
  await run({ github, context: tickContext, core });
  await run({ github, context: editBy(ben, (body) => body.replace('- [x] ', '- [ ] ')), core });
  await run({ github, context: tickContext, core });
  assert.deepEqual(boxLines(comments[0].body), [`- [ ] Approve these enforcement changes at \`${HEAD}\``]);
  assert.equal(lastStatus(calls).state, 'pending');
});

test('run: does not re-approve a rerun tick after someone restores the ticked body over an untick', async () => {
  const { github, comments, calls, editBy } = fakeGitHub(loosening());
  await run({ github, context: pullRequestContext, core });
  const tickContext = editBy(ben, (body) => tick(body));
  await run({ github, context: tickContext, core });
  await run({ github, context: editBy(ben, (body) => body.replace('- [x] ', '- [ ] '), '2026-10-12T14:05:00Z'), core });
  editBy(someone, () => tickContext.payload.comment.body, '2026-10-12T14:06:00Z');
  await run({ github, context: tickContext, core });
  assert.deepEqual(boxLines(comments[0].body), [`- [ ] Approve these enforcement changes at \`${HEAD}\``]);
  assert.equal(lastStatus(calls).state, 'pending');
});

test('run: keeps the label on a later PR event for the same head and posts no status', async () => {
  const { github, comments, calls, editBy } = fakeGitHub(loosening());
  await run({ github, context: pullRequestContext, core });
  await run({ github, context: editBy(ben, (body) => tick(body)), core });
  const labelled = comments[0].body;
  const statuses = calls.createCommitStatus.length;
  await run({
    github,
    context: { ...pullRequestContext, payload: { ...pullRequestContext.payload, action: 'edited' } },
    core,
  });
  assert.equal(comments[0].body, labelled);
  assert.equal(calls.createCommitStatus.length, statuses);
});

test('run: clears a label typed into the comment on the next PR event when its own run never ran', async () => {
  const { github, comments, calls, editBy } = fakeGitHub(loosening());
  await run({ github, context: pullRequestContext, core });
  editBy(someone, (body) => body.replace('- [ ] Approve', '- [x] Approve').replace(/`\n/, `\` ${LABEL}\n`));
  await run({ github, context: pullRequestContext, core });
  assert.equal(comments[0].body, unticked);
  assert.deepEqual(
    calls.createCommitStatus.map((status) => status.state),
    ['pending', 'pending'],
  );
});

test('run: removes the label and goes pending when the approver unticks', async () => {
  const { github, comments, calls, editBy } = fakeGitHub(loosening());
  await run({ github, context: pullRequestContext, core });
  await run({ github, context: editBy(ben, (body) => tick(body)), core });
  await run({ github, context: editBy(ben, (body) => body.replace('- [x] ', '- [ ] ')), core });
  assert.equal(comments[0].body, unticked);
  assert.equal(lastStatus(calls).state, 'pending');
});

test('run: clears a tick by anyone else, names them in the one comment, then takes Ben’s tick', async () => {
  const { github, comments, calls, editBy } = fakeGitHub(loosening());
  await run({ github, context: pullRequestContext, core });
  await run({ github, context: editBy(someone, (body) => tick(body)), core });
  assert.equal(comments.length, 1);
  assert.ok(comments[0].body.includes('A tick by `someone` was cleared.'));
  assert.deepEqual(boxLines(comments[0].body), [`- [ ] Approve these enforcement changes at \`${HEAD}\``]);
  assert.equal(lastStatus(calls).state, 'pending');

  await run({ github, context: editBy(ben, (body) => tick(body)), core });
  assert.deepEqual(boxLines(comments[0].body), [`- [x] Approve these enforcement changes at \`${HEAD}\` ${LABEL}`]);
  assert.ok(!comments[0].body.includes('was cleared'));
  assert.equal(lastStatus(calls).state, 'success');
});

test('run: reclaims a gate comment whose marker an edit removed when that edit run never ran', async () => {
  const { github, comments, calls, editBy } = fakeGitHub(loosening());
  await run({ github, context: pullRequestContext, core });
  editBy(someone, (body) =>
    body.replace(COMMENT_MARKER, '').replace('- [ ] Approve', '- [x] Approve').replace(/`\n/, `\` ${LABEL}\n`),
  );
  await run({ github, context: pullRequestContext, core });
  assert.equal(comments.length, 1);
  assert.equal(comments[0].body, unticked);
  assert.equal(lastStatus(calls).state, 'pending');
});

test('run: keeps the status pending and clears a label the approver typed in', async () => {
  const { github, comments, calls, editBy } = fakeGitHub(loosening());
  await run({ github, context: pullRequestContext, core });
  await run({
    github,
    context: editBy(ben, (body) => body.replace('- [ ] Approve', '- [x] Approve').replace(/`\n/, `\` ${LABEL}\n`)),
    core,
  });
  assert.equal(comments[0].body, unticked);
  assert.deepEqual(
    calls.createCommitStatus.map((status) => status.state),
    ['pending', 'pending'],
  );
});

test('run: a push after an approval re-renders unticked for the new head and goes pending', async () => {
  const { github, comments, calls, state, editBy } = fakeGitHub(loosening());
  await run({ github, context: pullRequestContext, core });
  await run({ github, context: editBy(ben, (body) => tick(body)), core });
  state.head = NEXT;
  await run({ github, context: pullRequestContext, core });
  assert.deepEqual(boxLines(comments[0].body), [`- [ ] Approve these enforcement changes at \`${NEXT}\``]);
  assert.deepEqual([lastStatus(calls).sha, lastStatus(calls).state], [NEXT, 'pending']);
});

test('run: clears a tick on the old head comment that races a push', async () => {
  const { github, comments, calls, state, editBy } = fakeGitHub(loosening());
  await run({ github, context: pullRequestContext, core });
  const tickContext = editBy(ben, (body) => tick(body));
  state.head = NEXT;
  await run({ github, context: tickContext, core });
  assert.deepEqual(boxLines(comments[0].body), [`- [ ] Approve these enforcement changes at \`${NEXT}\``]);
  assert.deepEqual(
    calls.createCommitStatus.map((status) => [status.sha, status.state]),
    [
      [HEAD, 'pending'],
      [NEXT, 'pending'],
    ],
  );
});

test('run: ends unticked when an untick and a re-tick both land before either run reads the comment', async () => {
  const { github, comments, calls, editBy } = fakeGitHub(loosening());
  await run({ github, context: pullRequestContext, core });
  await run({ github, context: editBy(ben, (body) => tick(body)), core });
  const untick = editBy(ben, (body) => body.replace('- [x] ', '- [ ] '));
  const retick = editBy(ben, (body) => body.replace('- [ ] ', '- [x] '));
  await run({ github, context: untick, core });
  await run({ github, context: retick, core });
  assert.deepEqual(boxLines(comments[0].body), [`- [ ] Approve these enforcement changes at \`${HEAD}\``]);
  assert.equal(lastStatus(calls).state, 'pending');
});

test('run: restores the sign-off comment when an edit removes its marker', async () => {
  const { github, comments, calls, editBy } = fakeGitHub(loosening());
  await run({ github, context: pullRequestContext, core });
  await run({ github, context: editBy(ben, (body) => tick(body).replace(COMMENT_MARKER, '')), core });
  assert.equal(comments[0].body, unticked);
  assert.equal(calls.createComment.length, 1);
  assert.equal(lastStatus(calls).state, 'pending');
});

for (const [name, user] of [
  ['a person', { login: APPROVER, type: 'User' }],
  ['another bot', { login: 'other-app[bot]', type: 'Bot' }],
  ['a user named like the gate', { login: GATE_AUTHOR, type: 'User' }],
]) {
  test(`run: ignores a ticked lookalike comment that ${name} posted`, async () => {
    const fake = fakeGitHub({ ...loosening(), comments: [{ id: 1, body: approved, user }] });
    await run({ github: fake.github, context: pullRequestContext, core });
    assert.equal(fake.calls.createComment.length, 1);
    assert.deepEqual(
      fake.calls.createCommitStatus.map((status) => status.state),
      ['pending'],
    );
  });
}

test('run: asks for sign-off when the PR lists as many files as the API returns', async () => {
  const files = Array.from({ length: LIST_FILES_LIMIT }, (_, index) => ({ filename: `src/file${index}.ts` }));
  const { github, comments, calls } = fakeGitHub({ files, contents: {} });
  await run({ github, context: pullRequestContext, core });
  assert.ok(comments[0].body.includes('| `this PR` | Gate input |'));
  assert.deepEqual(
    calls.createCommitStatus.map((status) => status.state),
    ['pending'],
  );
});

test('run: sets a green status and posts nothing when no guarded file changes', async () => {
  const { github, calls } = fakeGitHub({
    files: [{ filename: 'src/diff.ts' }, { filename: '.agents/README.md' }],
    contents: {},
  });
  await run({ github, context: pullRequestContext, core });
  assert.deepEqual(calls.createComment, []);
  assert.deepEqual(
    calls.createCommitStatus.map((status) => [status.sha, status.state]),
    [[HEAD, 'success']],
  );
});

test('run: posts the status on the live head, not the head the event names', async () => {
  const { github, calls, state } = fakeGitHub(loosening());
  state.head = NEXT;
  await run({ github, context: pullRequestContext, core });
  assert.deepEqual(
    calls.createCommitStatus.map((status) => [status.sha, status.state]),
    [[NEXT, 'pending']],
  );
});

test('the --git CLI lists the guarded changes between two local commits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enforcement-approval-'));
  try {
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.mkdirSync(path.join(dir, '.husky'));
    fs.writeFileSync(path.join(dir, '.husky/pre-commit'), 'npm run lint\n');
    fs.writeFileSync(path.join(dir, 'README.md'), 'a\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    fs.writeFileSync(path.join(dir, '.husky/pre-commit'), 'true\n');
    fs.writeFileSync(path.join(dir, 'README.md'), 'b\n');
    git('commit', '-qam', 'loosen');
    const out = JSON.parse(execFileSync(process.execPath, [SCRIPT, '--git', 'HEAD~1'], { cwd: dir, encoding: 'utf8' }));
    assert.equal(out.head, git('rev-parse', 'HEAD').trim());
    assert.deepEqual(out.problems, PROBLEMS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const workflow = fs.readFileSync(path.join(root, '.github/workflows/enforcement-approval.yml'), 'utf8');

test('the workflow runs on PR events and on edited PR comments', () => {
  assert.match(workflow, /pull_request_target:\s*\n\s*types: \[opened, edited, synchronize, reopened\]/);
  assert.match(workflow, /issue_comment:\s*\n\s*types: \[edited\]/);
});

test('the workflow checks out only the default branch copy of the script and runs no PR code', () => {
  assert.ok(workflow.includes('ref: ${{ github.event.repository.default_branch }}'));
  assert.ok(workflow.includes('sparse-checkout: scripts/enforcement-approval.mjs'));
  assert.ok(workflow.includes('persist-credentials: false'));
  assert.ok(!workflow.includes('pull_request.head'));
  assert.doesNotMatch(workflow, /^\s*(-\s+)?run:/m);
});

test('the workflow queues gate runs per PR only for jobs that run', () => {
  assert.doesNotMatch(workflow, /^concurrency:/m);
  assert.match(workflow, /\n {2}approve:\n(?: {4}.*\n| *#.*\n)*? {4}concurrency:\n {6}group: enforcement-approval-/);
});

test('every edit of the gate comment reaches the script, whoever made it', () => {
  assert.ok(!workflow.includes('sender.type'));
  assert.ok(workflow.includes(`github.event.comment.user.login == '${GATE_AUTHOR}'`));
  assert.ok(workflow.includes(`startsWith(github.event.comment.body, '${COMMENT_MARKER}')`));
  assert.ok(workflow.includes(`startsWith(github.event.changes.body.from, '${COMMENT_MARKER}')`));
});
