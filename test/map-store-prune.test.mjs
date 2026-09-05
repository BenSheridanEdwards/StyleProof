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
  racingPublication,
  graphqlResponse,
  graphqlStatus = 200,
  apiBaseUrl = 'https://api.example',
} = {}) {
  const state = { createdTrees: [], createdCommits: [], createdBlobs: [], refUpdates: [], branchTip, rootTreeEntries };
  let remainingServerFailures = serverFailuresBeforeSuccess;
  const fetchImplementation = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const apiPath = String(url).replace(`${apiBaseUrl}/repos/acme/widgets`, '');
    const respond = (status, body) => ({
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    if (method === 'GET' && apiPath === '') return respond(200, { node_id: 'repository-id' });
    const graphqlUrl = apiBaseUrl.endsWith('/api/v3')
      ? apiBaseUrl.replace(/\/api\/v3$/, '/api/graphql')
      : `${apiBaseUrl}/graphql`;
    if (method === 'POST' && String(url) === graphqlUrl) {
      if (graphqlResponse) return respond(graphqlStatus, graphqlResponse);
      const { variables } = JSON.parse(options.body);
      const update = variables.input.refUpdates[0];
      if (update.beforeOid !== state.branchTip) {
        return respond(200, { errors: [{ message: 'reference does not match beforeOid', type: 'UNPROCESSABLE' }] });
      }
      state.refUpdates.push(update);
      state.branchTip = update.afterOid;
      return respond(200, { data: { updateRefs: { clientMutationId: variables.input.clientMutationId } } });
    }
    if (remainingServerFailures > 0) {
      remainingServerFailures -= 1;
      return respond(500, { message: 'flake' });
    }
    if (method === 'GET' && apiPath.startsWith('/git/ref/')) {
      if (state.branchTip === null) return respond(404, { message: 'Not Found' });
      return respond(200, { object: { sha: state.branchTip } });
    }
    if (method === 'GET' && apiPath.startsWith('/git/commits/')) {
      return respond(200, { tree: { sha: 'tip-tree-sha' } });
    }
    if (method === 'GET' && apiPath.startsWith('/git/trees/')) {
      return respond(200, { tree: state.rootTreeEntries });
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
      if (racingPublication && state.createdCommits.length === 1) {
        state.branchTip = 'published-tip-sha';
        state.rootTreeEntries = [...state.rootTreeEntries, racingPublication];
        commitPages = [[publishCommit(racingPublication.path.slice(0, 12), 0), ...commitPages[0]]];
      }
      return respond(201, { sha: 'compaction-commit-sha' });
    }
    if (method === 'PATCH' && apiPath.startsWith('/git/refs/')) {
      state.refUpdates.push(JSON.parse(options.body));
      state.branchTip = JSON.parse(options.body).sha;
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

test('a publication racing compaction survives the conditional ref update', async () => {
  const racingSha = 'dddddddddddd4444444444444444444444444444';
  const fake = buildFakeGitHub({
    rootTreeEntries: [{ path: LEGACY_SHA, type: 'tree', mode: '040000', sha: 'legacy-tree' }],
    racingPublication: { path: racingSha, type: 'tree', mode: '040000', sha: 'racing-tree' },
  });
  const result = await compactMapStoreBranch({ ...apiOptions, fetchImplementation: fake.fetchImplementation });
  assert.deepEqual(result.retainedDirectoryNames, [racingSha], 'the newly published capture must remain restorable');
  assert.equal(fake.state.createdCommits.length, 2, 'retry must recalculate retention from the new tip');
  assert.equal(fake.state.refUpdates.length, 1, 'the stale compaction must not update the ref');
  assert.equal(fake.state.refUpdates[0].beforeOid, 'published-tip-sha');
  assert.ok(fake.state.createdTrees.at(-1).tree.some((entry) => entry.sha === 'racing-tree'));
});

test('exhausted contention leaves the racing publication untouched', async () => {
  const fake = buildFakeGitHub({
    rootTreeEntries: [{ path: LEGACY_SHA, type: 'tree', mode: '040000', sha: 'legacy-tree' }],
    racingPublication: { path: FRESH_SHA, type: 'tree', mode: '040000', sha: 'fresh-tree' },
  });
  await assert.rejects(
    compactMapStoreBranch({ ...apiOptions, maximumAttempts: 1, fetchImplementation: fake.fetchImplementation }),
    /returned GraphQL errors/,
  );
  assert.equal(fake.state.branchTip, 'published-tip-sha');
  assert.deepEqual(fake.state.refUpdates, []);
});

for (const [name, response, status, attempts] of [
  ['GraphQL permission error', { errors: [{ message: 'Resource not accessible', type: 'FORBIDDEN' }] }, 200, 1],
  ['HTTP permission error', { message: 'Forbidden' }, 403, 1],
  ['missing acknowledgement', { data: { updateRefs: null } }, 200, 2],
  ['wrong acknowledgement', { data: { updateRefs: { clientMutationId: 'another-tip' } } }, 200, 2],
  ['malformed errors object', { data: { updateRefs: { clientMutationId: 'tip-sha' } }, errors: {} }, 200, 1],
  ['malformed errors string', { data: { updateRefs: { clientMutationId: 'tip-sha' } }, errors: 'none' }, 200, 1],
  [
    'partial GraphQL success',
    { data: { updateRefs: { clientMutationId: 'tip-sha' } }, errors: [{ message: 'failed' }] },
    200,
    1,
  ],
]) {
  test(`${name} cannot become a successful or unconditional compaction`, async () => {
    const fake = buildFakeGitHub({
      rootTreeEntries: [{ path: LEGACY_SHA, type: 'tree', mode: '040000', sha: 'legacy-tree' }],
      graphqlResponse: response,
      graphqlStatus: status,
    });
    await assert.rejects(
      compactMapStoreBranch({ ...apiOptions, maximumAttempts: 2, fetchImplementation: fake.fetchImplementation }),
      /updateRefs/,
    );
    assert.deepEqual(fake.state.refUpdates, []);
    assert.equal(fake.state.createdCommits.length, attempts);
    assert.equal(fake.state.branchTip, 'tip-sha');
  });
}

test('GraphQL provider details never enter errors or retry diagnostics', async () => {
  const providerDetail = 'secret-provider-diagnostic';
  const fake = buildFakeGitHub({
    rootTreeEntries: [{ path: LEGACY_SHA, type: 'tree', mode: '040000', sha: 'legacy-tree' }],
    graphqlResponse: { errors: [{ message: providerDetail }] },
  });
  const logs = [];
  let thrown;
  try {
    await compactMapStoreBranch({
      ...apiOptions,
      maximumAttempts: 2,
      fetchImplementation: fake.fetchImplementation,
      log: (line) => logs.push(line),
    });
  } catch (error) {
    thrown = error;
  }
  assert.match(String(thrown), /returned GraphQL errors/);
  assert.doesNotMatch(String(thrown), new RegExp(providerDetail));
  assert.doesNotMatch(logs.join('\n'), new RegExp(providerDetail));
});

test('retry diagnostics omit raw API response details', async () => {
  const fake = buildFakeGitHub({
    rootTreeEntries: [{ path: LEGACY_SHA, type: 'tree', mode: '040000', sha: 'legacy-tree' }],
    serverFailuresBeforeSuccess: 1,
  });
  const logs = [];
  await compactMapStoreBranch({
    ...apiOptions,
    fetchImplementation: fake.fetchImplementation,
    log: (line) => logs.push(line),
  });
  assert.match(logs[0], /failed \(HTTP 500\); retrying/);
  assert.doesNotMatch(logs[0], /flake/);
});

test('GitHub Enterprise compaction uses the same server API GraphQL endpoint', async () => {
  const apiBaseUrl = 'https://git.example/api/v3';
  const fake = buildFakeGitHub({
    apiBaseUrl,
    rootTreeEntries: [{ path: LEGACY_SHA, type: 'tree', mode: '040000', sha: 'legacy-tree' }],
  });
  const result = await compactMapStoreBranch({
    ...apiOptions,
    apiBaseUrl,
    fetchImplementation: fake.fetchImplementation,
  });
  assert.equal(result.compacted, true);
  assert.equal(fake.state.refUpdates[0].beforeOid, 'tip-sha');
});

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
  assert.deepEqual(fake.state.refUpdates, [
    { name: 'refs/heads/styleproof-maps', beforeOid: 'tip-sha', afterOid: 'compaction-commit-sha', force: true },
  ]);

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
