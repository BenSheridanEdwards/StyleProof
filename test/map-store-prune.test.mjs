import assert from 'node:assert/strict';
import test from 'node:test';
import { MAP_STORE_PRUNE_SIDECAR, compactMapStoreBranch, selectMapBundlesToRetain } from '../dist/map-store-prune.js';

const DAY_IN_SECONDS = 86400;
const NOW = 1_800_000_000;

function selection({ bundles, publishedDaysAgo, retentionDays = 14, maximumBundleCount = 40 }) {
  return selectMapBundlesToRetain({
    bundleDirectoryNames: bundles,
    lastPublishedEpochSecondsByDirectoryName: new Map(
      Object.entries(publishedDaysAgo).map(([directoryName, daysAgo]) => [
        directoryName,
        NOW - daysAgo * DAY_IN_SECONDS,
      ]),
    ),
    retentionCutoffEpochSeconds: NOW - retentionDays * DAY_IN_SECONDS,
    maximumBundleCount,
  });
}

test('retention keeps bundles inside the window and prunes the rest', () => {
  const result = selection({
    bundles: ['aaa', 'bbb', 'ccc'],
    publishedDaysAgo: { aaa: 40, bbb: 13, ccc: 1 },
  });
  assert.deepEqual(result.retainedDirectoryNames, ['ccc', 'bbb']);
  assert.deepEqual(result.prunedDirectoryNames, ['aaa']);
});

test('the bundle cap prunes inside the window, oldest first', () => {
  const result = selection({
    bundles: ['aaa', 'bbb', 'ccc', 'ddd'],
    publishedDaysAgo: { aaa: 4, bbb: 3, ccc: 2, ddd: 1 },
    maximumBundleCount: 2,
  });
  assert.deepEqual(result.retainedDirectoryNames, ['ddd', 'ccc']);
  assert.deepEqual(result.prunedDirectoryNames, ['bbb', 'aaa']);
});

test('a bundle with no known date sorts oldest and prunes first', () => {
  // Legacy bundles predate both the sidecar and any reachable log commit —
  // the only honest date is "unknown", which must never outrank a dated one.
  const result = selection({
    bundles: ['legacy', 'dated'],
    publishedDaysAgo: { dated: 1 },
  });
  assert.deepEqual(result.retainedDirectoryNames, ['dated']);
  assert.deepEqual(result.prunedDirectoryNames, ['legacy']);
});

test('equal dates fall back to a deterministic name order', () => {
  const result = selection({
    bundles: ['bbb', 'aaa'],
    publishedDaysAgo: { aaa: 1, bbb: 1 },
    maximumBundleCount: 1,
  });
  assert.deepEqual(result.retainedDirectoryNames, ['aaa']);
  assert.deepEqual(result.prunedDirectoryNames, ['bbb']);
});

