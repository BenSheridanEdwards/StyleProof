// Rerun-attempt supersession (issue #368): `rerun_failed_jobs` re-executes the
// same workflow run as attempt 2+. Attempt 2's publish must supersede attempt
// 1's PR comment and commit status while attempt 1's durable report stays
// retrievable as an audit trail — and a late-arriving attempt-1 delivery must
// never overwrite the verdict attempt 2 already published.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { publishReportFolder, verifyPublishedReceipt } from '../dist/report-publish.js';
import { buildReportDelivery } from '../dist/report-delivery.js';
import {
  formatRunAttemptReceiptMarker,
  parseRunAttemptReceiptMarker,
  shouldSupersedeExistingComment,
} from '../dist/comment-supersession.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const actionYml = fs.readFileSync(path.join(here, '..', 'action.yml'), 'utf8');

/** Stateful in-memory GitHub double covering the git-data API (blobs, trees,
 *  commits, refs) plus the raw-contents read-back. Unlike the per-call double
 *  in report-publish.test.mjs it keeps every object across publishes, so two
 *  sequential attempts hit exactly the history a real repository would hold. */
function buildStatefulGitHubRepository() {
  const state = {
    branchTipByName: new Map(),
    blobContentBySha: new Map(),
    /** tree sha -> Map(full file path -> blob sha), fully resolved. */
    fileMapByTreeSha: new Map(),
    commitBySha: new Map(),
    requests: [],
  };
  let objectCounter = 0;
  const nextSha = (prefix) => `${prefix}-${(objectCounter += 1)}`;

  const respond = (status, body, rawText) => ({
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => rawText ?? JSON.stringify(body),
  });

  const fetchImplementation = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const apiPath = String(url).replace('https://api.example/repos/acme/widgets', '');
    state.requests.push(`${method} ${apiPath}`);

    if (method === 'GET' && apiPath.startsWith('/contents/')) {
      const [, filePath, ref] = apiPath.match(/^\/contents\/(.+)\?ref=(.+)$/) ?? [];
      const commit = state.commitBySha.get(ref);
      const blobSha = commit ? state.fileMapByTreeSha.get(commit.treeSha)?.get(filePath) : undefined;
      if (blobSha === undefined) return respond(404, { message: 'Not Found' });
      return respond(200, {}, state.blobContentBySha.get(blobSha).toString('utf8'));
    }
    if (method === 'GET' && apiPath.startsWith('/git/ref/')) {
      const branchName = decodeURIComponent(apiPath.slice('/git/ref/'.length)).replace('heads/', '');
      const tipSha = state.branchTipByName.get(branchName);
      if (tipSha === undefined) return respond(404, { message: 'Not Found' });
      return respond(200, { object: { sha: tipSha } });
    }
    if (method === 'GET' && apiPath.startsWith('/git/commits/')) {
      const commit = state.commitBySha.get(apiPath.slice('/git/commits/'.length));
      return respond(200, { tree: { sha: commit.treeSha } });
    }
    if (method === 'GET' && apiPath.startsWith('/git/trees/')) {
      const treeSha = apiPath.slice('/git/trees/'.length).replace(/\?.*$/, '');
      const fileMap = state.fileMapByTreeSha.get(treeSha) ?? new Map();
      if (apiPath.includes('recursive')) {
        const tree = [...fileMap.entries()].map(([filePath, blobSha]) => ({
          path: filePath,
          type: 'blob',
          size: state.blobContentBySha.get(blobSha).length,
        }));
        return respond(200, { tree, truncated: false });
      }
      const topLevelEntries = new Map();
      for (const filePath of fileMap.keys()) {
        const [firstSegment] = filePath.split('/');
        const isDirectory = filePath.includes('/');
        topLevelEntries.set(firstSegment, {
          path: firstSegment,
          mode: isDirectory ? '040000' : '100644',
          type: isDirectory ? 'tree' : 'blob',
        });
      }
      return respond(200, { tree: [...topLevelEntries.values()] });
    }
    if (method === 'POST' && apiPath === '/git/blobs') {
      const payload = JSON.parse(options.body);
      const blobSha = nextSha('blob');
      state.blobContentBySha.set(blobSha, Buffer.from(payload.content, payload.encoding));
      return respond(201, { sha: blobSha });
    }
    if (method === 'POST' && apiPath === '/git/trees') {
      const payload = JSON.parse(options.body);
      const fileMap = new Map(payload.base_tree ? state.fileMapByTreeSha.get(payload.base_tree) : []);
      for (const entry of payload.tree) {
        if (entry.sha === null) {
          for (const filePath of [...fileMap.keys()]) {
            if (filePath === entry.path || filePath.startsWith(`${entry.path}/`)) fileMap.delete(filePath);
          }
        } else {
          fileMap.set(entry.path, entry.sha);
        }
      }
      const treeSha = nextSha('tree');
      state.fileMapByTreeSha.set(treeSha, fileMap);
      return respond(201, { sha: treeSha });
    }
    if (method === 'POST' && apiPath === '/git/commits') {
      const payload = JSON.parse(options.body);
      const commitSha = nextSha('commit');
      state.commitBySha.set(commitSha, { treeSha: payload.tree, parents: payload.parents, message: payload.message });
      return respond(201, { sha: commitSha });
    }
    if (method === 'POST' && apiPath === '/git/refs') {
      const payload = JSON.parse(options.body);
      const branchName = payload.ref.replace('refs/heads/', '');
      if (state.branchTipByName.has(branchName)) return respond(422, { message: 'Reference already exists' });
      state.branchTipByName.set(branchName, payload.sha);
      return respond(201, {});
    }
    if (method === 'PATCH' && apiPath.startsWith('/git/refs/')) {
      const branchName = decodeURIComponent(apiPath.slice('/git/refs/'.length)).replace('heads/', '');
      const payload = JSON.parse(options.body);
      const currentTipSha = state.branchTipByName.get(branchName);
      const candidateCommit = state.commitBySha.get(payload.sha);
      if (!candidateCommit.parents.includes(currentTipSha)) {
        return respond(422, { message: 'Update is not a fast forward' });
      }
      state.branchTipByName.set(branchName, payload.sha);
      return respond(200, {});
    }
    throw new Error(`unexpected request: ${method} ${apiPath}`);
  };

  return { state, fetchImplementation };
}

