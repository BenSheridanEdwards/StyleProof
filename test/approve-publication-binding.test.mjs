import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const approveYml = fs.readFileSync(path.join(root, 'example/styleproof-approve.yml'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const HEAD_SHA = 'a'.repeat(40);
const OTHER_HEAD_SHA = 'b'.repeat(40);
const PUBLICATION_SHA = 'c'.repeat(40);
const OTHER_PUBLICATION_SHA = 'd'.repeat(40);
const RUN_ID = '9001';
const RUN_ATTEMPT = '2';
const REPORT_URL = `https://github.com/acme/app/blob/${PUBLICATION_SHA}/pr-7/report.md`;
const PENDING_DESCRIPTION = 'StyleProof changes need sign-off — tick the box in the report comment';

function approveScript() {
  const match = approveYml.match(/\n {10}script: \|\n([\s\S]*)$/);
  assert.ok(match, 'example/styleproof-approve.yml should contain a github-script program');
  const source = match[1]
    .split('\n')
    .map((line) => line.replace(/^ {12}/, ''))
    .join('\n');
  assert.doesNotMatch(source, /\$\{\{/);
  return new AsyncFunction('github', 'context', source);
}

function reportComment({
  headSha = HEAD_SHA,
  publicationSha = PUBLICATION_SHA,
  runId = RUN_ID,
  runAttempt = RUN_ATTEMPT,
  ticked = true,
  extra = [],
} = {}) {
  return [
    '<!-- styleproof-report -->',
    '## StyleProof report',
    '',
    `- [${ticked ? 'x' : ' '}] **Approve all changes**`,
    '',
    `### 📊 [**View the side-by-side visual report →**](https://github.com/acme/app/blob/${publicationSha}/pr-7/report.md)`,
    '',
    '---',
    `<!-- styleproof-sha:${headSha} -->`,
    `<!-- styleproof-run-id:${runId} run-attempt:${runAttempt} -->`,
    ...extra,
  ].join('\n');
}

function publishedMarkdown({ headSha = HEAD_SHA, runId = RUN_ID, runAttempt = RUN_ATTEMPT } = {}) {
  return `# report\n<!-- styleproof-receipt head-sha:${headSha} run-id:${runId} run-attempt:${runAttempt} -->\n`;
}

async function runApproval({
  body = reportComment(),
  freshAuthor = { login: 'github-actions[bot]', type: 'Bot' },
  canonicalCommentId = 99,
  status = { state: 'failure', description: PENDING_DESCRIPTION, target_url: REPORT_URL, context: 'StyleProof' },
  markdown = publishedMarkdown(),
  reportJson = '{"surfaces":[],"actionTrustState":"STYLE_REVIEW_REQUIRED"}',
  actor = 'reviewer',
  author = 'author',
  headShas = [HEAD_SHA],
  permission = 'write',
  failApi,
} = {}) {
  const statuses = [];
  const updates = [];
  const created = [];
  let pullRead = 0;
  const api = async (name, implementation) => {
    if (failApi === name) throw new Error(`${name} failed`);
    return implementation();
  };
  const comments = [{ id: canonicalCommentId, body, user: freshAuthor }];
  const canonicalStatus = {
    creator: { login: 'github-actions[bot]', type: 'Bot' },
    ...status,
  };
  const github = {
    paginate: async (route, params) => {
      assert.equal(route, github.rest.issues.listComments);
      assert.equal(params.issue_number, 7);
      return api('listComments', () => comments);
    },
    rest: {
      actions: {
        getWorkflowRun: async () => {
          throw new Error('approval must not query the workflow_run publisher head');
        },
      },
      issues: {
        listComments: () => {
          throw new Error('listComments must be paginated');
        },
        getComment: async () => api('getComment', () => ({ data: { id: 99, body, user: freshAuthor } })),
        updateComment: async (input) => {
          updates.push(input);
        },
        createComment: async (input) => {
          created.push(input);
        },
      },
      pulls: {
        get: async () =>
          api('pullsGet', () => ({
            data: {
              head: { sha: headShas[Math.min(pullRead++, headShas.length - 1)] },
              user: { login: author },
            },
          })),
      },
      repos: {
        getCollaboratorPermissionLevel: async () => api('permission', () => ({ data: { permission } })),
        listCommitStatusesForRef: async () => api('statuses', () => ({ data: [canonicalStatus] })),
        getContent: async ({ path: reportPath, ref }) =>
          api(`content:${reportPath}`, () => {
            assert.equal(ref, PUBLICATION_SHA);
            const source = reportPath.endsWith('/report.md') ? markdown : reportJson;
            return { data: { type: 'file', encoding: 'base64', content: Buffer.from(source).toString('base64') } };
          }),
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
  await approveScript()(github, context);
  return { statuses, updates, created };
}

test('canonical immutable publication receipt is required before approval turns green', async () => {
  const result = await runApproval();
  assert.deepEqual(
    result.statuses.map(({ state, sha, target_url }) => ({ state, sha, target_url })),
    [{ state: 'success', sha: HEAD_SHA, target_url: REPORT_URL }],
  );
  assert.match(result.updates[0].body, /approved by @reviewer/);
});

test('an unrelated bot comment carrying copied markers cannot approve', async () => {
  for (const freshAuthor of [
    { login: 'dependabot[bot]', type: 'Bot' },
    { login: 'github-actions[bot]', type: 'User' },
    null,
  ]) {
    const result = await runApproval({ freshAuthor });
    assert.deepEqual(result.statuses, []);
    assert.deepEqual(result.updates, []);
  }
});

test('tampered or ambiguous comment identity fails closed', async () => {
  const cases = [
    reportComment({ extra: [`<!-- styleproof-sha:${HEAD_SHA} -->`] }),
    reportComment({ extra: ['<!-- styleproof-sha:malformed -->'] }),
    reportComment({
      extra: [`<!-- styleproof-run-id:${RUN_ID} run-attempt:${RUN_ATTEMPT} -->`],
    }),
    reportComment({ extra: ['<!-- styleproof-run-id:malformed run-attempt:2 -->'] }),
    reportComment({ extra: ['- [x] **Approve all changes**'] }),
    reportComment({ extra: [`### 📊 [**View the side-by-side visual report →**](${REPORT_URL})`] }),
    reportComment().replace('<!-- styleproof-report -->', '<!-- styleproof-report -->\n<!-- styleproof-report -->'),
    reportComment().replace(`blob/${PUBLICATION_SHA}`, `blob/${PUBLICATION_SHA.toUpperCase()}`),
    reportComment().replace('/pr-7/report.md', '/pr-8/report.md'),
    reportComment().replace('/pr-7/report.md)', '/pr-7/report.md?download=1)'),
  ];
  for (const body of cases) {
    const result = await runApproval({ body });
    assert.deepEqual(result.statuses, []);
  }
});

test('publication receipt must exactly bind report commit, run, attempt, and current head', async () => {
  const mismatches = [
    { body: reportComment({ headSha: OTHER_HEAD_SHA }) },
    { body: reportComment({ publicationSha: OTHER_PUBLICATION_SHA }) },
    { body: reportComment({ runId: '9002' }) },
    { body: reportComment({ runAttempt: '3' }) },
    { markdown: publishedMarkdown({ headSha: OTHER_HEAD_SHA }) },
    { markdown: publishedMarkdown({ runId: '9002' }) },
    { markdown: publishedMarkdown({ runAttempt: '3' }) },
  ];
  for (const fixture of mismatches) {
    const result = await runApproval(fixture);
    assert.deepEqual(result.statuses, []);
  }
});

test('only the canonical latest pending StyleProof status is approvable', async () => {
  for (const status of [
    { state: 'success', description: 'StyleProof changes approved', target_url: REPORT_URL, context: 'StyleProof' },
    { state: 'failure', description: 'Base capture incomplete', target_url: REPORT_URL, context: 'StyleProof' },
    { state: 'failure', description: PENDING_DESCRIPTION, target_url: REPORT_URL, context: 'Another check' },
    {
      state: 'failure',
      description: PENDING_DESCRIPTION,
      target_url: REPORT_URL.replace(PUBLICATION_SHA, OTHER_PUBLICATION_SHA),
      context: 'StyleProof',
    },
    { state: 'failure', description: PENDING_DESCRIPTION, target_url: null, context: 'StyleProof' },
  ]) {
    const result = await runApproval({ status });
    assert.deepEqual(result.statuses, []);
  }
});

test('only a canonical GitHub status creator is trusted', async () => {
  const result = await runApproval({
    status: {
      state: 'failure',
      description: PENDING_DESCRIPTION,
      target_url: REPORT_URL,
      context: 'StyleProof',
      creator: { login: 'third-party[bot]', type: 'Bot' },
    },
  });
  assert.deepEqual(result.statuses, []);
});

test('a production workflow_run publication approves without conflating its default-branch head with the PR head', async () => {
  // action.yml publishes github.run_id/run_attempt receipts while workflow_run
  // itself runs on the default branch; the immutable receipt carries the PR head.
  const result = await runApproval();
  assert.deepEqual(
    result.statuses.map(({ state, sha }) => ({ state, sha })),
    [{ state: 'success', sha: HEAD_SHA }],
  );
});

test('an untick cannot launder an immutable unapprovable receipt into a later green', async () => {
  const result = await runApproval({
    status: {
      state: 'failure',
      description: 'Tick "Approve all changes" to sign off',
      target_url: REPORT_URL,
      context: 'StyleProof',
    },
    reportJson: '{"surfaces":[],"actionTrustState":"CERTIFICATION_FAILED"}',
  });
  assert.deepEqual(result.statuses, []);
  assert.deepEqual(result.updates, []);
});

test('a canonical refusal or untick status remains eligible for a later valid reviewer tick', async () => {
  for (const description of ['Tick "Approve all changes" to sign off', 'Needs a reviewer other than @author']) {
    const result = await runApproval({
      status: { state: 'failure', description, target_url: REPORT_URL, context: 'StyleProof' },
    });
    assert.deepEqual(
      result.statuses.map(({ state }) => state),
      ['success'],
    );
  }
});

test('a superseded marker comment cannot approve', async () => {
  const result = await runApproval({ canonicalCommentId: 100 });
  assert.deepEqual(result.statuses, []);
});

test('malformed publication data fails closed without a status write', async () => {
  for (const fixture of [
    { markdown: '# report without receipt' },
    { markdown: `${publishedMarkdown()}${publishedMarkdown()}` },
    { markdown: `${publishedMarkdown()}<!-- styleproof-receipt malformed -->` },
    { reportJson: '{"surfaces":' },
  ]) {
    const result = await runApproval(fixture);
    assert.deepEqual(result.statuses, []);
  }
});

test('GitHub read API failures fail loudly without a status write', async () => {
  for (const failApi of ['statuses', 'content:pr-7/report.md', 'content:pr-7/report.json', 'listComments']) {
    await assert.rejects(
      runApproval({ failApi }),
      failApi.startsWith('content:')
        ? /requires contents: read/
        : new RegExp(`${failApi.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} failed`),
    );
  }
});

test('a new push during approval is detected immediately before the status write', async () => {
  const result = await runApproval({ headShas: [HEAD_SHA, OTHER_HEAD_SHA] });
  assert.deepEqual(result.statuses, []);
  assert.deepEqual(result.updates, []);
});

test('unticking remains fail-safe and does not require publication read access', async () => {
  const result = await runApproval({
    body: reportComment({ ticked: false }),
    actor: 'author',
    failApi: 'content:pr-7/report.md',
  });
  assert.deepEqual(
    result.statuses.map(({ state, sha }) => ({ state, sha })),
    [{ state: 'failure', sha: HEAD_SHA }],
  );
});
