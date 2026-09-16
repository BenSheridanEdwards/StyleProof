// Prune and compact the sha-keyed map store branch through the GitHub git-data API.
// Bundles are keyed by commit SHA, so once the base branch moves past a SHA its bundle can
// never be restored: the correct bound is a SQUASH to one orphan commit holding only the
// retained bundles. Publish commits date each bundle until the first squash; a
// `styleproof-map-store-prune.json` sidecar carries the retained dates forward and an
// undated (legacy) bundle sorts oldest. The atomic updateRefs mutation only succeeds while
// the branch still points at the tip used for selection; a racing publish retries.

import {
  type GitHubApi,
  type GitHubApiOptions,
  type GitTreeEntry,
  GitHubApiError,
  blobSizesByFolder,
  createBlob,
  createCommit,
  createTree,
  githubClient,
  logLine,
  readBranchTipCommitSha,
  readCommitTreeSha,
  readTree,
  withRetries,
} from './github-git-data.js';
import { MAP_STORE_README } from './map-store/bundle.js';
import { asRecord } from './map-store/json.js';

export const MAP_STORE_PRUNE_SIDECAR = 'styleproof-map-store-prune.json';

/** The subject `publishMapBundle` stamps: `StyleProof map <sha12> <key>`. */
const MAP_PUBLISH_COMMIT_SUBJECT = /^StyleProof map ([0-9a-f]{7,40}) /i;

export type MapBundlePruneSelection = {
  /** Bundle directory names to keep, newest first. */
  retainedDirectoryNames: string[];
  prunedDirectoryNames: string[];
  /** Total size of retained bundles in bytes (when size data is available). */
  retainedSizeBytes?: number;
};

/** Pure policy: drop bundles older than the retention cutoff, then cap what survives
 *  at `maximumBundleCount` and within `budgetBytes`, newest first. */
export function selectMapBundlesToRetain(options: {
  bundleDirectoryNames: readonly string[];
  lastPublishedEpochSecondsByDirectoryName: ReadonlyMap<string, number>;
  retentionCutoffEpochSeconds: number;
  maximumBundleCount: number;
  budgetBytes?: number;
  sizeBytesByDirectoryName?: ReadonlyMap<string, number>;
}): MapBundlePruneSelection {
  const publishedAt = (name: string) => options.lastPublishedEpochSecondsByDirectoryName.get(name) ?? 0;
  const sizeOf = (name: string) => options.sizeBytesByDirectoryName?.get(name) ?? 0;
  const budget = options.sizeBytesByDirectoryName === undefined ? undefined : options.budgetBytes;
  const retainedDirectoryNames: string[] = [];
  const prunedDirectoryNames: string[] = [];
  let retainedSizeBytes = 0;
  const newestFirst = [...options.bundleDirectoryNames].sort(
    (a, b) => publishedAt(b) - publishedAt(a) || a.localeCompare(b),
  );
  for (const name of newestFirst) {
    const keep =
      publishedAt(name) > options.retentionCutoffEpochSeconds &&
      retainedDirectoryNames.length < options.maximumBundleCount &&
      (budget === undefined || retainedSizeBytes + sizeOf(name) <= budget);
    (keep ? retainedDirectoryNames : prunedDirectoryNames).push(name);
    if (keep) retainedSizeBytes += sizeOf(name);
  }
  return {
    retainedDirectoryNames,
    prunedDirectoryNames,
    retainedSizeBytes: budget === undefined ? undefined : retainedSizeBytes,
  };
}

export type MapStorePruneApiOptions = GitHubApiOptions & {
  branch: string;
  /** Bundles newer than this many days survive retention (default 14). */
  retentionDays?: number;
  /** At most this many bundles survive, newest first (default 40). */
  maximumBundleCount?: number;
  /** Byte budget (default 1.5GB); skipped with a warning when the recursive listing truncates. */
  budgetBytes?: number;
  /** Skip the rewrite when nothing is prunable and the history holds no more commits than this (default 30). */
  historyCommitLimit?: number;
  /** Commit-log pages read for bundle dates (default 30 pages of 100); older bundles are undated. */
  maximumCommitPages?: number;
  nowEpochSeconds?: number;
};

export type MapStorePruneResult = {
  /** True when the branch was rewritten. */
  compacted: boolean;
  retainedDirectoryNames: string[];
  prunedDirectoryNames: string[];
};

const isBundleDirectoryEntry = (entry: GitTreeEntry): boolean =>
  entry.type === 'tree' && /^[0-9a-f]{7,40}$/i.test(entry.path);

type PruneSidecar = { version: 1; prunedAt: string; lastPublishedEpochSecondsByBundle: Record<string, number> };