/** Git-data API double for the compaction path. */
function buildFakeGitHub({
  branchTip = 'tip-sha',
  rootTreeEntries = [],
  commitPages = [[]],
  blobContentsBySha = {},
  serverFailuresBeforeSuccess = 0,
} = {}) {
  const state = { createdTrees: [], createdCommits: [], createdBlobs: [], refUpdates: [] };
  let remainingServerFailures = serverFailuresBeforeSuccess;
  const fetchImplementation = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const apiPath = String(url).replace('https://api.example/repos/acme/widgets', '');
    const respond = (status, body) => ({
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    if (remainingServerFailures > 0) {
      remainingServerFailures -= 1;
      return respond(500, { message: 'flake' });
    }
    if (method === 'GET' && apiPath.startsWith('/git/ref/')) {
      if (branchTip === null) return respond(404, { message: 'Not Found' });
      return respond(200, { object: { sha: branchTip } });
    }
    if (method === 'GET' && apiPath.startsWith('/git/commits/')) {
      return respond(200, { tree: { sha: 'tip-tree-sha' } });
    }
    if (method === 'GET' && apiPath.startsWith('/git/trees/')) {
      return respond(200, { tree: rootTreeEntries });
    }
    if (method === 'GET' && apiPath.startsWith('/git/blobs/')) {
      const blobSha = apiPath.slice('/git/blobs/'.length);
      const content = blobContentsBySha[blobSha];
      if (content === undefined) return respond(404, { message: 'Not Found' });
      return respond(200, { content: Buffer.from(content).toString('base64'), encoding: 'base64' });
    }
    if (method === 'GET' && apiPath.startsWith('/commits')) {
      const pageNumber = Number(/[?&]page=(\d+)/.exec(apiPath)?.[1] ?? '1');
      return respond(200, commitPages[pageNumber - 1] ?? []);
    }
    if (method === 'POST' && apiPath === '/git/blobs') {
      const payload = JSON.parse(options.body);
      state.createdBlobs.push(Buffer.from(payload.content, 'base64').toString('utf8'));
      return respond(201, { sha: `created-blob-${state.createdBlobs.length}` });
    }
    if (method === 'POST' && apiPath === '/git/trees') {
      state.createdTrees.push(JSON.parse(options.body));
      return respond(201, { sha: 'compacted-tree-sha' });
    }
    if (method === 'POST' && apiPath === '/git/commits') {
      state.createdCommits.push(JSON.parse(options.body));
      return respond(201, { sha: 'compaction-commit-sha' });
    }
    if (method === 'PATCH' && apiPath.startsWith('/git/refs/')) {
      state.refUpdates.push(JSON.parse(options.body));
      return respond(200, {});
    }
    throw new Error(`unexpected request: ${method} ${apiPath}`);
  };
  return { state, fetchImplementation };
}

const apiOptions = {
  apiBaseUrl: 'https://api.example',
  repository: 'acme/widgets',
  token: 'test-token',
  branch: 'styleproof-maps',
  nowEpochSeconds: NOW,
  sleepImplementation: async () => {},
  log: () => {},
};

function publishCommit(sha12, daysAgo) {
  return {
    commit: {
      message: `StyleProof map ${sha12} f613262bd2a2690a`,
      committer: { date: new Date((NOW - daysAgo * DAY_IN_SECONDS) * 1000).toISOString() },
    },
  };
}

const FRESH_SHA = 'aaaaaaaaaaaa1111111111111111111111111111';
const STALE_SHA = 'bbbbbbbbbbbb2222222222222222222222222222';
const LEGACY_SHA = 'cccccccccccc3333333333333333333333333333';

test('compaction retains dated fresh bundles and squashes to an orphan commit', async () => {
  const fake = buildFakeGitHub({
    rootTreeEntries: [
      { path: FRESH_SHA, type: 'tree', mode: '040000', sha: 'fresh-tree' },
      { path: STALE_SHA, type: 'tree', mode: '040000', sha: 'stale-tree' },
      { path: LEGACY_SHA, type: 'tree', mode: '040000', sha: 'legacy-tree' },
      { path: 'README.md', type: 'blob', mode: '100644', sha: 'readme-blob' },
    ],
    commitPages: [[publishCommit(FRESH_SHA.slice(0, 12), 1), publishCommit(STALE_SHA.slice(0, 12), 40)]],
  });
  const result = await compactMapStoreBranch({ ...apiOptions, fetchImplementation: fake.fetchImplementation });
  assert.equal(result.compacted, true);
  assert.deepEqual(result.retainedDirectoryNames, [FRESH_SHA]);
  assert.deepEqual(result.prunedDirectoryNames.sort(), [STALE_SHA, LEGACY_SHA].sort());

  const [treePayload] = fake.state.createdTrees;
  assert.equal(treePayload.base_tree, undefined, 'the compacted tree is a full new root, not a delta');
  const retainedPaths = treePayload.tree.map((entry) => entry.path);
  assert.deepEqual(retainedPaths, [FRESH_SHA, 'README.md', MAP_STORE_PRUNE_SIDECAR]);
  assert.equal(
    treePayload.tree.find((entry) => entry.path === FRESH_SHA).sha,
    'fresh-tree',
    'retained bundles are referenced by their existing tree SHAs — no content re-upload',
  );

  const [commitPayload] = fake.state.createdCommits;
  assert.deepEqual(commitPayload.parents, [], 'the compaction commit is an orphan — history is squashed');
  assert.deepEqual(fake.state.refUpdates, [{ sha: 'compaction-commit-sha', force: true }]);

  const sidecar = JSON.parse(fake.state.createdBlobs[0]);
  assert.equal(sidecar.version, 1);
  assert.deepEqual(Object.keys(sidecar.lastPublishedEpochSecondsByBundle), [FRESH_SHA]);
  assert.equal(sidecar.lastPublishedEpochSecondsByBundle[FRESH_SHA], NOW - 1 * DAY_IN_SECONDS);
});

test('sidecar dates survive a squash and keep previously retained bundles alive', async () => {
  // After a squash the log holds only the compaction commit; the sidecar is
  // the sole reason the retained bundle is still dated (and not pruned as
  // legacy-undated) on the next run.
  const sidecarContent = JSON.stringify({
    version: 1,
    prunedAt: 'earlier',
    lastPublishedEpochSecondsByBundle: { [FRESH_SHA]: NOW - 2 * DAY_IN_SECONDS },
  });
  const fake = buildFakeGitHub({
    rootTreeEntries: [
      { path: FRESH_SHA, type: 'tree', mode: '040000', sha: 'fresh-tree' },
      { path: LEGACY_SHA, type: 'tree', mode: '040000', sha: 'legacy-tree' },
      { path: 'README.md', type: 'blob', mode: '100644', sha: 'readme-blob' },
      { path: MAP_STORE_PRUNE_SIDECAR, type: 'blob', mode: '100644', sha: 'sidecar-blob' },
    ],
    blobContentsBySha: { 'sidecar-blob': sidecarContent },
    commitPages: [
      [
        {
          commit: {
            message: 'StyleProof map store compaction: 1 bundles retained, 2 pruned',
            committer: { date: new Date(NOW * 1000).toISOString() },
          },
        },
      ],
    ],
  });
  const result = await compactMapStoreBranch({ ...apiOptions, fetchImplementation: fake.fetchImplementation });
  assert.equal(result.compacted, true);
  assert.deepEqual(result.retainedDirectoryNames, [FRESH_SHA]);
  assert.deepEqual(result.prunedDirectoryNames, [LEGACY_SHA]);
});

test('a log date newer than the sidecar wins', async () => {
  const sidecarContent = JSON.stringify({
    version: 1,
    prunedAt: 'earlier',
    lastPublishedEpochSecondsByBundle: { [FRESH_SHA]: NOW - 40 * DAY_IN_SECONDS },
  });
  const fake = buildFakeGitHub({
    rootTreeEntries: [
      { path: FRESH_SHA, type: 'tree', mode: '040000', sha: 'fresh-tree' },
      { path: LEGACY_SHA, type: 'tree', mode: '040000', sha: 'legacy-tree' },
      { path: 'README.md', type: 'blob', mode: '100644', sha: 'readme-blob' },
      { path: MAP_STORE_PRUNE_SIDECAR, type: 'blob', mode: '100644', sha: 'sidecar-blob' },
    ],
    blobContentsBySha: { 'sidecar-blob': sidecarContent },
    commitPages: [[publishCommit(FRESH_SHA.slice(0, 12), 1)]],
  });
  const result = await compactMapStoreBranch({ ...apiOptions, fetchImplementation: fake.fetchImplementation });
  assert.deepEqual(result.retainedDirectoryNames, [FRESH_SHA]);
});

test('a quiet, already-compact branch is left alone — no daily force-push for nothing', async () => {
  const fake = buildFakeGitHub({
    rootTreeEntries: [
      { path: FRESH_SHA, type: 'tree', mode: '040000', sha: 'fresh-tree' },
      { path: 'README.md', type: 'blob', mode: '100644', sha: 'readme-blob' },
    ],
    commitPages: [[publishCommit(FRESH_SHA.slice(0, 12), 1)]],
  });
  const result = await compactMapStoreBranch({ ...apiOptions, fetchImplementation: fake.fetchImplementation });
  assert.equal(result.compacted, false);
  assert.deepEqual(fake.state.refUpdates, []);
});

test('long history alone triggers compaction even with nothing to prune', async () => {
  const manyCommits = Array.from({ length: 100 }, () => publishCommit(FRESH_SHA.slice(0, 12), 1));
  const fake = buildFakeGitHub({
    rootTreeEntries: [
      { path: FRESH_SHA, type: 'tree', mode: '040000', sha: 'fresh-tree' },
      { path: 'README.md', type: 'blob', mode: '100644', sha: 'readme-blob' },
    ],
    commitPages: [manyCommits, []],
  });
  const result = await compactMapStoreBranch({ ...apiOptions, fetchImplementation: fake.fetchImplementation });
  assert.equal(result.compacted, true);
  assert.deepEqual(result.retainedDirectoryNames, [FRESH_SHA]);
  assert.deepEqual(result.prunedDirectoryNames, []);
});

test('a missing branch is a clean no-op', async () => {
  const fake = buildFakeGitHub({ branchTip: null });
  const result = await compactMapStoreBranch({ ...apiOptions, fetchImplementation: fake.fetchImplementation });
  assert.equal(result.compacted, false);
  assert.deepEqual(fake.state.refUpdates, []);
});

test('transient server faults are retried', async () => {
  const fake = buildFakeGitHub({
    rootTreeEntries: [
      { path: FRESH_SHA, type: 'tree', mode: '040000', sha: 'fresh-tree' },
      { path: LEGACY_SHA, type: 'tree', mode: '040000', sha: 'legacy-tree' },
      { path: 'README.md', type: 'blob', mode: '100644', sha: 'readme-blob' },
    ],
    commitPages: [[publishCommit(FRESH_SHA.slice(0, 12), 1)]],
    serverFailuresBeforeSuccess: 2,
  });
  const result = await compactMapStoreBranch({ ...apiOptions, fetchImplementation: fake.fetchImplementation });
  assert.equal(result.compacted, true);
  assert.deepEqual(result.prunedDirectoryNames, [LEGACY_SHA]);
});

test('foreign root entries (deployment guards) survive the squash untouched', async () => {
  // Consumers park operational files on the artifact branch — e.g. a nested
  // hud/vercel.json suppressing preview deployments. The squash owns only the
  // bundle directories, README, and its own sidecar; everything else must ride
  // across by its existing SHA.
  const fake = buildFakeGitHub({
    rootTreeEntries: [
      { path: FRESH_SHA, type: 'tree', mode: '040000', sha: 'fresh-tree' },
      { path: LEGACY_SHA, type: 'tree', mode: '040000', sha: 'legacy-tree' },
      { path: 'hud', type: 'tree', mode: '040000', sha: 'guard-tree' },
      { path: '.vercelignore', type: 'blob', mode: '100644', sha: 'ignore-blob' },
      { path: 'README.md', type: 'blob', mode: '100644', sha: 'readme-blob' },
    ],
    commitPages: [[publishCommit(FRESH_SHA.slice(0, 12), 1)]],
  });
  const result = await compactMapStoreBranch({ ...apiOptions, fetchImplementation: fake.fetchImplementation });
  assert.equal(result.compacted, true);
  const [treePayload] = fake.state.createdTrees;
  const entryByPath = new Map(treePayload.tree.map((entry) => [entry.path, entry]));
  assert.equal(entryByPath.get('hud').sha, 'guard-tree', 'a non-bundle tree survives by its existing SHA');
  assert.equal(entryByPath.get('.vercelignore').sha, 'ignore-blob', 'a non-bundle blob survives by its existing SHA');
  assert.equal(entryByPath.has(LEGACY_SHA), false, 'pruned bundles are still dropped');
});

test('a malformed sidecar degrades to undated — prunes more, never resurrects', async () => {
  const fake = buildFakeGitHub({
    rootTreeEntries: [
      { path: FRESH_SHA, type: 'tree', mode: '040000', sha: 'fresh-tree' },
      { path: LEGACY_SHA, type: 'tree', mode: '040000', sha: 'legacy-tree' },
      { path: 'README.md', type: 'blob', mode: '100644', sha: 'readme-blob' },
      { path: MAP_STORE_PRUNE_SIDECAR, type: 'blob', mode: '100644', sha: 'sidecar-blob' },
    ],
    blobContentsBySha: { 'sidecar-blob': 'not json at all' },
    commitPages: [[publishCommit(FRESH_SHA.slice(0, 12), 1)]],
  });
  const result = await compactMapStoreBranch({ ...apiOptions, fetchImplementation: fake.fetchImplementation });
  assert.equal(result.compacted, true);
  assert.deepEqual(result.retainedDirectoryNames, [FRESH_SHA]);
  assert.deepEqual(result.prunedDirectoryNames, [LEGACY_SHA]);
});
