/** Prune `pr-<n>/` report folders from the report branch through the GitHub
 *  git-data API.
 *
 *  Two callers, one mechanism:
 *  - on PR close, delete that PR's folder;
 *  - on a daily schedule, sweep by retention and then by a hard size budget.
 *
 *  The budget is what actually bounds the branch. Retention alone cannot: a
 *  single PR can publish hundreds of megabytes of crops, so the folders that
 *  blow the budget are routinely younger than any reasonable retention window,
 *  and one missed close event otherwise leaks a folder forever. The sweep
 *  deletes oldest-closed first until the branch fits, and never touches a
 *  folder whose PR is still open — those are the live review links.
 *
 *  Like publish, this never clones the branch: deleting gigabytes of
 *  screenshots must not require downloading them first, and even a blobless
 *  clone re-fetches the retained blobs at push time. */

export type ReportFolderPruneSelection = {
  foldersToDelete: string[];
  /** Blob bytes that remain on the branch after the selected deletions. */
  branchSizeAfterBytes: number;
  /** True when even deleting every closed folder leaves the branch over
   *  budget — everything left belongs to open PRs. */
  openFoldersExceedBudget: boolean;
};

/** Pure selection policy: retention first, then oldest-closed-first until the
 *  branch fits the budget. Folders with no closed-at entry belong to open PRs
 *  (or to nothing the API knows about) and are never selected. */
export function selectReportFoldersToPrune(options: {
  folderSizesBytesByPath: Map<string, number>;
  closedAtEpochSecondsByPath: Map<string, number>;
  retentionCutoffEpochSeconds: number;
  budgetBytes: number;
}): ReportFolderPruneSelection {
  const foldersToDelete: string[] = [];
  let branchSizeAfterBytes = 0;
  for (const sizeBytes of options.folderSizesBytesByPath.values()) {
    branchSizeAfterBytes += sizeBytes;
  }

  const prunableFoldersOldestFirst = [...options.folderSizesBytesByPath.keys()]
    .filter((folderPath) => options.closedAtEpochSecondsByPath.has(folderPath))
    .sort(
      (firstFolder, secondFolder) =>
        (options.closedAtEpochSecondsByPath.get(firstFolder) ?? 0) -
        (options.closedAtEpochSecondsByPath.get(secondFolder) ?? 0),
    );

  const remove = (folderPath: string) => {
    foldersToDelete.push(folderPath);
    branchSizeAfterBytes -= options.folderSizesBytesByPath.get(folderPath) ?? 0;
  };

  for (const folderPath of prunableFoldersOldestFirst) {
    const closedAt = options.closedAtEpochSecondsByPath.get(folderPath) ?? 0;
    if (closedAt <= options.retentionCutoffEpochSeconds) remove(folderPath);
  }
  for (const folderPath of prunableFoldersOldestFirst) {
    if (branchSizeAfterBytes <= options.budgetBytes) break;
    if (!foldersToDelete.includes(folderPath)) remove(folderPath);
  }

  return {
    foldersToDelete,
    branchSizeAfterBytes,
    openFoldersExceedBudget: branchSizeAfterBytes > options.budgetBytes,
  };
}

type GitTreeEntry = { path: string; mode: string; type: string; sha?: string | null; size?: number };

export type ReportPruneApiOptions = {
  apiBaseUrl: string;
  repository: string;
  token: string;
  branch: string;
  maximumAttempts?: number;
  fetchImplementation?: typeof fetch;
  sleepImplementation?: (milliseconds: number) => Promise<void>;
  log?: (line: string) => void;
};

class ReportPruneApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function buildClient(options: ReportPruneApiOptions) {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const repositoryUrl = `${options.apiBaseUrl}/repos/${options.repository}`;
  async function api<ResponseShape>(method: string, apiPath: string, body?: unknown): Promise<ResponseShape> {
    const response = await fetchImplementation(`${repositoryUrl}${apiPath}`, {
      method,
      headers: {
        authorization: `Bearer ${options.token}`,
        accept: 'application/vnd.github+json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ReportPruneApiError(
        `${method} ${apiPath} -> ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
        response.status,
      );
    }
    return (await response.json()) as ResponseShape;
  }
  return { api };
}

async function realSleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Read the branch tip and the per-folder blob sizes in two calls. Returns null
 *  when the branch does not exist yet. Throws when the recursive listing is
 *  truncated: a partial size map could select the wrong folders to delete. */
async function readBranchFolders(api: ReturnType<typeof buildClient>['api'], branch: string) {
  let tipCommitSha: string;
  try {
    const tipReference = await api<{ object: { sha: string } }>(
      'GET',
      `/git/ref/${encodeURIComponent(`heads/${branch}`)}`,
    );
    tipCommitSha = tipReference.object.sha;
  } catch (error) {
    if (error instanceof ReportPruneApiError && error.status === 404) return null;
    throw error;
  }
  const tipCommit = await api<{ tree: { sha: string } }>('GET', `/git/commits/${tipCommitSha}`);
  const recursiveTree = await api<{ tree: GitTreeEntry[]; truncated: boolean }>(
    'GET',
    `/git/trees/${tipCommit.tree.sha}?recursive=1`,
  );
  if (recursiveTree.truncated) {
    throw new Error(`the recursive tree listing for ${branch} is truncated — refusing to size-prune on partial data`);
  }
  const folderSizesBytesByPath = new Map<string, number>();
  for (const entry of recursiveTree.tree) {
    if (entry.type !== 'blob') continue;
    const topLevelFolder = entry.path.split('/')[0];
    if (!/^pr-\d+$/.test(topLevelFolder)) continue;
    folderSizesBytesByPath.set(topLevelFolder, (folderSizesBytesByPath.get(topLevelFolder) ?? 0) + (entry.size ?? 0));
  }
  return { tipCommitSha, tipTreeSha: tipCommit.tree.sha, folderSizesBytesByPath };
}

/** Delete the given top-level folders in one commit and fast-forward the ref.
 *  Retries the whole read-select-delete cycle when the ref moves under us. */
export async function deleteReportFolders(
  options: ReportPruneApiOptions & {
    selectFolders: (folderSizesBytesByPath: Map<string, number>) => string[] | Promise<string[]>;
    commitMessage: (deletedFolderCount: number) => string;
  },
): Promise<{ deletedFolders: string[] }> {
  const { api } = buildClient(options);
  const log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
  const sleep = options.sleepImplementation ?? realSleep;
  const maximumAttempts = options.maximumAttempts ?? 5;
  let lastError: unknown;
  for (let attemptNumber = 1; attemptNumber <= maximumAttempts; attemptNumber += 1) {
    try {
      const branchState = await readBranchFolders(api, options.branch);
      if (branchState === null) {
        log(`no ${options.branch} branch yet — nothing to prune`);
        return { deletedFolders: [] };
      }
      const requestedFolders = await options.selectFolders(branchState.folderSizesBytesByPath);
      const foldersToDelete = requestedFolders.filter((folderPath) =>
        branchState.folderSizesBytesByPath.has(folderPath),
      );
      if (foldersToDelete.length === 0) {
        log('no report folders need pruning');
        return { deletedFolders: [] };
      }
      const prunedTree = await api<{ sha: string }>('POST', '/git/trees', {
        base_tree: branchState.tipTreeSha,
        tree: foldersToDelete.map((folderPath) => ({
          path: folderPath,
          mode: '040000',
          type: 'tree',
          sha: null,
        })),
      });
      const prunedCommit = await api<{ sha: string }>('POST', '/git/commits', {
        message: options.commitMessage(foldersToDelete.length),
        tree: prunedTree.sha,
        parents: [branchState.tipCommitSha],
      });
      // force: false — if a publish advanced the branch since we read the tip,
      // this 422s and the cycle re-reads, re-selects, and retries.
      await api('PATCH', `/git/refs/${encodeURIComponent(`heads/${options.branch}`)}`, {
        sha: prunedCommit.sha,
        force: false,
      });
      return { deletedFolders: foldersToDelete };
    } catch (error) {
      lastError = error;
      const retryable =
        !(error instanceof ReportPruneApiError) || error.status === 422 || error.status === 409 || error.status >= 500;
      if (!retryable || attemptNumber === maximumAttempts) throw error;
      log(`report prune attempt ${attemptNumber} failed (${String(error)}); retrying`);
      await sleep(attemptNumber * 2000);
    }
  }
  throw lastError;
}

/** Closed-at timestamps for every closed PR, keyed `pr-<n>`, via the paginated
 *  pulls listing. Open PRs are deliberately absent. */
export async function readClosedPullRequestTimestamps(options: ReportPruneApiOptions): Promise<Map<string, number>> {
  const { api } = buildClient(options);
  const closedAtEpochSecondsByPath = new Map<string, number>();
  for (let pageNumber = 1; ; pageNumber += 1) {
    const page = await api<Array<{ number: number; closed_at: string | null }>>(
      'GET',
      `/pulls?state=closed&per_page=100&page=${pageNumber}`,
    );
    for (const pullRequest of page) {
      if (pullRequest.closed_at === null) continue;
      closedAtEpochSecondsByPath.set(`pr-${pullRequest.number}`, Math.floor(Date.parse(pullRequest.closed_at) / 1000));
    }
    if (page.length < 100) break;
  }
  return closedAtEpochSecondsByPath;
}
