import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deleteReportFolders,
  readClosedPullRequestTimestamps,
  selectReportFoldersToPrune,
} from '../dist/report-prune.js';

const DAY_IN_SECONDS = 86400;
const NOW = 1_800_000_000;

function selection({ folders, closedDaysAgo, retentionDays = 14, budgetBytes }) {
  return selectReportFoldersToPrune({
    folderSizesBytesByPath: new Map(Object.entries(folders)),
    closedAtEpochSecondsByPath: new Map(
      Object.entries(closedDaysAgo).map(([folderPath, daysAgo]) => [folderPath, NOW - daysAgo * DAY_IN_SECONDS]),
    ),
    retentionCutoffEpochSeconds: NOW - retentionDays * DAY_IN_SECONDS,
    budgetBytes,
  });
}

test('retention deletes reports closed outside the window and keeps recent ones', () => {
  const result = selection({
    folders: { 'pr-1': 10, 'pr-2': 10, 'pr-3': 10 },
    closedDaysAgo: { 'pr-1': 40, 'pr-2': 30, 'pr-3': 1 },
    budgetBytes: 1_000,
  });
  assert.deepEqual(result.foldersToDelete.sort(), ['pr-1', 'pr-2']);
  assert.equal(result.openFoldersExceedBudget, false);
});

test('an over-budget branch keeps pruning inside the window, oldest-closed first', () => {
  // The regression this design exists for: every folder is inside the
  // retention window, so retention alone deletes nothing, yet the branch is
  // far over budget. The sweep must keep deleting oldest-closed first and the
  // newest reports must survive.
  const result = selection({
    folders: { 'pr-483': 435, 'pr-761': 363, 'pr-473': 342, 'pr-999': 50 },
    closedDaysAgo: { 'pr-483': 9, 'pr-761': 1, 'pr-473': 13, 'pr-999': 2 },
    budgetBytes: 800,
  });
  assert.deepEqual(result.foldersToDelete, ['pr-473', 'pr-483']);
  assert.equal(result.branchSizeAfterBytes, 363 + 50);
});

test('reports for open pull requests are never selected, even over budget', () => {
  const result = selection({
    folders: { 'pr-900': 900, 'pr-901': 900, 'pr-1': 10 },
    closedDaysAgo: { 'pr-1': 40 },
    budgetBytes: 100,
  });
  assert.deepEqual(result.foldersToDelete, ['pr-1']);
  assert.equal(result.openFoldersExceedBudget, true);
});

test('a branch already under budget prunes by retention only', () => {
  const result = selection({
    folders: { 'pr-1': 10, 'pr-2': 10 },
    closedDaysAgo: { 'pr-1': 5, 'pr-2': 6 },
    budgetBytes: 1_000,
  });
  assert.deepEqual(result.foldersToDelete, []);
});