const HEAD_SHA = 'b'.repeat(40);
const RUN_ID = '4242';
const DELIVERY_SHA = 'd'.repeat(40);
const DELIVERY_URL = `https://github.com/acme/widgets/blob/${DELIVERY_SHA}/pr-7/report.md`;

function receiptFor(runAttempt) {
  return `styleproof-receipt head-sha:${HEAD_SHA} run-id:${RUN_ID} run-attempt:${runAttempt}`;
}

function reportFilesFor(runAttempt, verdictLine) {
  // Mirrors bin/styleproof-publish-report.mjs: the run receipt rides inside report.md.
  return [
    {
      relativePath: 'report.md',
      content: Buffer.from(`# report\n${verdictLine}\n<!-- ${receiptFor(runAttempt)} -->\n`),
    },
    {
      relativePath: 'report.json',
      content: Buffer.from(JSON.stringify({ attempt: runAttempt })),
    },
  ];
}

async function publishAttempt(repository, runAttempt, verdictLine) {
  return publishReportFolder({
    apiBaseUrl: 'https://api.example',
    repository: 'acme/widgets',
    token: 'test-token',
    branch: 'styleproof-reports',
    reportPath: 'pr-7',
    files: reportFilesFor(runAttempt, verdictLine),
    commitMessage: `StyleProof report pr-7 @ ${HEAD_SHA}`,
    fetchImplementation: repository.fetchImplementation,
    sleepImplementation: async () => {},
    log: () => {},
  });
}

function verifyReceiptAt(repository, commitSha, runAttempt) {
  return verifyPublishedReceipt({
    apiBaseUrl: 'https://api.example',
    repository: 'acme/widgets',
    token: 'test-token',
    reportPath: 'pr-7',
    commitSha,
    expectedReceipt: receiptFor(runAttempt),
    maximumAttempts: 2,
    sleepImplementation: async () => {},
    fetchImplementation: repository.fetchImplementation,
  });
}

