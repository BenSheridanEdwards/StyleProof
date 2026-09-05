import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const approveYml = fs.readFileSync(path.join(root, 'example/styleproof-approve.yml'), 'utf8');
const actionYml = fs.readFileSync(path.join(root, 'action.yml'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const liveReportScript = fs.readFileSync(path.join(root, 'scripts/live-readme-report.mjs'), 'utf8');
const liveComment = fs.readFileSync(path.join(root, 'docs/readme/live-report/comment.md'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const REPORT_SHA = 'a'.repeat(40);
const AUTHOR = 'pr-author';
const REVIEWER = 'a-reviewer';

/** Compile the workflow's real github-script program — never a copy of it. */
function approveScript() {
  const match = approveYml.match(/\n {10}script: \|\n([\s\S]*)$/);
  assert.ok(match, 'example/styleproof-approve.yml should contain a github-script program');
  const source = match[1]
    .split('\n')
    .map((line) => line.replace(/^ {12}/, ''))
    .join('\n');
  assert.doesNotMatch(source, /\$\{\{/, 'the approve program must not interpolate workflow expressions');
  return new AsyncFunction('github', 'context', source);
}

function reportComment({ ticked = false, suffix = '', sha = REPORT_SHA } = {}) {
  return [
    '<!-- styleproof-report -->',
    '## StyleProof report',
    '',
    `- [${ticked ? 'x' : ' '}] **Approve all changes**${suffix}`,
    '',
    `<!-- styleproof-sha:${sha} -->`,
    '',
  ].join('\n');
}

/**
 * Drive the real program once. `existingComments` models replies already on the
 * thread so the dedupe path is exercised rather than assumed.
 */
async function runApprove({
  actor,
  author = AUTHOR,
  authorMissing = false,
  permission = 'write',
  body = reportComment({ ticked: true }),
  headSha = REPORT_SHA,
  allowSelfApproval,
  existingComments = [],
} = {}) {
  const statuses = [];
  const created = [];
  const updated = [];
  const listed = [...existingComments];
  const github = {
    paginate: async (route, params) => {
      assert.equal(route, github.rest.issues.listComments);
      assert.equal(params.issue_number, 7);
      return listed;
    },
    rest: {
      issues: {
        listComments: () => {
          throw new Error('list comments must go through github.paginate');
        },
        getComment: async () => ({ data: { body } }),
        createComment: async (input) => {
          created.push(input);
          listed.push({ body: input.body });
        },
        updateComment: async (input) => {
          updated.push(input);
        },
      },
      pulls: {
        get: async () => ({
          data: { head: { sha: headSha }, user: authorMissing ? null : { login: author } },
        }),
      },
      repos: {
        getCollaboratorPermissionLevel: async () => {
          if (permission === 'none') throw new Error('not a collaborator');
          return { data: { permission } };
        },
        createCommitStatus: async (input) => {
          statuses.push(input);
        },
      },
    },
  };
  const context = {
    repo: { owner: 'acme', repo: 'app' },
    payload: { sender: { login: actor }, comment: { id: 99 }, issue: { number: 7 } },
  };

  const previous = process.env.STYLEPROOF_ALLOW_SELF_APPROVAL;
  if (allowSelfApproval === undefined) delete process.env.STYLEPROOF_ALLOW_SELF_APPROVAL;
  else process.env.STYLEPROOF_ALLOW_SELF_APPROVAL = allowSelfApproval;
  try {
    await approveScript()(github, context);
  } finally {
    if (previous === undefined) delete process.env.STYLEPROOF_ALLOW_SELF_APPROVAL;
    else process.env.STYLEPROOF_ALLOW_SELF_APPROVAL = previous;
  }
  return { statuses, created, updated };
}

test('a write-access reviewer who is not the author still signs off (#477)', async () => {
  const { statuses, created, updated } = await runApprove({ actor: REVIEWER });

  assert.deepEqual(
    statuses.map((s) => [s.state, s.description]),
    [['success', `Approved by @${REVIEWER}`]],
  );
  assert.equal(statuses[0].sha, REPORT_SHA);
  assert.equal(created.length, 0, 'a valid approval posts no refusal reply');
  assert.match(updated[0].body, /- \[x\] \*\*Approve all changes\*\* — _approved by @a-reviewer_/);
});

test('the pull request author cannot approve their own visual changes (#477)', async () => {
  const { statuses, created, updated } = await runApprove({ actor: AUTHOR });

  assert.deepEqual(
    statuses.map((s) => [s.state, s.description]),
    [['failure', `Needs a reviewer other than @${AUTHOR}`]],
    'a self-tick must never stamp a success status',
  );
  assert.equal(statuses[0].sha, REPORT_SHA);
  assert.equal(created.length, 1, 'the refusal is said out loud on the pull request');
  assert.match(created[0].body, /@pr-author — you opened this pull request/);
  assert.match(created[0].body, /STYLEPROOF_ALLOW_SELF_APPROVAL/);
  assert.match(created[0].body, /<!-- styleproof-approve:self-approval:a{40} -->/);
  assert.match(
    updated[0].body,
    /- \[ \] \*\*Approve all changes\*\* — _self-approval by @pr-author refused_/,
    'the box is put back so it cannot read as approved beside a red check',
  );
});

test('a repeated self-tick refuses again but replies only once per commit (#477)', async () => {
  const first = await runApprove({ actor: AUTHOR });
  const second = await runApprove({ actor: AUTHOR, existingComments: [{ body: first.created[0].body }] });

  assert.equal(second.created.length, 0, 'the refusal reply must not spam the thread');
  assert.deepEqual(
    second.statuses.map((s) => s.state),
    ['failure'],
    'the gate still refuses every time, it only stays quiet',
  );
});

test('a stale refusal reply from an earlier commit does not silence this one (#477)', async () => {
  const stale = `refused\n\n<!-- styleproof-approve:self-approval:${'b'.repeat(40)} -->`;
  const { created } = await runApprove({ actor: AUTHOR, existingComments: [{ body: stale }] });

  assert.equal(created.length, 1);
  assert.match(created[0].body, new RegExp(`styleproof-approve:self-approval:a{40}`));
});

test('the author may always untick their own approval (#477)', async () => {
  const { statuses, created } = await runApprove({
    actor: AUTHOR,
    body: reportComment({ ticked: false }),
  });

  assert.deepEqual(
    statuses.map((s) => [s.state, s.description]),
    [['failure', 'Tick "Approve all changes" to sign off']],
    'withdrawing a sign-off only moves the gate red, so it is never refused',
  );
  assert.equal(created.length, 0);
});

test('the author cannot inherit a sign-off by editing a reviewer-approved comment (#477)', async () => {
  const { statuses, updated } = await runApprove({
    actor: AUTHOR,
    body: reportComment({ ticked: true, suffix: ` — _approved by @${REVIEWER}_` }),
  });

  assert.deepEqual(
    statuses.map((s) => [s.state, s.description]),
    [['failure', `Needs a reviewer other than @${AUTHOR}`]],
  );
  assert.doesNotMatch(updated[0].body, /approved by @pr-author/);
});

test('author matching is case-insensitive and an unresolvable author fails closed (#477)', async () => {
  const cased = await runApprove({ actor: 'PR-Author' });
  assert.deepEqual(
    cased.statuses.map((s) => s.state),
    ['failure'],
  );

  const unknown = await runApprove({ actor: REVIEWER, authorMissing: true });
  assert.deepEqual(
    unknown.statuses.map((s) => s.state),
    ['failure'],
  );
  assert.equal(unknown.statuses[0].description, `Needs a reviewer other than @${REVIEWER}`);
});

test('solo repositories opt in explicitly, and any other value refuses (#477)', async () => {
  const optedIn = await runApprove({ actor: AUTHOR, allowSelfApproval: 'true' });
  assert.deepEqual(
    optedIn.statuses.map((s) => [s.state, s.description]),
    [['success', `Approved by @${AUTHOR}`]],
  );

  for (const typo of ['TRUE', 'True', '1', 'yes', '', ' true']) {
    const refused = await runApprove({ actor: AUTHOR, allowSelfApproval: typo });
    assert.deepEqual(
      refused.statuses.map((s) => s.state),
      ['failure'],
      `STYLEPROOF_ALLOW_SELF_APPROVAL=${JSON.stringify(typo)} must fail closed`,
    );
  }

  assert.match(
    approveYml,
    /^ {6}STYLEPROOF_ALLOW_SELF_APPROVAL: 'false'$/m,
    'the shipped default must refuse self-approval',
  );
});

test('the earlier guards still run before the author check (#477)', async () => {
  const noWrite = await runApprove({ actor: REVIEWER, permission: 'read' });
  assert.equal(noWrite.statuses.length, 0);
  assert.equal(noWrite.created.length, 1);
  assert.match(noWrite.created[0].body, /needs write access/);
  assert.match(noWrite.created[0].body, /<!-- styleproof-approve:write-access:a{40} -->/);

  const moved = await runApprove({ actor: AUTHOR, headSha: 'c'.repeat(40) });
  assert.equal(moved.statuses.length, 0, 'a moved head is left entirely to the next report run');
  assert.equal(moved.created.length, 0);

  const noBox = await runApprove({ actor: AUTHOR, body: `<!-- styleproof-sha:${REPORT_SHA} -->` });
  assert.equal(noBox.statuses.length, 0);
});

test('every rendered approval caption names the author rule (#477)', () => {
  const clause = 'write access required, and not the pull request author.';
  for (const [name, source] of [
    ['action.yml', actionYml],
    ['README.md', readme],
    ['scripts/live-readme-report.mjs', liveReportScript],
    ['docs/readme/live-report/comment.md', liveComment],
  ]) {
    assert.ok(source.includes(clause), `${name} should state the approver rule in the comment caption`);
  }
  assert.match(readme, /#### Who may tick the box/);
  assert.match(readme, /STYLEPROOF_ALLOW_SELF_APPROVAL/);
});
