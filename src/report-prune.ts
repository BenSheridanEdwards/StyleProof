// Prune `pr-<n>/` and `run-<id>/` report folders through the GitHub git-data
// API: on PR close delete that PR's folder; on a schedule sweep by retention, then by
// a hard size budget (oldest first, open PRs and undated folders never touched). The budget is what
// bounds the branch — one PR can publish hundreds of megabytes of crops.

import {
  type GitHubApi,
  type GitHubApiOptions,
  GitHubApiError,
  advanceBranch,
  blobSizesByFolder,
  createCommit,
  createTree,
  deleteFolderEntry,
  githubClient,
  logLine,
  readBranchTipCommitSha,
  readCommitTreeSha,
  readTree,
  withRetries,
} from './github-git-data.js';

export type ReportFolderPruneSelection = {
  foldersToDelete: string[];
  /** Blob bytes that remain on the branch after the selected deletions. */
  branchSizeAfterBytes: number;
  /** Folders kept because their age could not be established. */
  undatedFolders: string[];
  /** True when open PR folders plus undated folders alone exceed the budget. */
  openFoldersExceedBudget: boolean;
};

/** Pure policy: retention first, then oldest first; open PRs and undated folders survive. */
export function selectReportFoldersToPrune(options: {
  folderSizesBytesByPath: Map<string, number>;
  prunableAtEpochSecondsByPath: ReadonlyMap<string, number>;
  openPullRequestPaths: ReadonlySet<string>;
  retentionCutoffEpochSeconds: number;
  budgetBytes: number;
}): ReportFolderPruneSelection {
  const dated = (folder: string) => Number.isFinite(options.prunableAtEpochSecondsByPath.get(folder));
  const ageTimestamp = (folder: string) => options.prunableAtEpochSecondsByPath.get(folder)!;
  const foldersToDelete: string[] = [];
  let branchSizeAfterBytes = [...options.folderSizesBytesByPath.values()].reduce((total, size) => total + size, 0);
  const remove = (folder: string) => {
    foldersToDelete.push(folder);
    branchSizeAfterBytes -= options.folderSizesBytesByPath.get(folder) ?? 0;
  };
  const oldestFirst = [...options.folderSizesBytesByPath.keys()]
    .filter((folder) => !options.openPullRequestPaths.has(folder) && dated(folder))
    .sort((a, b) => ageTimestamp(a) - ageTimestamp(b) || a.localeCompare(b));
  for (const folder of oldestFirst) if (ageTimestamp(folder) <= options.retentionCutoffEpochSeconds) remove(folder);
  for (const folder of oldestFirst) {
    if (branchSizeAfterBytes <= options.budgetBytes) break;
    if (!foldersToDelete.includes(folder)) remove(folder);
  }
  const undatedFolders = [...options.folderSizesBytesByPath.keys()].filter(
    (folder) => !options.openPullRequestPaths.has(folder) && !dated(folder),
  );
  return {
    foldersToDelete,
    branchSizeAfterBytes,
    undatedFolders,
    openFoldersExceedBudget: branchSizeAfterBytes > options.budgetBytes,
  };
}

export type ReportPruneApiOptions = GitHubApiOptions & { branch: string };

/** Tip + per-folder blob sizes; null before the first publish. A truncated listing throws:
 *  a partial size map could select the wrong folders to delete. */
async function readBranchFolders(api: GitHubApi, branch: string) {
  const tipCommitSha = await readBranchTipCommitSha(api, branch);
  if (tipCommitSha === null) return null;
  const tipTreeSha = await readCommitTreeSha(api, tipCommitSha);
  const { tree, truncated } = await readTree(api, tipTreeSha, true);
  if (truncated) {
    throw new Error(`the recursive tree listing for ${branch} is truncated — refusing to size-prune on partial data`);
  }
  return {
    tipCommitSha,
    tipTreeSha,
    folderSizesBytesByPath: blobSizesByFolder(tree, (folder) => /^(pr|run)-[1-9]\d*$/.test(folder)),
  };
}

/** Delete the selected top-level folders in one commit and fast-forward the ref;
 *  the whole read-select-delete cycle retries when the ref moves under us. */
export async function deleteReportFolders(
  options: ReportPruneApiOptions & {
    selectFolders: (folderSizesBytesByPath: Map<string, number>) => string[] | Promise<string[]>;
    commitMessage: (deletedFolderCount: number) => string;
  },
): Promise<{ deletedFolders: string[] }> {
  const api = githubClient(options);
  const log = logLine(options);
  return withRetries(options, 'report prune', async () => {
    const branchState = await readBranchFolders(api, options.branch);
    if (branchState === null) {
      log(`no ${options.branch} branch yet — nothing to prune`);
      return { deletedFolders: [] };
    }
    const requested = await options.selectFolders(branchState.folderSizesBytesByPath);
    const foldersToDelete = requested.filter((folder) => branchState.folderSizesBytesByPath.has(folder));
    if (foldersToDelete.length === 0) {
      log('no report folders need pruning');
      return { deletedFolders: [] };
    }
    const treeSha = await createTree(api, {
      base_tree: branchState.tipTreeSha,
      tree: foldersToDelete.map(deleteFolderEntry),
    });
    const commitSha = await createCommit(api, options.commitMessage(foldersToDelete.length), treeSha, [
      branchState.tipCommitSha,
    ]);
    await advanceBranch(api, options.branch, branchState.tipCommitSha, commitSha);
    return { deletedFolders: foldersToDelete };
  });
}