/** A malformed sidecar degrades to "no dates": affected bundles sort oldest, which only prunes more. */
async function readSidecarDates(api: GitHubApi, sidecarBlobSha: string | undefined): Promise<Map<string, number>> {
  const dates = new Map<string, number>();
  if (!sidecarBlobSha) return dates;
  try {
    const blob = await api<{ content: string; encoding: string }>('GET', `/git/blobs/${sidecarBlobSha}`);
    const text = blob.encoding === 'base64' ? Buffer.from(blob.content, 'base64').toString('utf8') : blob.content;
    const parsed = JSON.parse(text) as Partial<PruneSidecar>;
    for (const [name, epoch] of Object.entries(parsed.lastPublishedEpochSecondsByBundle ?? {})) {
      if (Number.isFinite(epoch)) dates.set(name, Number(epoch));
    }
  } catch {
    // no dates
  }
  return dates;
}

type ListedCommit = { commit: { message: string; committer: { date: string } | null } };

/** Keep the newest publish date per bundle seen in one commit-log page. Publish stamps the
 *  first 12 characters of the bundle SHA; the directory carries the full SHA. */
function mergeCommitDates(commits: readonly ListedCommit[], names: readonly string[], dates: Map<string, number>) {
  for (const { commit } of commits) {
    const prefix = MAP_PUBLISH_COMMIT_SUBJECT.exec(commit.message)?.[1].toLowerCase();
    const name = prefix && commit.committer?.date ? names.find((n) => n.toLowerCase().startsWith(prefix)) : undefined;
    if (!name) continue;
    const epoch = Math.floor(Date.parse(commit.committer!.date) / 1000);
    if (epoch > (dates.get(name) ?? -Infinity)) dates.set(name, epoch);
  }
}

/** Log-derived dates win over sidecar dates: they reflect publishes since the last squash. */
async function readBundleDates(
  api: GitHubApi,
  options: MapStorePruneApiOptions,
  names: readonly string[],
  sidecar?: string,
) {
  const dates = await readSidecarDates(api, sidecar);
  let commitCount = 0;
  for (let page = 1; page <= (options.maximumCommitPages ?? 30); page += 1) {
    const query = `sha=${encodeURIComponent(options.branch)}&per_page=100&page=${page}`;
    const commits = await api<ListedCommit[]>('GET', `/commits?${query}`);
    commitCount += commits.length;
    mergeCommitDates(commits, names, dates);
    if (commits.length < 100) break;
  }
  return { lastPublishedEpochSecondsByDirectoryName: dates, commitCount };
}

type BranchState = {
  tipCommitSha: string;
  tipTreeSha: string;
  rootTreeEntries: GitTreeEntry[];
  bundleEntries: GitTreeEntry[];
  readmeBlobSha: string | undefined;
  sidecarBlobSha: string | undefined;
};

/** The tip and its ROOT tree only — a recursive listing truncates on a large branch. */
async function readBranchState(api: GitHubApi, branch: string): Promise<BranchState | null> {
  const tipCommitSha = await readBranchTipCommitSha(api, branch);
  if (tipCommitSha === null) return null;
  const tipTreeSha = await readCommitTreeSha(api, tipCommitSha);
  const { tree } = await readTree(api, tipTreeSha);
  const blobShaAt = (name: string) =>
    tree.find((entry) => entry.type === 'blob' && entry.path === name)?.sha ?? undefined;
  return {
    tipCommitSha,
    tipTreeSha,
    rootTreeEntries: tree,
    bundleEntries: tree.filter(isBundleDirectoryEntry),
    readmeBlobSha: blobShaAt('README.md'),
    sidecarBlobSha: blobShaAt(MAP_STORE_PRUNE_SIDECAR),
  };
}

function classifyUpdateRefsResponse(result: unknown, beforeOid: string): 'acknowledged' | 'errors' | 'invalid' {
  const body = asRecord(result);
  if (!body) return 'invalid';
  if (body.errors !== undefined && (!Array.isArray(body.errors) || body.errors.length > 0)) return 'errors';
  const updateRefs = asRecord(asRecord(body.data)?.updateRefs);
  return updateRefs?.clientMutationId === beforeOid ? 'acknowledged' : 'invalid';
}

/** Atomically replace exactly the tip used to select retained bundles. */
async function updateCompactedRef(
  api: GitHubApi,
  options: MapStorePruneApiOptions,
  beforeOid: string,
  afterOid: string,
) {
  const repository = await api<{ node_id: string }>('GET', '');
  if (!repository.node_id) throw new GitHubApiError('missing repository node ID', 502);
  const base = options.apiBaseUrl.replace(/\/$/, '');
  const graphqlUrl = base.endsWith('/api/v3') ? `${base.slice(0, -'/api/v3'.length)}/api/graphql` : `${base}/graphql`;
  const response = await (options.fetchImplementation ?? fetch)(graphqlUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query: 'mutation CompactMapStore($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }',
      variables: {
        input: {
          repositoryId: repository.node_id,
          clientMutationId: beforeOid,
          refUpdates: [{ name: `refs/heads/${options.branch}`, beforeOid, afterOid, force: true }],
        },
      },
    }),
  });
  if (!response.ok) throw new GitHubApiError(`map compaction updateRefs -> ${response.status}`, response.status);
  const kind = classifyUpdateRefsResponse(await response.json(), beforeOid);
  if (kind === 'errors') {
    const current = await readBranchTipCommitSha(api, options.branch);
    throw new GitHubApiError('map compaction updateRefs returned GraphQL errors', current !== beforeOid ? 409 : 400);
  }
  if (kind !== 'acknowledged')
    throw new GitHubApiError('map compaction updateRefs returned no matching acknowledgement', 502);
}

