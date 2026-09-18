import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const approveYml = fs.readFileSync(path.join(root, 'example/styleproof-approve.yml'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const HEAD_SHA = 'a'.repeat(40);
const OTHER_HEAD_SHA = 'b'.repeat(40);
const PUBLICATION_SHA = 'c'.repeat(40);
const OTHER_PUBLICATION_SHA = 'd'.repeat(40);
const RUN_ID = '9001';
const RUN_ATTEMPT = '2';
const ARTIFACT_ID = '4451';
const REPORT_URL = `https://github.com/acme/app/blob/${PUBLICATION_SHA}/pr-7/report.md`;
const ARTIFACT_URL = `https://github.com/acme/app/actions/runs/${RUN_ID}/artifacts/${ARTIFACT_ID}`;
const RUN_PAGE_URL = `https://github.com/acme/app/actions/runs/${RUN_ID}`;
const PENDING_DESCRIPTION = 'StyleProof changes need sign-off — tick the box in the report comment';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build the smallest structurally valid zip upload-artifact could produce:
 * deflated local entries plus a central directory — the shape the approval
 * workflow's reader walks. CRCs are real so the fixture stays honest.
 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const raw = Buffer.from(content, 'utf8');
    const data = zlib.deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    locals.push(local, nameBuffer, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuffer);
    offset += 30 + nameBuffer.length + data.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}

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
  link,
  extra = [],
} = {}) {
  const anchor =
    link === undefined
      ? `### 📊 [**View the side-by-side visual report →**](https://github.com/acme/app/blob/${publicationSha}/pr-7/report.md)`
      : link.includes('/actions/runs/')
        ? `### 📊 [**Download the visual report artifact →**](${link})`
        : `### 📊 [**View the side-by-side visual report →**](${link})`;
  return [
    '<!-- styleproof-report -->',
    '## StyleProof report',
    '',
    `- [${ticked ? 'x' : ' '}] **Approve all changes**`,
    '',
    anchor,
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
  artifactId = ARTIFACT_ID,
  artifacts,
  artifactZip,
  fetchOk = true,
  failApi,
  digest,
  downloadStatus,
} = {}) {
  const statuses = [];
  const updates = [];
  const created = [];
  const calls = [];
  let pullRead = 0;
  const api = async (name, implementation) => {
    calls.push(name);
    if (failApi === name) throw new Error(`${name} failed`);
    return implementation();
  };
  const resolvedZip =
    artifactZip === undefined ? makeZip({ 'report.md': markdown, 'report.json': reportJson }) : artifactZip;
  // #702: an artifact-mode comment pins the uploaded bytes through the digest
  // marker. Default to the digest of the zip under test; `digest: null` omits
  // the marker and any other value is written verbatim (malformed or wrong).
  if (body.includes('/actions/runs/') && digest !== null) {
    const hex = digest === undefined ? createHash('sha256').update(resolvedZip).digest('hex') : digest;
    body += `\n<!-- styleproof-artifact-digest:sha256:${hex} -->`;
  }
  const comments = [{ id: canonicalCommentId, body, user: freshAuthor }];
  const canonicalStatus = {
    creator: { login: 'github-actions[bot]', type: 'Bot' },
    ...status,
  };
  const github = {
    paginate: async (route, params) => {
      if (route === github.rest.actions.listWorkflowRunArtifacts) {
        assert.equal(params.run_id, Number(RUN_ID));
        return api('listArtifacts', () => artifacts ?? [{ id: Number(ARTIFACT_ID), name: 'styleproof-report-pr-7' }]);
      }
      assert.equal(route, github.rest.issues.listComments);
      assert.equal(params.issue_number, 7);
      return api('listComments', () => comments);
    },
    rest: {
      actions: {
        getWorkflowRun: async () => {
          throw new Error('approval must not query the workflow_run publisher head');
        },
        listWorkflowRunArtifacts: () => {
          throw new Error('listWorkflowRunArtifacts must be paginated');
        },
        downloadArtifact: async ({ artifact_id }) =>
          api('downloadArtifact', () => {
            assert.equal(String(artifact_id), artifactId);
            if (downloadStatus) {
              throw Object.assign(new Error(`artifact download failed: ${downloadStatus}`), { status: downloadStatus });
            }
            return { url: 'https://download.test/report-artifact.zip' };
          }),
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
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) =>
    api('fetch', () => {
      assert.equal(url, 'https://download.test/report-artifact.zip');
      return { ok: fetchOk, arrayBuffer: async () => resolvedZip };
    });
  try {
    await approveScript()(github, context);
  } finally {
    globalThis.fetch = previousFetch;
  }
  return { statuses, updates, created, calls };
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

test('artifact-published reports verify the receipt inside the run artifact (#587)', async () => {
  const result = await runApproval({
    body: reportComment({ link: ARTIFACT_URL }),
    status: { state: 'failure', description: PENDING_DESCRIPTION, target_url: ARTIFACT_URL, context: 'StyleProof' },
  });
  assert.deepEqual(
    result.statuses.map(({ state, sha, target_url }) => ({ state, sha, target_url })),
    [{ state: 'success', sha: HEAD_SHA, target_url: ARTIFACT_URL }],
  );
  assert.ok(result.calls.includes('downloadArtifact'), 'the readback must come from the artifact');
  assert.equal(
    result.calls.some((call) => call.startsWith('content:')),
    false,
    'artifact publications must not read the report branch',
  );
});

test('a run-page report link resolves the one named report artifact (#587)', async () => {
  const result = await runApproval({
    body: reportComment({ link: RUN_PAGE_URL }),
    status: { state: 'failure', description: PENDING_DESCRIPTION, target_url: RUN_PAGE_URL, context: 'StyleProof' },
  });
  assert.deepEqual(
    result.statuses.map(({ state, sha }) => ({ state, sha })),
    [{ state: 'success', sha: HEAD_SHA }],
  );
  assert.ok(result.calls.includes('listArtifacts'));
});

test('artifact publications bind the link run to the comment run receipt (#587)', async () => {
  for (const link of [
    `https://github.com/acme/app/actions/runs/9002/artifacts/${ARTIFACT_ID}`,
    `https://github.com/acme/app/actions/runs/${RUN_ID}/artifacts/${ARTIFACT_ID}?extra=1`,
    `https://github.com/acme/other/actions/runs/${RUN_ID}/artifacts/${ARTIFACT_ID}`,
    `https://github.com/acme/app/actions/runs/${RUN_ID}/artifacts/not-a-number`,
  ]) {
    const result = await runApproval({
      body: reportComment({ link }),
      status: { state: 'failure', description: PENDING_DESCRIPTION, target_url: link, context: 'StyleProof' },
    });
    assert.deepEqual(result.statuses, [], `link ${link} must not approve`);
    assert.equal(result.calls.includes('downloadArtifact'), false);
  }
});

test('mixed or missing artifact identity fails closed (#587)', async () => {
  // One comment cannot carry both delivery shapes or a missing artifact entry.
  const mixed = reportComment({
    link: ARTIFACT_URL,
    extra: [`### 📊 [**View the side-by-side visual report →**](${REPORT_URL})`],
  });
  assert.deepEqual(
    (
      await runApproval({
        body: mixed,
        status: { state: 'failure', description: PENDING_DESCRIPTION, target_url: ARTIFACT_URL, context: 'StyleProof' },
      })
    ).statuses,
    [],
  );

  assert.deepEqual(
    (
      await runApproval({
        body: reportComment({ link: RUN_PAGE_URL }),
        status: { state: 'failure', description: PENDING_DESCRIPTION, target_url: RUN_PAGE_URL, context: 'StyleProof' },
        artifacts: [],
      })
    ).statuses,
    [],
  );

  assert.deepEqual(
    (
      await runApproval({
        body: reportComment({ link: RUN_PAGE_URL }),
        status: { state: 'failure', description: PENDING_DESCRIPTION, target_url: RUN_PAGE_URL, context: 'StyleProof' },
        artifacts: [
          { id: Number(ARTIFACT_ID), name: 'styleproof-report-pr-7' },
          { id: 9999, name: 'styleproof-report-pr-7' },
        ],
      })
    ).statuses,
    [],
  );
});

test('artifact readback failures fail closed without a status write (#587)', async () => {
  const artifactBody = reportComment({ link: ARTIFACT_URL });
  const artifactStatus = {
    state: 'failure',
    description: PENDING_DESCRIPTION,
    target_url: ARTIFACT_URL,
    context: 'StyleProof',
  };
  for (const fixture of [
    {
      artifactZip: makeZip({
        'report.md': '# no receipt',
        'report.json': '{"actionTrustState":"STYLE_REVIEW_REQUIRED"}',
      }),
    },
    { artifactZip: makeZip({ 'report.json': '{"actionTrustState":"STYLE_REVIEW_REQUIRED"}' }) },
    { artifactZip: makeZip({ 'report.md': publishedMarkdown(), 'report.json': '{"surfaces":' }) },
    { artifactZip: Buffer.from('not a zip') },
    { fetchOk: false },
  ]) {
    const result = await runApproval({ body: artifactBody, status: artifactStatus, ...fixture });
    assert.deepEqual(result.statuses, []);
  }
  await assert.rejects(
    runApproval({ body: artifactBody, status: artifactStatus, failApi: 'downloadArtifact' }),
    /requires actions: read/,
  );
});

test('an expired or deleted report artifact refuses with a re-run remediation (#704)', async () => {
  const artifactStatus = (url) => ({
    state: 'failure',
    description: PENDING_DESCRIPTION,
    target_url: url,
    context: 'StyleProof',
  });
  const assertRemediationRefusal = (result) => {
    // No approval and no status churn — the pending red stays correct.
    assert.deepEqual(result.statuses, []);
    // The box is unticked so its state matches the refusal it left behind.
    assert.equal(result.updates.length, 1);
    assert.match(
      result.updates[0].body,
      /\[ \] \*\*Approve all changes\*\* — _report artifact expired or was deleted_/,
    );
    // One bounded reply names the remediation instead of silent dead-ending.
    assert.equal(result.created.length, 1);
    assert.match(result.created[0].body, /@reviewer — the report artifact/);
    assert.match(result.created[0].body, /expired or been deleted/);
    assert.match(result.created[0].body, /Re-run the StyleProof workflow/);
    assert.match(result.created[0].body, new RegExp(`styleproof-approve:expired-artifact:${HEAD_SHA}`));
  };
  // An artifact-ID link: the download API reports the artifact gone.
  for (const downloadStatus of [404, 410]) {
    assertRemediationRefusal(
      await runApproval({
        body: reportComment({ link: ARTIFACT_URL }),
        status: artifactStatus(ARTIFACT_URL),
        downloadStatus,
      }),
    );
  }
  // A run-page link: the report artifact name resolves zero artifacts.
  assertRemediationRefusal(
    await runApproval({
      body: reportComment({ link: RUN_PAGE_URL }),
      status: artifactStatus(RUN_PAGE_URL),
      artifacts: [],
    }),
  );
  // The signed download URL itself no longer responds.
  assertRemediationRefusal(
    await runApproval({
      body: reportComment({ link: ARTIFACT_URL }),
      status: artifactStatus(ARTIFACT_URL),
      fetchOk: false,
    }),
  );
});

test('unavailable-but-ambiguous or non-gone download failures stay on existing paths (#704)', async () => {
  // Two same-named artifacts are an ambiguous publication, not an absent one —
  // integrity failures stay silent with no reviewer-facing remediation.
  const ambiguous = await runApproval({
    body: reportComment({ link: RUN_PAGE_URL }),
    status: {
      state: 'failure',
      description: PENDING_DESCRIPTION,
      target_url: RUN_PAGE_URL,
      context: 'StyleProof',
    },
    artifacts: [
      { id: 1, name: 'styleproof-report-pr-7' },
      { id: 2, name: 'styleproof-report-pr-7' },
    ],
  });
  assert.deepEqual(ambiguous.statuses, []);
  assert.deepEqual(ambiguous.updates, []);
  assert.deepEqual(ambiguous.created, []);
  // A download failure that is not 404/410 is a permissions class, not expiry —
  // it still throws the actions: read diagnostic.
  await assert.rejects(
    runApproval({
      body: reportComment({ link: ARTIFACT_URL }),
      status: {
        state: 'failure',
        description: PENDING_DESCRIPTION,
        target_url: ARTIFACT_URL,
        context: 'StyleProof',
      },
      downloadStatus: 403,
    }),
    /requires actions: read/,
  );
});

test('the artifact digest marker binds the downloaded bytes (#702)', async () => {
  const artifactStatus = {
    state: 'failure',
    description: PENDING_DESCRIPTION,
    target_url: ARTIFACT_URL,
    context: 'StyleProof',
  };
  const marker = (hex) => `<!-- styleproof-artifact-digest:sha256:${hex} -->`;

  // The uploaded bytes must hash to the comment's single well-formed digest —
  // missing, malformed, duplicated, and mismatched markers all fail closed.
  for (const [label, fixture] of [
    ['no marker', { digest: null }],
    ['a malformed digest', { digest: 'deadbeef' }],
    ['a digest of different bytes', { digest: 'f'.repeat(64) }],
    [
      'bytes swapped after publication',
      {
        digest: createHash('sha256')
          .update(
            makeZip({
              'report.md': publishedMarkdown(),
              'report.json': '{"surfaces":[],"actionTrustState":"STYLE_REVIEW_REQUIRED"}',
            }),
          )
          .digest('hex'),
        artifactZip: makeZip({
          'report.md': publishedMarkdown(),
          'report.json': '{"actionTrustState":"STYLE_REVIEW_REQUIRED","tampered":true}',
        }),
      },
    ],
  ]) {
    const result = await runApproval({
      body: reportComment({ link: ARTIFACT_URL }),
      status: artifactStatus,
      ...fixture,
    });
    assert.deepEqual(result.statuses, [], `${label} must not approve`);
  }

  // A second digest marker makes the identity ambiguous even when one matches.
  const duplicated = await runApproval({
    body: reportComment({ link: ARTIFACT_URL, extra: [marker('a'.repeat(64))] }),
    status: artifactStatus,
  });
  assert.deepEqual(duplicated.statuses, [], 'two digest markers must not approve');
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
