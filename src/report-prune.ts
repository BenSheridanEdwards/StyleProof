// Prune `pr-<n>/` report folders from the report branch through the GitHub git-data
// API: on PR close delete that PR's folder; on a schedule sweep by retention, then by
// a hard size budget (oldest-closed first, open PRs never touched). The budget is what
// bounds the branch — one PR can publish hundreds of megabytes of crops.

import {
  type GitHubApi,
  type GitHubApiOptions,
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
  /** True when even deleting every closed folder leaves the branch over budget. */
  openFoldersExceedBudget: boolean;
};

/** Pure policy: retention first, then oldest-closed-first until the branch fits the budget. */
export function selectReportFoldersToPrune(options: {
  folderSizesBytesByPath: Map<string, number>;
  closedAtEpochSecondsByPath: Map<string, number>;
  retentionCutoffEpochSeconds: number;
  budgetBytes: number;
}): ReportFolderPruneSelection {
  const closedAt = (folder: string) => options.closedAtEpochSecondsByPath.get(folder) ?? 0;
  const foldersToDelete: string[] = [];
  let branchSizeAfterBytes = [...options.folderSizesBytesByPath.values()].reduce((total, size) => total + size, 0);
  const remove = (folder: string) => {
    foldersToDelete.push(folder);
    branchSizeAfterBytes -= options.folderSizesBytesByPath.get(folder) ?? 0;
  };
  const oldestFirst = [...options.folderSizesBytesByPath.keys()]
    .filter((folder) => options.closedAtEpochSecondsByPath.has(folder))
    .sort((a, b) => closedAt(a) - closedAt(b));
  for (const folder of oldestFirst) if (closedAt(folder) <= options.retentionCutoffEpochSeconds) remove(folder);
  for (const folder of oldestFirst) {
    if (branchSizeAfterBytes <= options.budgetBytes) break;
    if (!foldersToDelete.includes(folder)) remove(folder);
  }
  return { foldersToDelete, branchSizeAfterBytes, openFoldersExceedBudget: branchSizeAfterBytes > options.budgetBytes };
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
    folderSizesBytesByPath: blobSizesByFolder(tree, (folder) => /^pr-\d+$/.test(folder)),
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

/** Closed-at timestamps for every closed PR, keyed `pr-<n>`. Open PRs are deliberately absent. */
export async function readClosedPullRequestTimestamps(options: ReportPruneApiOptions): Promise<Map<string, number>> {
  const api = githubClient(options);
  const closedAt = new Map<string, number>();
  for (let page = 1; ; page += 1) {
    const pulls = await api<Array<{ number: number; closed_at: string | null }>>(
      'GET',
      `/pulls?state=closed&per_page=100&page=${page}`,
    );
    for (const pull of pulls) {
      if (pull.closed_at !== null) closedAt.set(`pr-${pull.number}`, Math.floor(Date.parse(pull.closed_at) / 1000));
    }
    if (pulls.length < 100) break;
  }
  return closedAt;
}
