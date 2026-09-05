/** Prune and compact the sha-keyed map store branch through the GitHub
 *  git-data API — never by cloning the branch (#423).
 *
 *  The map store is a CACHE: bundles are keyed by commit SHA, so once the base
 *  branch moves past a SHA its bundle can never be restored again, and nothing
 *  links into the branch (restore is a depth-1 sparse clone of the tip). That
 *  makes the correct bound a SQUASH, not a tip-only delete: the branch is
 *  rewritten as a single orphan commit holding only the retained bundles, so
 *  both the tip tree and the history are bounded in one operation. This is
 *  deliberately different from the report branch, whose history must survive
 *  because PR comments pin report blobs at commit SHAs.
 *
 *  Dating bundles: publish stamps each bundle with a commit whose message is
 *  `StyleProof map <sha12> <compatibilityKey>`, so the branch log dates every
 *  bundle — until the first squash discards that log. The squash therefore
 *  writes a `styleproof-map-store-prune.json` sidecar at the branch root
 *  carrying the retained bundles' dates forward; the next run merges log-derived
 *  dates over sidecar dates. A bundle with neither (a legacy bundle from before
 *  this tool) sorts oldest and is pruned first.
 *
 *  Concurrency: GitHub's atomic updateRefs mutation permits the orphan update
 *  only while the branch still points to the tip used for retention selection.
 *  A racing publication causes a bounded retry from the new tip; there is no
 *  unconditional force-update fallback. */

export const MAP_STORE_PRUNE_SIDECAR = 'styleproof-map-store-prune.json';

/** Matches the per-bundle publish commit subject (`StyleProof map <sha12> <key>`). */
const MAP_PUBLISH_COMMIT_SUBJECT = /^StyleProof map ([0-9a-f]{7,40}) /i;

export type MapBundlePruneSelection = {
  /** Bundle directory names to keep, newest first. */
  retainedDirectoryNames: string[];
  /** Bundle directory names to delete. */
  prunedDirectoryNames: string[];
};

/** Pure selection policy: drop bundles older than the retention cutoff, then
 *  cap what survives at `maximumBundleCount`, newest first. A bundle with no
 *  known date sorts oldest (epoch zero) — the only undated bundles are legacy
 *  ones from before the sidecar existed, since every publish since the map
 *  store shipped stamps a dated commit. */
export function selectMapBundlesToRetain(options: {
  bundleDirectoryNames: readonly string[];
  lastPublishedEpochSecondsByDirectoryName: ReadonlyMap<string, number>;
  retentionCutoffEpochSeconds: number;
  maximumBundleCount: number;
}): MapBundlePruneSelection {
  const publishedAt = (directoryName: string): number =>
    options.lastPublishedEpochSecondsByDirectoryName.get(directoryName) ?? 0;
  const newestFirst = [...options.bundleDirectoryNames].sort(
    (firstDirectory, secondDirectory) =>
      publishedAt(secondDirectory) - publishedAt(firstDirectory) || firstDirectory.localeCompare(secondDirectory),
  );
  const retainedDirectoryNames: string[] = [];
  const prunedDirectoryNames: string[] = [];
  for (const directoryName of newestFirst) {
    const insideRetentionWindow = publishedAt(directoryName) > options.retentionCutoffEpochSeconds;
    if (insideRetentionWindow && retainedDirectoryNames.length < options.maximumBundleCount) {
      retainedDirectoryNames.push(directoryName);
    } else {
      prunedDirectoryNames.push(directoryName);
    }
  }
  return { retainedDirectoryNames, prunedDirectoryNames };
}

type GitTreeEntry = { path: string; mode: string; type: string; sha?: string | null; size?: number };

