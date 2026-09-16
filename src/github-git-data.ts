// One GitHub git-data client for the branch-maintenance modules (report publish,
// report prune, map-store prune). Working through the API keeps every operation
// proportional to the change, never to the size of the branch: no clone, no
// blob download, server-side tree grafts, and a fast-forward (or conditional)
// ref update that the caller retries when the tip moved under it.

export type GitHubApiOptions = {
  apiBaseUrl: string;
  repository: string;
  token: string;
  /** Retries for the tip-moved race and for transient API failures (default 5). */
  maximumAttempts?: number;
  /** Injection points for tests. */
  fetchImplementation?: typeof fetch;
  sleepImplementation?: (milliseconds: number) => Promise<void>;
  log?: (line: string) => void;
};

export class GitHubApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export type GitTreeEntry = { path: string; mode: string; type: string; sha?: string | null; size?: number };

export type GitHubApi = <ResponseShape>(method: string, apiPath: string, body?: unknown) => Promise<ResponseShape>;

/** A repository-scoped `api(method, path, body)` that throws GitHubApiError on non-2xx. */
export function githubClient(options: GitHubApiOptions): GitHubApi {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const repositoryUrl = `${options.apiBaseUrl}/repos/${options.repository}`;
  return async function api<ResponseShape>(method: string, apiPath: string, body?: unknown): Promise<ResponseShape> {
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
      throw new GitHubApiError(
        `${method} ${apiPath} -> ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
        response.status,
      );
    }
    return (await response.json()) as ResponseShape;
  };
}

export function logLine(options: GitHubApiOptions): (line: string) => void {
  return options.log ?? ((line) => process.stderr.write(`${line}\n`));
}

/** 422 (non-fast-forward or already-created ref), 409, and 5xx retry; other 4xx are real failures. */
export function isRetryableStatus(status: number): boolean {
  return status === 422 || status === 409 || status >= 500;
}

/** Run `attempt` up to `maximumAttempts` times with a linear backoff, retrying only retryable failures. */
export async function withRetries<T>(options: GitHubApiOptions, label: string, attempt: () => Promise<T>): Promise<T> {
  const log = logLine(options);
  const sleep = options.sleepImplementation ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maximumAttempts = options.maximumAttempts ?? 5;
  let lastError: unknown;
  for (let attemptNumber = 1; attemptNumber <= maximumAttempts; attemptNumber += 1) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      const retryable = error instanceof GitHubApiError ? isRetryableStatus(error.status) : true;
      if (!retryable || attemptNumber === maximumAttempts) throw error;
      const diagnostic = error instanceof GitHubApiError ? `HTTP ${error.status}` : String(error);
      log(`${label} attempt ${attemptNumber} failed (${diagnostic}); retrying`);
      await sleep(attemptNumber * 2000);
    }
  }
  throw lastError;
}

/** Current tip commit of a branch, or null when the branch does not exist yet. */
export async function readBranchTipCommitSha(api: GitHubApi, branch: string): Promise<string | null> {
  try {
    const ref = await api<{ object: { sha: string } }>('GET', `/git/ref/${encodeURIComponent(`heads/${branch}`)}`);
    return ref.object.sha;
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return null;
    throw error;
  }
}

export async function readCommitTreeSha(api: GitHubApi, commitSha: string): Promise<string> {
  return (await api<{ tree: { sha: string } }>('GET', `/git/commits/${commitSha}`)).tree.sha;
}

export async function readTree(
  api: GitHubApi,
  treeSha: string,
  recursive = false,
): Promise<{ tree: GitTreeEntry[]; truncated: boolean }> {
  return api('GET', `/git/trees/${treeSha}${recursive ? '?recursive=1' : ''}`);
}

/** Blob bytes summed per top-level folder, for the folders `keep` accepts. */
export function blobSizesByFolder(
  entries: readonly GitTreeEntry[],
  keep: (folder: string) => boolean,
): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const entry of entries) {
    if (entry.type !== 'blob') continue;
    const folder = entry.path.split('/')[0];
    if (keep(folder)) sizes.set(folder, (sizes.get(folder) ?? 0) + (entry.size ?? 0));
  }
  return sizes;
}

export async function createBlob(api: GitHubApi, content: Buffer | string): Promise<string> {
  const blob = await api<{ sha: string }>('POST', '/git/blobs', {
    content: Buffer.from(content).toString('base64'),
    encoding: 'base64',
  });
  return blob.sha;
}

export async function createTree(
  api: GitHubApi,
  payload: { base_tree?: string; tree: GitTreeEntry[] },
): Promise<string> {
  return (await api<{ sha: string }>('POST', '/git/trees', payload)).sha;
}

export async function createCommit(api: GitHubApi, message: string, tree: string, parents: string[]): Promise<string> {
  return (await api<{ sha: string }>('POST', '/git/commits', { message, tree, parents })).sha;
}

/** Create the branch on first publish, else fast-forward it (a moved tip 422s for the caller to retry). */
export async function advanceBranch(api: GitHubApi, branch: string, tipSha: string | null, sha: string): Promise<void> {
  if (tipSha === null) await api('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha });
  else await api('PATCH', `/git/refs/${encodeURIComponent(`heads/${branch}`)}`, { sha, force: false });
}

/** A tree entry that deletes a top-level folder. */
export function deleteFolderEntry(folder: string): GitTreeEntry {
  return { path: folder, mode: '040000', type: 'tree', sha: null };
}