/** Write the squashed branch: retained bundles and foreign root entries by their existing
 *  SHAs (nothing re-uploads; the squash never deletes what it does not own), an orphan
 *  commit, and a conditional ref update. */
async function writeCompactedBranch(
  api: GitHubApi,
  options: MapStorePruneApiOptions,
  state: BranchState,
  selection: MapBundlePruneSelection,
  sidecar: string,
): Promise<void> {
  const sidecarBlobSha = await createBlob(api, sidecar);
  const readmeBlobSha = state.readmeBlobSha ?? (await createBlob(api, MAP_STORE_README));
  const retained = new Set(selection.retainedDirectoryNames);
  const owned = new Set(['README.md', MAP_STORE_PRUNE_SIDECAR]);
  const treeSha = await createTree(api, {
    tree: [
      ...state.bundleEntries.filter((e) => retained.has(e.path)).map((e) => ({ ...e, mode: '040000', type: 'tree' })),
      ...state.rootTreeEntries.filter((e) => !isBundleDirectoryEntry(e) && !owned.has(e.path)),
      { path: 'README.md', mode: '100644', type: 'blob', sha: readmeBlobSha },
      { path: MAP_STORE_PRUNE_SIDECAR, mode: '100644', type: 'blob', sha: sidecarBlobSha },
    ].map(({ path, mode, type, sha }) => ({ path, mode, type, sha })),
  });
  const message = `StyleProof map store compaction: ${selection.retainedDirectoryNames.length} bundles retained, ${selection.prunedDirectoryNames.length} pruned`;
  const commitSha = await createCommit(api, message, treeSha, []);
  await updateCompactedRef(api, options, state.tipCommitSha, commitSha);
}

async function compactOnce(api: GitHubApi, options: MapStorePruneApiOptions): Promise<MapStorePruneResult> {
  const log = logLine(options);
  const state = await readBranchState(api, options.branch);
  if (state === null) {
    log(`no ${options.branch} branch yet — nothing to prune`);
    return { compacted: false, retainedDirectoryNames: [], prunedDirectoryNames: [] };
  }
  const names = state.bundleEntries.map((entry) => entry.path);
  const { lastPublishedEpochSecondsByDirectoryName, commitCount } = await readBundleDates(
    api,
    options,
    names,
    state.sidecarBlobSha,
  );

  const { tree, truncated } = await readTree(api, state.tipTreeSha, true);
  const bundleSet = new Set(names.map((name) => name.toLowerCase()));
  const sizeBytesByDirectoryName = truncated
    ? undefined
    : blobSizesByFolder(tree, (folder) => bundleSet.has(folder.toLowerCase()));
  if (truncated) log('recursive tree listing truncated — budget enforcement skipped (count-only pruning)');

  const nowEpochSeconds = options.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  const selection = selectMapBundlesToRetain({
    bundleDirectoryNames: names,
    lastPublishedEpochSecondsByDirectoryName,
    retentionCutoffEpochSeconds: nowEpochSeconds - (options.retentionDays ?? 14) * 86400,
    maximumBundleCount: options.maximumBundleCount ?? 40,
    budgetBytes: sizeBytesByDirectoryName ? (options.budgetBytes ?? 1_500_000_000) : undefined,
    sizeBytesByDirectoryName,
  });
  const historyCommitLimit = options.historyCommitLimit ?? 30;
  const summary = `${selection.retainedDirectoryNames.length} bundles retained, ${selection.prunedDirectoryNames.length} pruned`;
  if (selection.prunedDirectoryNames.length === 0 && commitCount <= historyCommitLimit) {
    log(
      `nothing to prune (${selection.retainedDirectoryNames.length} bundles, ${commitCount} commits ≤ history limit ${historyCommitLimit})`,
    );
    return { compacted: false, ...selection };
  }
  const sidecar: PruneSidecar = {
    version: 1,
    prunedAt: new Date(nowEpochSeconds * 1000).toISOString(),
    lastPublishedEpochSecondsByBundle: Object.fromEntries(
      selection.retainedDirectoryNames.map((name) => [name, lastPublishedEpochSecondsByDirectoryName.get(name) ?? 0]),
    ),
  };
  await writeCompactedBranch(api, options, state, selection, `${JSON.stringify(sidecar, null, 2)}\n`);
  log(
    `compacted ${options.branch}: ${summary}, history squashed to one commit (conditionally replaced tip ${state.tipCommitSha.slice(0, 12)})`,
  );
  return { compacted: true, ...selection };
}

/** Prune stale bundles and squash the map store branch to a single commit. A missing
 *  branch and a nothing-to-do run are both successes. */
export async function compactMapStoreBranch(options: MapStorePruneApiOptions): Promise<MapStorePruneResult> {
  const api = githubClient(options);
  return withRetries(options, 'map store prune', () => compactOnce(api, options));
}