export type MapStorePruneApiOptions = {
  apiBaseUrl: string;
  repository: string;
  token: string;
  branch: string;
  /** Bundles newer than this many days survive retention (default 14). */
  retentionDays?: number;
  /** At most this many bundles survive, newest first (default 40). */
  maximumBundleCount?: number;
  /** Skip the rewrite when nothing is prunable and the branch history holds no
   *  more than this many commits, so a scheduled run does not force-push a
   *  fresh orphan commit every day for nothing (default 30). */
  historyCommitLimit?: number;
  /** Upper bound on commit-log pages read for bundle dates (default 30 pages
   *  of 100). Anything older is undated and prunes first, which is the right
   *  answer for a bundle thousands of publishes old. */
  maximumCommitPages?: number;
  maximumAttempts?: number;
  nowEpochSeconds?: number;
  fetchImplementation?: typeof fetch;
  sleepImplementation?: (milliseconds: number) => Promise<void>;
  log?: (line: string) => void;
};

export type MapStorePruneResult = {
  /** True when the branch was rewritten (a compaction commit was pushed). */
  compacted: boolean;
  retainedDirectoryNames: string[];
  prunedDirectoryNames: string[];
};

class MapStorePruneApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function buildClient(options: MapStorePruneApiOptions) {
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
      throw new MapStorePruneApiError(
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

/** A top-level tree entry that is a stored bundle directory (a hex commit SHA). */
function isBundleDirectoryEntry(entry: GitTreeEntry): boolean {
  return entry.type === 'tree' && /^[0-9a-f]{7,40}$/i.test(entry.path);
}

type PruneSidecar = {
  version: 1;
  prunedAt: string;
  lastPublishedEpochSecondsByBundle: Record<string, number>;
};

/** Parse a sidecar blob's JSON; a malformed sidecar degrades to "no dates"
 *  rather than failing the run — the bundles it covered then sort oldest, which
 *  only ever prunes MORE aggressively, never resurrects anything. */
function parsePruneSidecar(content: string): Map<string, number> {
  try {
    const parsed = JSON.parse(content) as Partial<PruneSidecar>;
    const dates = new Map<string, number>();
    for (const [bundleDirectoryName, epochSeconds] of Object.entries(parsed.lastPublishedEpochSecondsByBundle ?? {})) {
      if (Number.isFinite(epochSeconds)) dates.set(bundleDirectoryName, Number(epochSeconds));
    }
    return dates;
  } catch {
    return new Map();
  }
}

/** Dates carried by the previous squash's sidecar; empty when there is none. */
async function readSidecarDates(
  api: ReturnType<typeof buildClient>['api'],
  sidecarBlobSha: string | undefined,
): Promise<Map<string, number>> {
  if (!sidecarBlobSha) return new Map();
  const sidecarBlob = await api<{ content: string; encoding: string }>('GET', `/git/blobs/${sidecarBlobSha}`);
  const decoded =
    sidecarBlob.encoding === 'base64'
      ? Buffer.from(sidecarBlob.content, 'base64').toString('utf8')
      : sidecarBlob.content;
  return parsePruneSidecar(decoded);
}

type ListedCommit = { commit: { message: string; committer: { date: string } | null } };

/** Fold one commit-log page's publish subjects into the running date map,
 *  keeping the newest date per bundle (any log date beats the sidecar's
 *  squash-time snapshot). */
function mergeLogPageDates(
  page: readonly ListedCommit[],
  directoryByPrefix: (shaPrefix: string) => string | undefined,
  dates: Map<string, number>,
): void {
  for (const listedCommit of page) {
    const subjectMatch = MAP_PUBLISH_COMMIT_SUBJECT.exec(listedCommit.commit.message);
    if (!subjectMatch || !listedCommit.commit.committer?.date) continue;
    const bundleDirectoryName = directoryByPrefix(subjectMatch[1]);
    if (!bundleDirectoryName) continue;
    const publishedEpochSeconds = Math.floor(Date.parse(listedCommit.commit.committer.date) / 1000);
    const alreadyRecorded = dates.get(bundleDirectoryName);
    if (alreadyRecorded === undefined || publishedEpochSeconds > alreadyRecorded) {
      dates.set(bundleDirectoryName, publishedEpochSeconds);
    }
  }
}

/** Merge log-derived bundle dates over sidecar-carried ones. The log wins: it
 *  reflects publishes since the last squash, which are strictly newer than
 *  anything the sidecar recorded at squash time. */
async function readBundleDates(
  api: ReturnType<typeof buildClient>['api'],
  options: MapStorePruneApiOptions,
  bundleDirectoryNames: readonly string[],
  sidecarBlobSha: string | undefined,
): Promise<{ lastPublishedEpochSecondsByDirectoryName: Map<string, number>; commitCount: number }> {
  const dates = await readSidecarDates(api, sidecarBlobSha);

  // Publish stamps the FIRST 12 characters of the bundle SHA into the commit
  // subject while the directory carries the full SHA, so match by prefix.
  const directoryByPrefix = (shaPrefix: string): string | undefined =>
    bundleDirectoryNames.find((directoryName) => directoryName.toLowerCase().startsWith(shaPrefix.toLowerCase()));

  const maximumCommitPages = options.maximumCommitPages ?? 30;
  let commitCount = 0;
  for (let pageNumber = 1; pageNumber <= maximumCommitPages; pageNumber += 1) {
    const page = await api<ListedCommit[]>(
      'GET',
      `/commits?sha=${encodeURIComponent(options.branch)}&per_page=100&page=${pageNumber}`,
    );
    commitCount += page.length;
    mergeLogPageDates(page, directoryByPrefix, dates);
    if (page.length < 100) break;
  }
  return { lastPublishedEpochSecondsByDirectoryName: dates, commitCount };
}

type BranchState = {
  tipCommitSha: string;
  rootTreeEntries: GitTreeEntry[];
  bundleEntries: GitTreeEntry[];
  readmeBlobSha: string | undefined;
  sidecarBlobSha: string | undefined;
};

/** Read the branch tip and its ROOT tree — never a recursive listing, which
 *  truncates on a legacy map branch (200k+ entries), and selection must never
 *  run on partial data. `null` when the branch does not exist yet. */
async function readBranchState(
  api: ReturnType<typeof buildClient>['api'],
  branch: string,
): Promise<BranchState | null> {
  let tipCommitSha: string;
  try {
    const tipReference = await api<{ object: { sha: string } }>(
      'GET',
      `/git/ref/${encodeURIComponent(`heads/${branch}`)}`,
    );
    tipCommitSha = tipReference.object.sha;
  } catch (error) {
    if (error instanceof MapStorePruneApiError && error.status === 404) return null;
    throw error;
  }
  const tipCommit = await api<{ tree: { sha: string } }>('GET', `/git/commits/${tipCommitSha}`);
  const rootTree = await api<{ tree: GitTreeEntry[] }>('GET', `/git/trees/${tipCommit.tree.sha}`);
  const blobShaAt = (path: string): string | undefined =>
    rootTree.tree.find((entry) => entry.type === 'blob' && entry.path === path)?.sha ?? undefined;
  return {
    tipCommitSha,
    rootTreeEntries: rootTree.tree,
    bundleEntries: rootTree.tree.filter(isBundleDirectoryEntry),
    readmeBlobSha: blobShaAt('README.md'),
    sidecarBlobSha: blobShaAt(MAP_STORE_PRUNE_SIDECAR),
  };
}

const MAP_STORE_README =
  '# StyleProof maps\n\nMachine-generated reusable map bundles. Each folder is keyed by commit SHA and capture compatibility.\n';

async function createBlob(api: ReturnType<typeof buildClient>['api'], content: string): Promise<string> {
  const blob = await api<{ sha: string }>('POST', '/git/blobs', {
    content: Buffer.from(content).toString('base64'),
    encoding: 'base64',
  });
  return blob.sha;
}

type UpdateRefsResponseKind = 'acknowledged' | 'errors' | 'invalid';

function classifyUpdateRefsResponse(result: unknown, beforeOid: string): UpdateRefsResponseKind {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return 'invalid';
  const responseObject = result as Record<string, unknown>;
  const errors = responseObject.errors;
  if (errors !== undefined && (!Array.isArray(errors) || errors.length > 0)) return 'errors';
  const data = responseObject.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return 'invalid';
  const updateRefs = (data as Record<string, unknown>).updateRefs;
  if (typeof updateRefs !== 'object' || updateRefs === null || Array.isArray(updateRefs)) return 'invalid';
  return (updateRefs as Record<string, unknown>).clientMutationId === beforeOid ? 'acknowledged' : 'invalid';
}

/** Atomically replace exactly the tip used to select retained bundles. */
async function updateCompactedRef(
  api: ReturnType<typeof buildClient>['api'],
  options: MapStorePruneApiOptions,
  beforeOid: string,
  afterOid: string,
): Promise<void> {
  const repository = await api<{ node_id: string }>('GET', '');
  if (!repository.node_id) throw new MapStorePruneApiError('missing repository node ID', 502);
  const apiBaseUrl = options.apiBaseUrl.replace(/\/$/, '');
  const graphqlUrl = apiBaseUrl.endsWith('/api/v3')
    ? `${apiBaseUrl.slice(0, -'/api/v3'.length)}/api/graphql`
    : `${apiBaseUrl}/graphql`;
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
  if (!response.ok) throw new MapStorePruneApiError(`map compaction updateRefs -> ${response.status}`, response.status);
  const resultKind = classifyUpdateRefsResponse(await response.json(), beforeOid);
  if (resultKind === 'errors') {
    const current = await api<{ object: { sha: string } }>(
      'GET',
      `/git/ref/${encodeURIComponent(`heads/${options.branch}`)}`,
    );
    const status = current.object.sha !== beforeOid ? 409 : 400;
    throw new MapStorePruneApiError('map compaction updateRefs returned GraphQL errors', status);
  }
  if (resultKind !== 'acknowledged') {
    throw new MapStorePruneApiError('map compaction updateRefs returned no matching acknowledgement', 502);
  }
}

/** Write the squashed branch: a full new root tree (retained bundles + foreign
 *  entries by their existing SHAs, so nothing re-uploads), an orphan commit,
 *  and a conditional non-fast-forward ref update. */
async function writeCompactedBranch(
  api: ReturnType<typeof buildClient>['api'],
  options: MapStorePruneApiOptions,
  branchState: BranchState,
  selection: MapBundlePruneSelection,
  refreshedSidecarContent: string,
): Promise<void> {
  const sidecarBlobSha = await createBlob(api, refreshedSidecarContent);
  const readmeBlobSha = branchState.readmeBlobSha ?? (await createBlob(api, MAP_STORE_README));
  const retainedEntrySet = new Set(selection.retainedDirectoryNames);
  // Consumers park operational files on the artifact branch (deployment
  // suppression guards, CI markers). The squash must never delete anything it
  // does not own: every root entry that is not a bundle directory or one of
  // this tool's own files rides across unchanged.
  const foreignRootEntries = branchState.rootTreeEntries.filter(
    (entry) => !isBundleDirectoryEntry(entry) && entry.path !== 'README.md' && entry.path !== MAP_STORE_PRUNE_SIDECAR,
  );
  const compactedTree = await api<{ sha: string }>('POST', '/git/trees', {
    tree: [
      ...branchState.bundleEntries
        .filter((entry) => retainedEntrySet.has(entry.path))
        .map((entry) => ({ path: entry.path, mode: '040000', type: 'tree', sha: entry.sha })),
      ...foreignRootEntries.map((entry) => ({ path: entry.path, mode: entry.mode, type: entry.type, sha: entry.sha })),
      { path: 'README.md', mode: '100644', type: 'blob', sha: readmeBlobSha },
      { path: MAP_STORE_PRUNE_SIDECAR, mode: '100644', type: 'blob', sha: sidecarBlobSha },
    ],
  });
  const compactionCommit = await api<{ sha: string }>('POST', '/git/commits', {
    message:
      `StyleProof map store compaction: ${selection.retainedDirectoryNames.length} bundles retained, ` +
      `${selection.prunedDirectoryNames.length} pruned`,
    tree: compactedTree.sha,
    parents: [],
  });
  await updateCompactedRef(api, options, branchState.tipCommitSha, compactionCommit.sha);
}

async function compactOnce(
  options: MapStorePruneApiOptions,
  api: ReturnType<typeof buildClient>['api'],
  log: (line: string) => void,
): Promise<MapStorePruneResult> {
  const branchState = await readBranchState(api, options.branch);
  if (branchState === null) {
    log(`no ${options.branch} branch yet — nothing to prune`);
    return { compacted: false, retainedDirectoryNames: [], prunedDirectoryNames: [] };
  }

  const bundleDirectoryNames = branchState.bundleEntries.map((entry) => entry.path);
  const { lastPublishedEpochSecondsByDirectoryName, commitCount } = await readBundleDates(
    api,
    options,
    bundleDirectoryNames,
    branchState.sidecarBlobSha,
  );

  const nowEpochSeconds = options.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  const selection = selectMapBundlesToRetain({
    bundleDirectoryNames,
    lastPublishedEpochSecondsByDirectoryName,
    retentionCutoffEpochSeconds: nowEpochSeconds - (options.retentionDays ?? 14) * 86400,
    maximumBundleCount: options.maximumBundleCount ?? 40,
  });

  const historyCommitLimit = options.historyCommitLimit ?? 30;
  if (selection.prunedDirectoryNames.length === 0 && commitCount <= historyCommitLimit) {
    log(
      `nothing to prune (${selection.retainedDirectoryNames.length} bundles, ` +
        `${commitCount} commits ≤ history limit ${historyCommitLimit})`,
    );
    return { compacted: false, ...selection };
  }

  const refreshedSidecar: PruneSidecar = {
    version: 1,
    prunedAt: new Date(nowEpochSeconds * 1000).toISOString(),
    lastPublishedEpochSecondsByBundle: Object.fromEntries(
      selection.retainedDirectoryNames.map((directoryName) => [
        directoryName,
        lastPublishedEpochSecondsByDirectoryName.get(directoryName) ?? 0,
      ]),
    ),
  };
  await writeCompactedBranch(api, options, branchState, selection, `${JSON.stringify(refreshedSidecar, null, 2)}\n`);
  log(
    `compacted ${options.branch}: ${selection.retainedDirectoryNames.length} bundles retained, ` +
      `${selection.prunedDirectoryNames.length} pruned, history squashed to one commit ` +
      `(conditionally replaced tip ${branchState.tipCommitSha.slice(0, 12)})`,
  );
  return { compacted: true, ...selection };
}

/** Prune stale bundles and squash the map store branch to a single commit.
 *  Retries transient API faults; a missing branch and a nothing-to-do run are
 *  both successes. */
export async function compactMapStoreBranch(options: MapStorePruneApiOptions): Promise<MapStorePruneResult> {
  const { api } = buildClient(options);
  const log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
  const sleep = options.sleepImplementation ?? realSleep;
  const maximumAttempts = options.maximumAttempts ?? 5;
  let lastError: unknown;
  for (let attemptNumber = 1; attemptNumber <= maximumAttempts; attemptNumber += 1) {
    try {
      return await compactOnce(options, api, log);
    } catch (error) {
      lastError = error;
      const retryable =
        !(error instanceof MapStorePruneApiError) ||
        error.status === 422 ||
        error.status === 409 ||
        error.status >= 500;
      if (!retryable || attemptNumber === maximumAttempts) throw error;
      const diagnostic = error instanceof MapStorePruneApiError ? `HTTP ${error.status}` : 'unexpected error';
      log(`map store prune attempt ${attemptNumber} failed (${diagnostic}); retrying`);
      await sleep(attemptNumber * 2000);
    }
  }
  throw lastError;
}