test('attempt 2 supersedes attempt 1 on the report branch while attempt 1 stays retrievable', async () => {
  const repository = buildStatefulGitHubRepository();

  const attemptOne = await publishAttempt(repository, 1, 'verdict: STYLE_REVIEW_REQUIRED');
  await verifyReceiptAt(repository, attemptOne.commitSha, 1);

  const attemptTwo = await publishAttempt(repository, 2, 'verdict: NO_REVIEWABLE_STYLE_CHANGES');

  // Two distinct receipts: the advertised url/raw-base outputs pin the exact
  // published commit, so attempt 2's links can never resolve to attempt 1's report.
  assert.notEqual(attemptTwo.commitSha, attemptOne.commitSha);
  // Attempt 2 grafts onto attempt 1's history — it replaces the pr-7 folder at
  // the tip instead of forking or discarding the branch.
  assert.deepEqual(repository.state.commitBySha.get(attemptTwo.commitSha).parents, [attemptOne.commitSha]);
  assert.equal(repository.state.branchTipByName.get('styleproof-reports'), attemptTwo.commitSha);

  // The branch tip carries attempt 2's report: its receipt verifies at the new
  // commit, and attempt 1's receipt no longer matches there (fail closed), so
  // the comment and status can only ever advertise attempt 2's verdict.
  await verifyReceiptAt(repository, attemptTwo.commitSha, 2);
  await assert.rejects(verifyReceiptAt(repository, attemptTwo.commitSha, 1), /do not trust this run's report/);

  // Audit trail: attempt 1's durable report is still retrievable at its own
  // pinned commit even though nothing links to it any more.
  await verifyReceiptAt(repository, attemptOne.commitSha, 1);
});

test('run-attempt receipt marker round-trips through the comment body', () => {
  const marker = formatRunAttemptReceiptMarker({ runId: RUN_ID, runAttempt: '2' });
  assert.equal(marker, `<!-- styleproof-run-id:${RUN_ID} run-attempt:2 -->`);
  assert.deepEqual(parseRunAttemptReceiptMarker(`comment body\n${marker}\n`), {
    runId: RUN_ID,
    runAttempt: '2',
  });
  assert.equal(parseRunAttemptReceiptMarker('a legacy comment without a receipt'), null);
});

test('attempt 2 may overwrite attempt 1; a late attempt-1 delivery may not overwrite attempt 2', () => {
  const commentByAttemptOne = `report\n${formatRunAttemptReceiptMarker({ runId: RUN_ID, runAttempt: '1' })}`;
  const commentByAttemptTwo = `report\n${formatRunAttemptReceiptMarker({ runId: RUN_ID, runAttempt: '2' })}`;

  // The rerun supersedes in place.
  assert.equal(
    shouldSupersedeExistingComment({ existingCommentBody: commentByAttemptOne, runId: RUN_ID, runAttempt: '2' }),
    true,
  );
  // The ordering guard: a network-retried attempt-1 delivery arriving after
  // attempt 2 published must NOT overwrite the newer verdict.
  assert.equal(
    shouldSupersedeExistingComment({ existingCommentBody: commentByAttemptTwo, runId: RUN_ID, runAttempt: '1' }),
    false,
  );
  // Idempotent re-delivery of the same attempt still upserts.
  assert.equal(
    shouldSupersedeExistingComment({ existingCommentBody: commentByAttemptTwo, runId: RUN_ID, runAttempt: '2' }),
    true,
  );
  // Attempts are only ordered within one run id: a different workflow run
  // (new push, new run id) always supersedes, whatever its attempt number.
  assert.equal(
    shouldSupersedeExistingComment({ existingCommentBody: commentByAttemptTwo, runId: '9999', runAttempt: '1' }),
    true,
  );
  // Comments that predate the receipt (or a missing body) are always superseded.
  assert.equal(
    shouldSupersedeExistingComment({ existingCommentBody: 'legacy comment', runId: RUN_ID, runAttempt: '1' }),
    true,
  );
  assert.equal(
    shouldSupersedeExistingComment({ existingCommentBody: undefined, runId: RUN_ID, runAttempt: '1' }),
    true,
  );
});

/** Mirrors the Upsert PR comment step's control flow (find by marker → guard →
 *  create/update in place) against a mocked issues API, using the exact exported
 *  guard and marker the step imports from dist/. */
function buildCommentDeliverySimulator() {
  const comments = [];
  let nextCommentId = 100;
  const deliver = ({ runAttempt, summary, publicationSha = DELIVERY_SHA, reportUrl = DELIVERY_URL }) => {
    const marker = '<!-- styleproof-report -->';
    const existing = comments.find((comment) => comment.body && comment.body.includes(marker));
    if (
      existing &&
      !shouldSupersedeExistingComment({ existingCommentBody: existing.body, runId: RUN_ID, runAttempt })
    ) {
      return { staleDelivery: true };
    }
    const delivery = buildReportDelivery({
      repository: 'acme/widgets',
      publicationSha,
      prNumber: 7,
      reportUrl,
      repositoryVisibility: 'private',
    });
    const body = [
      marker,
      summary,
      delivery.markdown,
      `<!-- styleproof-sha:${HEAD_SHA} -->`,
      formatRunAttemptReceiptMarker({ runId: RUN_ID, runAttempt }),
    ].join('\n');
    if (existing) existing.body = body;
    else comments.push({ id: (nextCommentId += 1), body });
    return { staleDelivery: false };
  };
  return { comments, deliver };
}

test('the single marker comment ends up reflecting attempt 2, updated in place', () => {
  const simulator = buildCommentDeliverySimulator();

  simulator.deliver({ runAttempt: '1', summary: 'changes need sign-off' });
  assert.equal(simulator.comments.length, 1);
  const commentId = simulator.comments[0].id;

  const attemptTwoDelivery = simulator.deliver({ runAttempt: '2', summary: 'no reviewable changes' });
  assert.equal(attemptTwoDelivery.staleDelivery, false);
  assert.equal(simulator.comments.length, 1, 'attempt 2 updates the marker comment in place — never a second comment');
  assert.equal(simulator.comments[0].id, commentId);
  assert.match(simulator.comments[0].body, /no reviewable changes/);
  assert.match(simulator.comments[0].body, new RegExp(`styleproof-run-id:${RUN_ID} run-attempt:2`));
  assert.doesNotMatch(simulator.comments[0].body, /changes need sign-off/);

  // A late network retry of attempt 1's delivery leaves attempt 2's verdict alone.
  const staleDelivery = simulator.deliver({ runAttempt: '1', summary: 'changes need sign-off' });
  assert.equal(staleDelivery.staleDelivery, true);
  assert.equal(simulator.comments.length, 1);
  assert.match(simulator.comments[0].body, /no reviewable changes/);
  assert.match(simulator.comments[0].body, new RegExp(`styleproof-run-id:${RUN_ID} run-attempt:2`));
});

test('the supersession simulator cannot create a delivery claim without a verified report identity', () => {
  const simulator = buildCommentDeliverySimulator();
  assert.throws(
    () => simulator.deliver({ runAttempt: '1', summary: 'changes need sign-off', reportUrl: '' }),
    /report delivery/i,
  );
  assert.deepEqual(simulator.comments, []);
});

test('composite action wires the rerun ordering guard into the comment and status steps', () => {
  const commentStep = actionYml.match(/- name: Upsert PR comment[\s\S]*?(?=\n\s{4}#|\n\s{4}- name:)/);
  assert.ok(commentStep, 'action.yml should include a PR comment step');
  // The step consumes the SAME compiled guard the unit tests exercise.
  assert.match(commentStep[0], /dist\/comment-supersession\.js/);
  assert.match(commentStep[0], /shouldSupersedeExistingComment/);
  assert.match(commentStep[0], /formatRunAttemptReceiptMarker/);
  // Attempt identity comes from GitHub's own run context, never from artifacts.
  assert.match(commentStep[0], /const runId = '\$\{\{ github\.run_id \}\}'/);
  assert.match(commentStep[0], /const runAttempt = '\$\{\{ github\.run_attempt \}\}'/);
  // The guard runs BEFORE the upsert and short-circuits a stale delivery.
  const guardIndex = commentStep[0].indexOf('shouldSupersedeExistingComment');
  const upsertIndex = commentStep[0].indexOf('const upsert =');
  assert.ok(guardIndex > 0 && upsertIndex > guardIndex, 'the guard must be evaluated before the upsert');
  assert.match(commentStep[0], /setOutput\('stale-delivery', 'true'\)/);
  assert.match(commentStep[0], /setOutput\('stale-delivery', 'false'\)/);
  // The comment records the attempt that wrote it, so the NEXT delivery can order itself.
  assert.match(commentStep[0], /formatRunAttemptReceiptMarker\(\{ runId, runAttempt \}\)/);

  // A stale delivery must not reset the commit status either: the status step is
  // skipped when the comment step classified this delivery as superseded.
  const statusStep = actionYml.match(/- name: Set review status[\s\S]*?(?=\n\s{4}#|\n\s{4}- name:)/);
  assert.ok(statusStep, 'action.yml should include a review-status step');
  assert.match(statusStep[0], /steps\.comment\.outputs\.stale-delivery != 'true'/);
  // The status a fresh delivery sets is bound to the resolved head SHA and this
  // attempt's own verdict, so attempt 2's delivery lands attempt 2's trust state.
  assert.match(statusStep[0], /const sha = '\$\{\{ steps\.context\.outputs\.head-sha \}\}'/);
  assert.match(statusStep[0], /const trustState = '\$\{\{ steps\.verdict\.outputs\.state \}\}'/);
});