/** Git-data API double for the deletion path. */
function buildFakeGitHub({
  branchTip = 'tip-sha',
  recursiveTreeEntries = [],
  recursiveTreeTruncated = false,
  refUpdateFailuresBeforeSuccess = 0,
  closedPullRequests = [],
} = {}) {
  const state = { createdTrees: [], createdCommits: [], refUpdates: 0, pullsPagesServed: 0 };
  let remainingRefUpdateFailures = refUpdateFailuresBeforeSuccess;
  const fetchImplementation = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const apiPath = String(url).replace('https://api.example/repos/acme/widgets', '');
    const respond = (status, body) => ({
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    if (method === 'GET' && apiPath.startsWith('/pulls')) {
      state.pullsPagesServed += 1;
      return respond(200, closedPullRequests);
    }
    if (method === 'GET' && apiPath.startsWith('/git/ref/')) {
      if (branchTip === null) return respond(404, { message: 'Not Found' });
      return respond(200, { object: { sha: branchTip } });
    }
    if (method === 'GET' && apiPath.startsWith('/git/commits/')) {
      return respond(200, { tree: { sha: 'tip-tree-sha' } });
    }
    if (method === 'GET' && apiPath.startsWith('/git/trees/')) {
      return respond(200, { tree: recursiveTreeEntries, truncated: recursiveTreeTruncated });
    }
    if (method === 'POST' && apiPath === '/git/trees') {
      state.createdTrees.push(JSON.parse(options.body));
      return respond(201, { sha: 'pruned-tree-sha' });
    }
    if (method === 'POST' && apiPath === '/git/commits') {
      state.createdCommits.push(JSON.parse(options.body));
      return respond(201, { sha: 'pruned-commit-sha' });
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

const apiOptions = {
  apiBaseUrl: 'https://api.example',
  repository: 'acme/widgets',
  token: 'test-token',
  branch: 'styleproof-reports',
  sleepImplementation: async () => {},
  log: () => {},
};

test('deletes folders as subtree removals in one commit on the current tip', async () => {
  const fake = buildFakeGitHub({
    recursiveTreeEntries: [
      { path: 'pr-7/report.md', type: 'blob', size: 10 },
      { path: 'pr-8/report.md', type: 'blob', size: 10 },
      { path: 'README.md', type: 'blob', size: 1 },
    ],
  });
  const result = await deleteReportFolders({
    ...apiOptions,
    fetchImplementation: fake.fetchImplementation,
    selectFolders: () => ['pr-7'],
    commitMessage: (count) => `prune ${count}`,
  });
  assert.deepEqual(result.deletedFolders, ['pr-7']);
  const [treePayload] = fake.state.createdTrees;
  assert.equal(treePayload.base_tree, 'tip-tree-sha');
  assert.deepEqual(treePayload.tree, [{ path: 'pr-7', mode: '040000', type: 'tree', sha: null }]);
  assert.deepEqual(fake.state.createdCommits[0].parents, ['tip-sha']);
});

test('requesting a folder that is not on the branch is a clean no-op', async () => {
  const fake = buildFakeGitHub({
    recursiveTreeEntries: [{ path: 'pr-8/report.md', type: 'blob', size: 10 }],
  });
  const result = await deleteReportFolders({
    ...apiOptions,
    fetchImplementation: fake.fetchImplementation,
    selectFolders: () => ['pr-7'],
    commitMessage: (count) => `prune ${count}`,
  });
  assert.deepEqual(result.deletedFolders, []);
  assert.deepEqual(fake.state.createdTrees, []);
});

test('a missing branch is a clean no-op', async () => {
  const fake = buildFakeGitHub({ branchTip: null });
  const result = await deleteReportFolders({
    ...apiOptions,
    fetchImplementation: fake.fetchImplementation,
    selectFolders: () => ['pr-7'],
    commitMessage: (count) => `prune ${count}`,
  });
  assert.deepEqual(result.deletedFolders, []);
});

test('a lost ref race re-reads the tip, re-selects, and retries', async () => {
  const fake = buildFakeGitHub({
    recursiveTreeEntries: [{ path: 'pr-7/report.md', type: 'blob', size: 10 }],
    refUpdateFailuresBeforeSuccess: 2,
  });
  const selections = [];
  const result = await deleteReportFolders({
    ...apiOptions,
    fetchImplementation: fake.fetchImplementation,
    selectFolders: (folderSizesBytesByPath) => {
      selections.push([...folderSizesBytesByPath.keys()]);
      return ['pr-7'];
    },
    commitMessage: (count) => `prune ${count}`,
  });
  assert.deepEqual(result.deletedFolders, ['pr-7']);
  assert.equal(fake.state.refUpdates, 3);
  assert.equal(selections.length, 3, 'each retry re-reads and re-selects');
});

test('a truncated tree listing refuses to prune instead of guessing', async () => {
  const fake = buildFakeGitHub({
    recursiveTreeEntries: [{ path: 'pr-7/report.md', type: 'blob', size: 10 }],
    recursiveTreeTruncated: true,
  });
  await assert.rejects(
    deleteReportFolders({
      ...apiOptions,
      maximumAttempts: 1,
      fetchImplementation: fake.fetchImplementation,
      selectFolders: () => ['pr-7'],
      commitMessage: (count) => `prune ${count}`,
    }),
    /truncated/,
  );
});

test('closed pull request timestamps are keyed pr-<n> and skip open PRs', async () => {
  const fake = buildFakeGitHub({
    closedPullRequests: [
      { number: 7, closed_at: '2026-01-02T03:04:05Z' },
      { number: 9, closed_at: null },
    ],
  });
  const closedAtEpochSecondsByPath = await readClosedPullRequestTimestamps({
    ...apiOptions,
    fetchImplementation: fake.fetchImplementation,
  });
  assert.deepEqual(
    [...closedAtEpochSecondsByPath.entries()],
    [['pr-7', Math.floor(Date.parse('2026-01-02T03:04:05Z') / 1000)]],
  );
});
