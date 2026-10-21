import assert from 'node:assert/strict';
import test from 'node:test';
import { deleteReportFolders, readReportFolderTimestamps, selectReportFoldersToPrune } from '../dist/report-prune.js';

const DAY_IN_SECONDS = 86400;
const NOW = 1_800_000_000;

function selection({
  folders,
  closedDaysAgo = {},
  publishedDaysAgo = {},
  openPaths = [],
  retentionDays = 14,
  budgetBytes,
}) {
  return selectReportFoldersToPrune({
    folderSizesBytesByPath: new Map(Object.entries(folders)),
    openPullRequestPaths: new Set(openPaths),
    prunableAtEpochSecondsByPath: new Map(
      Object.entries({ ...closedDaysAgo, ...publishedDaysAgo }).map(([folderPath, daysAgo]) => [
        folderPath,
        NOW - daysAgo * DAY_IN_SECONDS,
      ]),
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
  openPullRequests = [],
  pullsByNumber = {},
  listFailures = {},
  commits = [],
  commitFailure,
} = {}) {
  const state = { createdTrees: [], createdCommits: [], refUpdates: 0, pullsPagesServed: 0, requests: [] };
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
    state.requests.push(`${method} ${apiPath}`);
    if (method === 'GET' && apiPath.startsWith('/pulls?')) {
      state.pullsPagesServed += 1;
      const query = new URLSearchParams(apiPath.split('?')[1]);
      const listState = query.get('state');
      if (listFailures[listState]) return respond(listFailures[listState], { message: 'listing failed' });
      const pulls = listState === 'open' ? openPullRequests : closedPullRequests;
      const offset = (Number(query.get('page')) - 1) * 100;
      return respond(200, pulls.slice(offset, offset + 100));
    }
    if (method === 'GET' && apiPath.startsWith('/pulls/')) {
      const pull = pullsByNumber[apiPath.slice('/pulls/'.length)];
      return typeof pull === 'object' ? respond(200, pull) : respond(pull ?? 404, { message: 'pull lookup failed' });
    }
    if (method === 'GET' && apiPath.startsWith('/commits?')) {
      if (commitFailure) return respond(commitFailure, { message: 'commit listing failed' });
      const query = new URLSearchParams(apiPath.split('?')[1]);
      const offset = (Number(query.get('page')) - 1) * 100;
      return respond(200, commits.slice(offset, offset + 100));
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

function publishCommit(folder, daysAgo, overrides = {}) {
  return {
    commit: {
      message: `StyleProof report ${folder} @ ${'a'.repeat(40)}`,
      committer: { date: new Date((NOW - daysAgo * DAY_IN_SECONDS) * 1000).toISOString() },
      ...overrides,
    },
  };
}

async function sweep(
  fake,
  {
    budgetBytes = 1_000,
    retentionDays = 14,
    maximumCommitPages,
    maximumAttempts = 1,
    sleepImplementation = apiOptions.sleepImplementation,
  } = {},
) {
  let selection;
  const options = {
    ...apiOptions,
    maximumAttempts,
    sleepImplementation,
    fetchImplementation: fake.fetchImplementation,
  };
  const result = await deleteReportFolders({
    ...options,
    selectFolders: async (folderSizesBytesByPath) => {
      const timestamps = await readReportFolderTimestamps({ ...options, maximumCommitPages }, [
        ...folderSizesBytesByPath.keys(),
      ]);
      selection = selectReportFoldersToPrune({
        folderSizesBytesByPath,
        ...timestamps,
        retentionCutoffEpochSeconds: NOW - retentionDays * DAY_IN_SECONDS,
        budgetBytes,
      });
      return selection.foldersToDelete;
    },
    commitMessage: (count) => `prune ${count}`,
  });
  return { ...result, ...selection };
}

function reportTree(folders) {
  return Object.entries(folders).map(([folder, size]) => ({ path: `${folder}/report.md`, type: 'blob', size }));
}

function closedPull(number, daysAgo) {
  return { number, closed_at: new Date((NOW - daysAgo * DAY_IN_SECONDS) * 1000).toISOString() };
}

test('noncanonical report folders are never sized, looked up, or deleted even over budget', async () => {
  const fake = buildFakeGitHub({
    recursiveTreeEntries: reportTree({ 'pr-007': 1_000, 'run-0': 1_000, 'pr-7': 100, 'run-8': 10 }),
    closedPullRequests: [closedPull(7, 90)],
    pullsByNumber: { 7: closedPull(7, 90), '007': closedPull(7, 90) },
    commits: [publishCommit('pr-007', 90), publishCommit('run-0', 90), publishCommit('run-8', 1)],
  });
  const timestamps = await readReportFolderTimestamps(
    { ...apiOptions, fetchImplementation: fake.fetchImplementation },
    ['pr-007', 'run-0'],
  );
  assert.deepEqual([...timestamps.prunableAtEpochSecondsByPath], []);
  const result = await sweep(fake, { budgetBytes: 10 });
  assert.deepEqual(result.deletedFolders, ['pr-7']);
  assert.equal(result.branchSizeAfterBytes, 10);
  assert.deepEqual(fake.state.createdTrees[0].tree, [{ path: 'pr-7', mode: '040000', type: 'tree', sha: null }]);
  assert.ok(!fake.state.requests.some((request) => request.startsWith('GET /pulls/')));
});

test('issue #878: legacy run reports no longer remain forever over budget', async () => {
  const fake = buildFakeGitHub({
    recursiveTreeEntries: reportTree({
      'pr-12': 300_000_000,
      'pr-17198732451': 900_000_000,
      'pr-17198999999': 900_000_000,
    }),
    closedPullRequests: [closedPull(12, 90)],
    commits: [publishCommit('pr-17198999999', 1), publishCommit('pr-17198732451', 2)],
  });
  const result = await sweep(fake, { budgetBytes: 1_000_000_000, retentionDays: 30 });
  assert.deepEqual(result.deletedFolders, ['pr-12', 'pr-17198732451']);
  assert.equal(result.branchSizeAfterBytes, 900_000_000);
  assert.equal(result.openFoldersExceedBudget, false);
  assert.ok(fake.state.requests.includes('GET /pulls/17198732451'));
  assert.ok(fake.state.requests.includes('GET /pulls/17198999999'));
});

test('run reports expire by last publish time; the latest committer date wins', async () => {
  const fake = buildFakeGitHub({
    recursiveTreeEntries: reportTree({ 'run-1': 10, 'run-2': 10, 'run-3': 10 }),
    commits: [
      publishCommit('run-1', 30),
      publishCommit('run-2', 40),
      publishCommit('run-2', 1),
      publishCommit('run-3', 14),
    ],
  });
  const result = await sweep(fake);
  assert.deepEqual(result.deletedFolders, ['run-1', 'run-3']);
  assert.equal(result.branchSizeAfterBytes, 10);
});

test('budget uses one oldest-first order for run, legacy run, and closed PR reports', async () => {
  const fake = buildFakeGitHub({
    recursiveTreeEntries: reportTree({ 'run-1': 100, 'pr-2': 100, 'pr-300': 100, 'run-4': 100, 'pr-5': 100 }),
    closedPullRequests: [closedPull(2, 4), closedPull(5, 1)],
    commits: [publishCommit('run-1', 5), publishCommit('pr-300', 3), publishCommit('run-4', 2)],
  });
  const result = await sweep(fake, { budgetBytes: 200 });
  assert.deepEqual(result.deletedFolders, ['run-1', 'pr-2', 'pr-300']);
  assert.equal(result.branchSizeAfterBytes, 200);
});

test('an open PR older than every other folder is protected by retention and budget, even if also listed closed', async () => {
  const fake = buildFakeGitHub({
    recursiveTreeEntries: reportTree({ 'pr-1': 900, 'run-2': 100, 'pr-3': 100 }),
    openPullRequests: [{ number: 1, closed_at: null }],
    closedPullRequests: [closedPull(1, 90), closedPull(3, 1)],
    commits: [publishCommit('pr-1', 100), publishCommit('run-2', 2)],
  });
  const result = await sweep(fake, { budgetBytes: 100 });
  assert.deepEqual(result.deletedFolders, ['run-2', 'pr-3']);
  assert.equal(result.branchSizeAfterBytes, 900);
  assert.equal(result.openFoldersExceedBudget, true);
  assert.ok(!fake.state.requests.includes('GET /pulls/1'));
});

test('a sweep re-reads PR lists on retry and preserves a reopened PR', async () => {
  const closedPullRequests = [closedPull(50, 90)];
  const openPullRequests = [];
  const fake = buildFakeGitHub({
    recursiveTreeEntries: reportTree({ 'pr-50': 900, 'run-1': 100 }),
    closedPullRequests,
    openPullRequests,
    commits: [publishCommit('run-1', 30)],
    refUpdateFailuresBeforeSuccess: 1,
  });
  const result = await sweep(fake, {
    budgetBytes: 100,
    maximumAttempts: 2,
    sleepImplementation: async () => {
      closedPullRequests.length = 0;
      openPullRequests.push({ number: 50, closed_at: null });
    },
  });
  assert.deepEqual(
    fake.state.createdTrees[0].tree.map((entry) => entry.path),
    ['pr-50', 'run-1'],
  );
  assert.equal(fake.state.refUpdates, 2);
  assert.deepEqual(result.deletedFolders, ['run-1']);
  assert.deepEqual(fake.state.createdTrees[1].tree, [{ path: 'run-1', mode: '040000', type: 'tree', sha: null }]);
  assert.equal(result.branchSizeAfterBytes, 900);
  for (const state of ['open', 'closed']) {
    assert.equal(fake.state.requests.filter((request) => request.startsWith(`GET /pulls?state=${state}&`)).length, 2);
  }
});

test('pure selection protects an explicitly open folder even when it has the oldest timestamp', () => {
  const result = selection({
    folders: { 'pr-1': 900, 'run-2': 10 },
    closedDaysAgo: { 'pr-1': 100 },
    publishedDaysAgo: { 'run-2': 1 },
    openPaths: ['pr-1'],
    budgetBytes: 100,
  });
  assert.deepEqual(result.foldersToDelete, ['run-2']);
});

for (const state of ['open', 'closed']) {
  test(`a failed ${state} listing aborts without any deletions`, async () => {
    const fake = buildFakeGitHub({
      recursiveTreeEntries: reportTree({ 'pr-1': 100, 'run-2': 100 }),
      closedPullRequests: [closedPull(1, 90)],
      listFailures: { [state]: 503 },
      commits: [publishCommit('run-2', 90)],
    });
    await assert.rejects(sweep(fake, { budgetBytes: 0 }), new RegExp(`state=${state}.*503`));
    assert.deepEqual(fake.state.createdTrees, []);
    assert.deepEqual(fake.state.createdCommits, []);
    assert.equal(fake.state.refUpdates, 0);
  });
}

test('both PR lists are paginated before unknown numbers are checked', async () => {
  const fake = buildFakeGitHub({
    recursiveTreeEntries: reportTree({ 'pr-101': 900, 'pr-301': 100, 'pr-999': 100 }),
    openPullRequests: Array.from({ length: 101 }, (_, index) => ({ number: index + 1, closed_at: null })),
    closedPullRequests: Array.from({ length: 101 }, (_, index) => closedPull(index + 201, 90)),
    commits: [publishCommit('pr-999', 90)],
  });
  const result = await sweep(fake, { budgetBytes: 0 });
  assert.deepEqual(result.deletedFolders, ['pr-301', 'pr-999']);
  assert.equal(fake.state.pullsPagesServed, 4);
  assert.ok(!fake.state.requests.includes('GET /pulls/101'));
  assert.ok(!fake.state.requests.includes('GET /pulls/301'));
  assert.ok(fake.state.requests.includes('GET /pulls/999'));
});

test('a PR opened after the lists were read is kept when its individual lookup returns open', async () => {
  const fake = buildFakeGitHub({
    recursiveTreeEntries: reportTree({ 'pr-7': 100 }),
    pullsByNumber: { 7: { number: 7, closed_at: null } },
    commits: [publishCommit('pr-7', 90)],
  });
  const result = await sweep(fake, { budgetBytes: 0 });
  assert.deepEqual(result.deletedFolders, []);
  assert.equal(result.openFoldersExceedBudget, true);
  assert.deepEqual(result.undatedFolders, []);
});

test('an individual lookup returning a closed PR uses closed_at instead of publish time', async () => {
  const fake = buildFakeGitHub({
    recursiveTreeEntries: reportTree({ 'pr-7': 100 }),
    pullsByNumber: { 7: closedPull(7, 90) },
    commits: [publishCommit('pr-7', 1)],
  });
  assert.deepEqual((await sweep(fake)).deletedFolders, ['pr-7']);
});

for (const status of [403, 500]) {
  test(`an uncertain individual PR lookup (${status}) aborts without deletions`, async () => {
    const fake = buildFakeGitHub({
      recursiveTreeEntries: reportTree({ 'pr-7': 100, 'run-2': 100 }),
      pullsByNumber: { 7: status },
      commits: [publishCommit('pr-7', 90), publishCommit('run-2', 90)],
    });
    await assert.rejects(sweep(fake, { budgetBytes: 0 }), new RegExp(`/pulls/7.*${status}`));
    assert.deepEqual(fake.state.createdTrees, []);
    assert.equal(fake.state.refUpdates, 0);
  });
}

test('undated run and legacy reports are kept even when every dated report is deleted', async () => {
  const fake = buildFakeGitHub({
    recursiveTreeEntries: reportTree({ 'run-1': 100, 'pr-999': 100, 'run-3': 100 }),
    commits: [publishCommit('run-3', 1)],
  });
  const result = await sweep(fake, { budgetBytes: 0 });
  assert.deepEqual(result.deletedFolders, ['run-3']);
  assert.deepEqual(result.undatedFolders, ['run-1', 'pr-999']);
  assert.equal(result.openFoldersExceedBudget, true);
});

test('invalid dates and unrelated commit subjects do not establish a run report age', async () => {
  const fake = buildFakeGitHub({
    recursiveTreeEntries: reportTree({ 'run-1': 100, 'run-2': 100, 'run-3': 100, 'pr-4': 100 }),
    closedPullRequests: [{ number: 4, closed_at: 'invalid' }],
    commits: [
      publishCommit('run-1', 90, { committer: { date: 'invalid' } }),
      publishCommit('run-2', 90, { committer: null }),
      publishCommit('run-1', 100),
      publishCommit('run-2', 100),
      publishCommit('run-3', 90, { message: 'unrelated commit' }),
      publishCommit('pr-4', 90),
    ],
  });
  const result = await sweep(fake, { budgetBytes: 0 });
  assert.deepEqual(result.deletedFolders, []);
  assert.deepEqual(result.undatedFolders, ['run-1', 'run-2', 'run-3', 'pr-4']);
});

test('commit dates are paginated and folders beyond the scan bound stay undated', async () => {
  const commits = [...Array.from({ length: 100 }, () => publishCommit('run-1', 1)), publishCommit('run-2', 90)];
  for (const maximumCommitPages of [1, 2]) {
    const fake = buildFakeGitHub({ recursiveTreeEntries: reportTree({ 'run-1': 10, 'run-2': 10 }), commits });
    const result = await sweep(fake, { maximumCommitPages });
    assert.deepEqual(result.deletedFolders, maximumCommitPages === 1 ? [] : ['run-2']);
    assert.deepEqual(result.undatedFolders, maximumCommitPages === 1 ? ['run-2'] : []);
    assert.equal(fake.state.requests.filter((request) => request.includes('/commits?')).length, maximumCommitPages);
  }
});

test('a failed commit listing aborts without deletions', async () => {
  const fake = buildFakeGitHub({
    recursiveTreeEntries: reportTree({ 'run-1': 100 }),
    commitFailure: 503,
  });
  await assert.rejects(sweep(fake), /commit listing failed/);
  assert.deepEqual(fake.state.createdTrees, []);
});