type PullRequest = { number: number; closed_at: string | null };

/** Both listings must complete before any folder can be classified as a legacy run. */
async function readPullRequests(api: GitHubApi, state: 'open' | 'closed'): Promise<PullRequest[]> {
  const result: PullRequest[] = [];
  for (let page = 1; ; page += 1) {
    const pulls = await api<PullRequest[]>('GET', `/pulls?state=${state}&per_page=100&page=${page}`);
    result.push(...pulls);
    if (pulls.length < 100) break;
  }
  return result;
}

async function readPullRequestStates(api: GitHubApi) {
  const openPullRequestPaths = new Set((await readPullRequests(api, 'open')).map((pull) => `pr-${pull.number}`));
  const closedPullRequests = new Map(
    (await readPullRequests(api, 'closed')).map((pull) => [`pr-${pull.number}`, pull]),
  );
  return { openPullRequestPaths, closedPullRequests };
}

async function classifyPullRequestFolder(
  api: GitHubApi,
  folder: string,
  closedPullRequests: ReadonlyMap<string, PullRequest>,
  openPullRequestPaths: Set<string>,
  prunableAtEpochSecondsByPath: Map<string, number>,
): Promise<boolean> {
  let pull = closedPullRequests.get(folder);
  if (!pull) {
    try {
      pull = await api<PullRequest>('GET', `/pulls/${folder.slice(3)}`);
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
      return true;
    }
  }
  if (pull.closed_at == null) openPullRequestPaths.add(folder);
  else {
    const epoch = Math.floor(Date.parse(pull.closed_at) / 1000);
    if (Number.isFinite(epoch)) prunableAtEpochSecondsByPath.set(folder, epoch);
  }
  return false;
}

async function classifyReportFolders(
  api: GitHubApi,
  folders: readonly string[],
  closedPullRequests: ReadonlyMap<string, PullRequest>,
  openPullRequestPaths: Set<string>,
  prunableAtEpochSecondsByPath: Map<string, number>,
): Promise<Set<string>> {
  const runFolders = new Set<string>();
  for (const folder of folders) {
    if (openPullRequestPaths.has(folder)) continue;
    if (/^run-[1-9]\d*$/.test(folder)) {
      runFolders.add(folder);
      continue;
    }
    if (!/^pr-[1-9]\d*$/.test(folder)) continue;
    if (
      await classifyPullRequestFolder(
        api,
        folder,
        closedPullRequests,
        openPullRequestPaths,
        prunableAtEpochSecondsByPath,
      )
    ) {
      runFolders.add(folder);
    }
  }
  return runFolders;
}

type ReportCommit = { commit: { message: string; committer: { date: string } | null } };

function recordRunFolderTimestamps(
  commits: readonly ReportCommit[],
  runFolders: ReadonlySet<string>,
  prunableAtEpochSecondsByPath: Map<string, number>,
  undatedRunFolders: Set<string>,
): void {
  for (const { commit } of commits) {
    const folder = /^StyleProof report ((?:pr|run)-\d+) @ \S+$/.exec(commit.message.split('\n')[0])?.[1];
    if (!folder || !runFolders.has(folder)) continue;
    const epoch = Math.floor(Date.parse(commit.committer?.date ?? '') / 1000);
    if (!Number.isFinite(epoch)) undatedRunFolders.add(folder);
    else if (epoch > (prunableAtEpochSecondsByPath.get(folder) ?? -Infinity)) {
      prunableAtEpochSecondsByPath.set(folder, epoch);
    }
  }
}

async function dateRunFolders(
  api: GitHubApi,
  options: ReportPruneApiOptions & { maximumCommitPages?: number },
  runFolders: ReadonlySet<string>,
  prunableAtEpochSecondsByPath: Map<string, number>,
): Promise<void> {
  if (runFolders.size === 0) return;
  const undatedRunFolders = new Set<string>();
  for (let page = 1; page <= (options.maximumCommitPages ?? 30); page += 1) {
    const query = `sha=${encodeURIComponent(options.branch)}&per_page=100&page=${page}`;
    const commits = await api<ReportCommit[]>('GET', `/commits?${query}`);
    recordRunFolderTimestamps(commits, runFolders, prunableAtEpochSecondsByPath, undatedRunFolders);
    if (commits.length < 100) break;
  }
  // An unreadable publish date might be newer than every dated publish we saw.
  for (const folder of undatedRunFolders) prunableAtEpochSecondsByPath.delete(folder);
}

/** Closed PRs use closed_at; run and confirmed legacy folders use the latest publish
 *  committer date in a bounded log scan. Missing/invalid dates never permit deletion. */
export async function readReportFolderTimestamps(
  options: ReportPruneApiOptions & { maximumCommitPages?: number },
  folders: readonly string[],
): Promise<{ prunableAtEpochSecondsByPath: Map<string, number>; openPullRequestPaths: Set<string> }> {
  const api = githubClient(options);
  const { openPullRequestPaths, closedPullRequests } = await readPullRequestStates(api);
  const prunableAtEpochSecondsByPath = new Map<string, number>();
  const runFolders = await classifyReportFolders(
    api,
    folders,
    closedPullRequests,
    openPullRequestPaths,
    prunableAtEpochSecondsByPath,
  );
  await dateRunFolders(api, options, runFolders, prunableAtEpochSecondsByPath);
  return { prunableAtEpochSecondsByPath, openPullRequestPaths };
}
