import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  collectReportFiles,
  REPORT_BRANCH_SIZE_WARNING_BYTES,
  publishReportFolder,
  verifyPublishedReceipt,
} from '../dist/report-publish.js';
import {
  createReleaseConfidenceManifest,
  serializeReleaseConfidenceManifest,
} from '../dist/release-confidence-manifest.js';
import { summarizeReleaseConfidence } from '../dist/release-confidence-summary.js';

const PHASE0_FIXTURE = new URL('./fixtures/phase0-contract/valid-enumerated.json', import.meta.url);

/** In-memory GitHub git-data API double. Tracks every request so tests can
 *  assert exactly what crossed the wire — the whole point of the API publisher
 *  is that report bytes go up and nothing comes down. */
function buildFakeGitHub({
  branchTip = null,
  tipTreeEntries = [],
  recursiveTreeEntries = [],
  recursiveTreeTruncated = false,
  refUpdateFailuresBeforeSuccess = 0,
} = {}) {
  const state = {
    requests: [],
    createdBlobs: [],
    createdTrees: [],
    createdCommits: [],
    refUpdates: 0,
    refCreates: 0,
  };
  let remainingRefUpdateFailures = refUpdateFailuresBeforeSuccess;
  const fetchImplementation = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const apiPath = String(url).replace('https://api.example/repos/acme/widgets', '');
    state.requests.push(`${method} ${apiPath}`);
    const respond = (status, body) => ({
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    if (method === 'GET' && apiPath.startsWith('/git/ref/')) {
      if (branchTip === null) return respond(404, { message: 'Not Found' });
      return respond(200, { object: { sha: branchTip } });
    }
    if (method === 'GET' && apiPath.startsWith('/git/commits/')) {
      return respond(200, { tree: { sha: 'tip-tree-sha' } });
    }
    if (method === 'GET' && apiPath.startsWith('/git/trees/') && apiPath.includes('recursive')) {
      return respond(200, { tree: recursiveTreeEntries, truncated: recursiveTreeTruncated });
    }
    if (method === 'GET' && apiPath.startsWith('/git/trees/')) {
      return respond(200, { tree: tipTreeEntries });
    }
    if (method === 'POST' && apiPath === '/git/blobs') {
      const payload = JSON.parse(options.body);
      state.createdBlobs.push(payload);
      return respond(201, { sha: `blob-${state.createdBlobs.length}` });
    }
    if (method === 'POST' && apiPath === '/git/trees') {
      state.createdTrees.push(JSON.parse(options.body));
      return respond(201, { sha: 'published-tree-sha' });
    }
    if (method === 'POST' && apiPath === '/git/commits') {
      state.createdCommits.push(JSON.parse(options.body));
      return respond(201, { sha: 'published-commit-sha' });
    }
    if (method === 'POST' && apiPath === '/git/refs') {
      state.refCreates += 1;
      return respond(201, {});
    }
    if (method === 'PATCH' && apiPath.startsWith('/git/refs/')) {
      state.refUpdates += 1;
      if (remainingRefUpdateFailures > 0) {
        remainingRefUpdateFailures -= 1;
        return respond(422, { message: 'Update is not a fast forward' });
      }
      return respond(200, {});
    }
    throw new Error(`unexpected request: ${method} ${apiPath}`);
  };
  return { state, fetchImplementation };
}

const baseRequest = {
  apiBaseUrl: 'https://api.example',
  repository: 'acme/widgets',
  token: 'test-token',
  branch: 'styleproof-reports',
  reportPath: 'pr-7',
  commitMessage: 'StyleProof report pr-7 @ headsha',
  sleepImplementation: async () => {},
  log: () => {},
};

const reportFiles = [
  { relativePath: 'report.md', content: Buffer.from('# report') },
  { relativePath: 'crops/hero.png', content: Buffer.from([1, 2, 3]) },
];

test('collectReportFiles publishes report JSON, canonical confidence sidecar, markdown, and crops', (t) => {
  const reportDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-report-publish-'));
  t.after(() => fs.rmSync(reportDirectory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(reportDirectory, 'crops'));
  fs.writeFileSync(path.join(reportDirectory, 'report.md'), '# report');
  fs.writeFileSync(path.join(reportDirectory, 'report.json'), '{"surfaces":[]}');
  fs.writeFileSync(path.join(reportDirectory, 'styleproof-release-confidence.json'), '{"kind":"sidecar"}');
  fs.writeFileSync(path.join(reportDirectory, 'crops', 'hero.png'), Buffer.from([1, 2, 3]));

  const files = collectReportFiles(reportDirectory);

  assert.deepEqual(
    files.map((file) => file.relativePath),
    ['report.md', 'report.json', 'styleproof-release-confidence.json', 'crops/hero.png'],
  );
  assert.equal(files[1].content.toString('utf8'), '{"surfaces":[]}');
  assert.equal(files[2].content.toString('utf8'), '{"kind":"sidecar"}');
});

test('collectReportFiles fails closed when the confidence sidecar is missing', (t) => {
  const reportDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-report-publish-'));
  t.after(() => fs.rmSync(reportDirectory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(reportDirectory, 'report.md'), '# report');
  fs.writeFileSync(path.join(reportDirectory, 'report.json'), '{"surfaces":[]}');
  assert.throws(() => collectReportFiles(reportDirectory));
});

test('publishes onto an existing branch without downloading any report bytes', async () => {
  const fake = buildFakeGitHub({
    branchTip: 'tip-sha',
    tipTreeEntries: [
      { path: 'README.md', type: 'blob', mode: '100644' },
      { path: 'pr-3', type: 'tree', mode: '040000' },
    ],
  });
  const result = await publishReportFolder({
    ...baseRequest,
    files: reportFiles,
    fetchImplementation: fake.fetchImplementation,
  });

  assert.equal(result.commitSha, 'published-commit-sha');
  assert.equal(fake.state.createdBlobs.length, 2);
  assert.deepEqual(fake.state.createdCommits[0].parents, ['tip-sha']);
  const [treePayload] = fake.state.createdTrees;
  assert.equal(treePayload.base_tree, 'tip-tree-sha');
  // No blob content ever comes down: the only GETs are refs, one commit, and trees.
  const downloadRequests = fake.state.requests.filter(
    (request) => request.startsWith('GET') && request.includes('/git/blobs'),
  );
  assert.deepEqual(downloadRequests, []);
});

test('replaces a stale folder for the same PR and leaves other folders alone', async () => {
  const fake = buildFakeGitHub({
    branchTip: 'tip-sha',
    tipTreeEntries: [
      { path: 'README.md', type: 'blob', mode: '100644' },
      { path: 'pr-7', type: 'tree', mode: '040000' },
      { path: 'pr-3', type: 'tree', mode: '040000' },
    ],
  });
  await publishReportFolder({
    ...baseRequest,
    files: reportFiles,
    fetchImplementation: fake.fetchImplementation,
  });
  const [treePayload] = fake.state.createdTrees;
  const deletions = treePayload.tree.filter((entry) => entry.sha === null);
  assert.deepEqual(deletions, [{ path: 'pr-7', mode: '040000', type: 'tree', sha: null }]);
});

test('does not send a deletion when this PR has no folder on the tip', async () => {
  const fake = buildFakeGitHub({
    branchTip: 'tip-sha',
    tipTreeEntries: [{ path: 'README.md', type: 'blob', mode: '100644' }],
  });
  await publishReportFolder({
    ...baseRequest,
    files: reportFiles,
    fetchImplementation: fake.fetchImplementation,
  });
  const [treePayload] = fake.state.createdTrees;
  assert.equal(
    treePayload.tree.some((entry) => entry.sha === null),
    false,
  );
});

test('first run creates the branch as an orphan with a README', async () => {
  const fake = buildFakeGitHub({ branchTip: null });
  const result = await publishReportFolder({
    ...baseRequest,
    files: reportFiles,
    fetchImplementation: fake.fetchImplementation,
  });
  assert.equal(result.commitSha, 'published-commit-sha');
  assert.deepEqual(fake.state.createdCommits[0].parents, []);
  assert.equal(fake.state.refCreates, 1);
  assert.equal(fake.state.refUpdates, 0);
  const [treePayload] = fake.state.createdTrees;
  assert.equal(treePayload.base_tree, undefined);
  assert.ok(treePayload.tree.some((entry) => entry.path === 'README.md'));
});

test('seeds a missing README onto an existing branch', async () => {
  const fake = buildFakeGitHub({ branchTip: 'tip-sha', tipTreeEntries: [] });
  await publishReportFolder({
    ...baseRequest,
    files: reportFiles,
    fetchImplementation: fake.fetchImplementation,
  });
  const [treePayload] = fake.state.createdTrees;
  assert.ok(treePayload.tree.some((entry) => entry.path === 'README.md'));
});

test('retries the fast-forward race against the fresh tip and succeeds', async () => {
  const fake = buildFakeGitHub({
    branchTip: 'tip-sha',
    tipTreeEntries: [],
    refUpdateFailuresBeforeSuccess: 2,
  });
  const result = await publishReportFolder({
    ...baseRequest,
    files: reportFiles,
    fetchImplementation: fake.fetchImplementation,
  });
  assert.equal(result.commitSha, 'published-commit-sha');
  assert.equal(fake.state.refUpdates, 3);
});

test('gives up after the attempt budget and surfaces the race error', async () => {
  const fake = buildFakeGitHub({
    branchTip: 'tip-sha',
    tipTreeEntries: [],
    refUpdateFailuresBeforeSuccess: 99,
  });
  await assert.rejects(
    publishReportFolder({
      ...baseRequest,
      files: reportFiles,
      maximumAttempts: 3,
      fetchImplementation: fake.fetchImplementation,
    }),
    /422/,
  );
  assert.equal(fake.state.refUpdates, 3);
});

test('a non-retryable client error fails immediately', async () => {
  const failingFetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({}),
    text: async () => 'bad credentials',
  });
  const fake = { fetchImplementation: failingFetch };
  let attempts = 0;
  await assert.rejects(
    publishReportFolder({
      ...baseRequest,
      files: reportFiles,
      fetchImplementation: async (...requestArguments) => {
        attempts += 1;
        return fake.fetchImplementation(...requestArguments);
      },
    }),
    /401/,
  );
  assert.equal(attempts, 1);
});

test('measures branch size after publish and warns above the threshold', async () => {
  const warningLines = [];
  const fake = buildFakeGitHub({
    branchTip: 'tip-sha',
    tipTreeEntries: [],
    recursiveTreeEntries: [
      { path: 'pr-1/a.png', type: 'blob', size: REPORT_BRANCH_SIZE_WARNING_BYTES },
      { path: 'pr-2/b.png', type: 'blob', size: 5 },
    ],
  });
  const result = await publishReportFolder({
    ...baseRequest,
    files: reportFiles,
    fetchImplementation: fake.fetchImplementation,
    log: (line) => warningLines.push(line),
  });
  assert.equal(result.branchSizeBytes, REPORT_BRANCH_SIZE_WARNING_BYTES + 5);
  assert.ok(warningLines.some((line) => line.startsWith('::warning::')));
});

test('a truncated tree listing skips size telemetry instead of guessing', async () => {
  const warningLines = [];
  const fake = buildFakeGitHub({
    branchTip: 'tip-sha',
    tipTreeEntries: [],
    recursiveTreeEntries: [{ path: 'pr-1/a.png', type: 'blob', size: 10 }],
    recursiveTreeTruncated: true,
  });
  const result = await publishReportFolder({
    ...baseRequest,
    files: reportFiles,
    fetchImplementation: fake.fetchImplementation,
    log: (line) => warningLines.push(line),
  });
  assert.equal(result.branchSizeBytes, null);
  assert.deepEqual(warningLines, []);
});

test('receipt verification passes when all published confidence artifacts match this run', async () => {
  const contract = JSON.parse(fs.readFileSync(PHASE0_FIXTURE, 'utf8'));
  const sourceSha = contract.sourceRuns[0].sourceSha;
  const manifest = createReleaseConfidenceManifest({
    manifestId: 'rcm-published-control',
    producerVersion: '6.2.2',
    releaseScope: 'styleproof-report',
    contract,
  });
  const summary = summarizeReleaseConfidence(manifest);
  const byName = {
    'report.md': 'report body\n<!-- styleproof-receipt head-sha:abc run-id:1 run-attempt:1 -->\n',
    'report.json': JSON.stringify({ releaseConfidence: summary }),
    'styleproof-release-confidence.json': serializeReleaseConfidenceManifest(manifest),
  };
  const fetchImplementation = async (url) => {
    const name = Object.keys(byName).find((entry) => String(url).includes(`/${entry}?`));
    return { ok: Boolean(name), status: name ? 200 : 404, text: async () => (name ? byName[name] : '') };
  };
  await verifyPublishedReceipt({
    apiBaseUrl: 'https://api.example',
    repository: 'acme/widgets',
    token: 'test-token',
    reportPath: 'pr-7',
    commitSha: 'published-commit-sha',
    expectedReceipt: 'styleproof-receipt head-sha:abc run-id:1 run-attempt:1',
    expectedManifestDigest: manifest.manifestDigest,
    expectedSourceSha: sourceSha,
    fetchImplementation,
  });
});

test('receipt verification rejects merge-digest or trusted-source drift with all artifacts present', async () => {
  const contract = JSON.parse(fs.readFileSync(PHASE0_FIXTURE, 'utf8'));
  const sourceSha = contract.sourceRuns[0].sourceSha;
  const manifest = createReleaseConfidenceManifest({
    manifestId: 'rcm-published-drift',
    producerVersion: '6.2.2',
    releaseScope: 'styleproof-report',
    contract,
  });
  const byName = {
    'report.md': 'report body\n<!-- styleproof-receipt head-sha:abc run-id:1 run-attempt:1 -->\n',
    'report.json': JSON.stringify({ releaseConfidence: summarizeReleaseConfidence(manifest) }),
    'styleproof-release-confidence.json': serializeReleaseConfidenceManifest(manifest),
  };
  const fetchImplementation = async (url) => {
    const name = Object.keys(byName).find((entry) => String(url).includes(`/${entry}?`));
    return { ok: Boolean(name), status: name ? 200 : 404, text: async () => (name ? byName[name] : '') };
  };
  const options = {
    apiBaseUrl: 'https://api.example',
    repository: 'acme/widgets',
    token: 'test-token',
    reportPath: 'pr-7',
    commitSha: 'published-commit-sha',
    expectedReceipt: 'styleproof-receipt head-sha:abc run-id:1 run-attempt:1',
    expectedManifestDigest: manifest.manifestDigest,
    expectedSourceSha: sourceSha,
    maximumAttempts: 1,
    fetchImplementation,
  };
  await assert.rejects(
    verifyPublishedReceipt({ ...options, expectedManifestDigest: 'f'.repeat(64) }),
    /do not trust this run's report/,
  );
  await assert.rejects(
    verifyPublishedReceipt({ ...options, expectedSourceSha: 'e'.repeat(40) }),
    /do not trust this run's report/,
  );
});

test('receipt verification rejects a published Markdown receipt without the confidence sidecar', async () => {
  const digest = 'a'.repeat(64);
  const fetchImplementation = async (url) => {
    if (String(url).includes('/report.md?')) {
      return {
        ok: true,
        status: 200,
        text: async () => 'report body\n<!-- styleproof-receipt head-sha:abc run-id:1 run-attempt:1 -->\n',
      };
    }
    if (String(url).includes('/report.json?')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ releaseConfidence: { manifestDigest: digest } }),
      };
    }
    return { ok: false, status: 404, text: async () => '' };
  };
  await assert.rejects(
    verifyPublishedReceipt({
      apiBaseUrl: 'https://api.example',
      repository: 'acme/widgets',
      token: 'test-token',
      reportPath: 'pr-7',
      commitSha: 'published-commit-sha',
      expectedReceipt: 'styleproof-receipt head-sha:abc run-id:1 run-attempt:1',
      expectedManifestDigest: digest,
      expectedSourceSha: 'b'.repeat(40),
      maximumAttempts: 1,
      fetchImplementation,
    }),
    /do not trust this run's report/,
  );
});

test('receipt verification fails closed on a stale or unreadable report', async () => {
  const fetchImplementation = async () => ({
    ok: true,
    status: 200,
    text: async () => 'report body with an older run receipt',
  });
  await assert.rejects(
    verifyPublishedReceipt({
      apiBaseUrl: 'https://api.example',
      repository: 'acme/widgets',
      token: 'test-token',
      reportPath: 'pr-7',
      commitSha: 'published-commit-sha',
      expectedReceipt: 'styleproof-receipt head-sha:abc run-id:1 run-attempt:1',
      maximumAttempts: 2,
      sleepImplementation: async () => {},
      fetchImplementation,
    }),
    /do not trust this run's report/,
  );
});
