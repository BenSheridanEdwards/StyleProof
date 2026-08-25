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
 *  Concurrency: the ref update must force (an orphan commit is never a
 *  fast-forward), so a publish that lands in the seconds between the tip read
 *  and the ref update is discarded with the old tip. For a cache that loss is
 *  self-healing — the next run misses and recaptures — and accepting it keeps
 *  this tool a single bounded pass instead of a lease protocol. The run logs
 *  the tip it replaced so the loss is observable, never silent. */

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
    for (const [bundleDirectoryName, epochSeconds] of Object.entries(
      parsed.lastPublishedEpochSecondsByBundle ?? {},
    )) {
      if (Number.isFinite(epochSeconds)) dates.set(bundleDirectoryName, Number(epochSeconds));
    }
    return dates;
  } catch {
    return new Map();
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
  const dates = new Map<string, number>();
  if (sidecarBlobSha) {
    const sidecarBlob = await api<{ content: string; encoding: string }>('GET', `/git/blobs/${sidecarBlobSha}`);
    const decoded =
      sidecarBlob.encoding === 'base64' ? Buffer.from(sidecarBlob.content, 'base64').toString('utf8') : sidecarBlob.content;
    for (const [bundleDirectoryName, epochSeconds] of parsePruneSidecar(decoded)) {
      dates.set(bundleDirectoryName, epochSeconds);
    }
  }

  // Publish stamps the FIRST 12 characters of the bundle SHA into the commit
  // subject while the directory carries the full SHA, so match by prefix.
  const directoryByPrefix = (shaPrefix: string): string | undefined =>
    bundleDirectoryNames.find((directoryName) => directoryName.toLowerCase().startsWith(shaPrefix.toLowerCase()));

  const maximumCommitPages = options.maximumCommitPages ?? 30;
  let commitCount = 0;
  for (let pageNumber = 1; pageNumber <= maximumCommitPages; pageNumber += 1) {
    const page = await api<Array<{ commit: { message: string; committer: { date: string } | null } }>>(
      'GET',
      `/commits?sha=${encodeURIComponent(options.branch)}&per_page=100&page=${pageNumber}`,
    );
    commitCount += page.length;
    for (const listedCommit of page) {
      const subjectMatch = MAP_PUBLISH_COMMIT_SUBJECT.exec(listedCommit.commit.message);
      if (!subjectMatch || !listedCommit.commit.committer?.date) continue;
      const bundleDirectoryName = directoryByPrefix(subjectMatch[1]);
      if (!bundleDirectoryName) continue;
      const publishedEpochSeconds = Math.floor(Date.parse(listedCommit.commit.committer.date) / 1000);
      // The log pages newest-first; keep the newest date per bundle, and let
      // any log date beat the sidecar's squash-time snapshot.
      const alreadyRecorded = dates.get(bundleDirectoryName);
      if (alreadyRecorded === undefined || publishedEpochSeconds > alreadyRecorded) {
        dates.set(bundleDirectoryName, publishedEpochSeconds);
      }
    }
    if (page.length < 100) break;
  }
  return { lastPublishedEpochSecondsByDirectoryName: dates, commitCount };
}

async function compactOnce(
  options: MapStorePruneApiOptions,
  api: ReturnType<typeof buildClient>['api'],
  log: (line: string) => void,
): Promise<MapStorePruneResult> {
  let tipCommitSha: string;
  try {
    const tipReference = await api<{ object: { sha: string } }>(
      'GET',
      `/git/ref/${encodeURIComponent(`heads/${options.branch}`)}`,
    );
    tipCommitSha = tipReference.object.sha;
  } catch (error) {
    if (error instanceof MapStorePruneApiError && error.status === 404) {
      log(`no ${options.branch} branch yet — nothing to prune`);
      return { compacted: false, retainedDirectoryNames: [], prunedDirectoryNames: [] };
    }
    throw error;
  }

  const tipCommit = await api<{ tree: { sha: string } }>('GET', `/git/commits/${tipCommitSha}`);
  // The ROOT tree only — a recursive listing of a legacy map branch (200k+
  // entries) truncates, and selection must never run on partial data.
  const rootTree = await api<{ tree: GitTreeEntry[] }>('GET', `/git/trees/${tipCommit.tree.sha}`);
  const bundleEntries = rootTree.tree.filter(isBundleDirectoryEntry);
  const readmeEntry = rootTree.tree.find((entry) => entry.type === 'blob' && entry.path === 'README.md');
  const sidecarEntry = rootTree.tree.find((entry) => entry.type === 'blob' && entry.path === MAP_STORE_PRUNE_SIDECAR);

  const bundleDirectoryNames = bundleEntries.map((entry) => entry.path);
  const { lastPublishedEpochSecondsByDirectoryName, commitCount } = await readBundleDates(
    api,
    options,
    bundleDirectoryNames,
    sidecarEntry?.sha ?? undefined,
  );

  const nowEpochSeconds = options.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  const retentionDays = options.retentionDays ?? 14;
  const selection = selectMapBundlesToRetain({
    bundleDirectoryNames,
    lastPublishedEpochSecondsByDirectoryName,
    retentionCutoffEpochSeconds: nowEpochSeconds - retentionDays * 86400,
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

  const sidecar: PruneSidecar = {
    version: 1,
    prunedAt: new Date(nowEpochSeconds * 1000).toISOString(),
    lastPublishedEpochSecondsByBundle: Object.fromEntries(
      selection.retainedDirectoryNames.map((directoryName) => [
        directoryName,
        lastPublishedEpochSecondsByDirectoryName.get(directoryName) ?? 0,
      ]),
    ),
  };
  const sidecarBlob = await api<{ sha: string }>('POST', '/git/blobs', {
    content: Buffer.from(`${JSON.stringify(sidecar, null, 2)}\n`).toString('base64'),
    encoding: 'base64',
  });
  const readmeBlobSha =
    readmeEntry?.sha ??
    (
      await api<{ sha: string }>('POST', '/git/blobs', {
        content: Buffer.from(
          '# StyleProof maps\n\nMachine-generated reusable map bundles. Each folder is keyed by commit SHA and capture compatibility.\n',
        ).toString('base64'),
        encoding: 'base64',
      })
    ).sha;

  const retainedEntrySet = new Set(selection.retainedDirectoryNames);
  const compactedTree = await api<{ sha: string }>('POST', '/git/trees', {
    // No base_tree: this IS the whole new root. Retained bundle subtrees are
    // referenced by their existing tree SHAs, so no bundle content re-uploads.
    tree: [
      ...bundleEntries
        .filter((entry) => retainedEntrySet.has(entry.path))
        .map((entry) => ({ path: entry.path, mode: '040000', type: 'tree', sha: entry.sha })),
      { path: 'README.md', mode: '100644', type: 'blob', sha: readmeBlobSha },
      { path: MAP_STORE_PRUNE_SIDECAR, mode: '100644', type: 'blob', sha: sidecarBlob.sha },
    ],
  });
  const compactionCommit = await api<{ sha: string }>('POST', '/git/commits', {
    message:
      `StyleProof map store compaction: ${selection.retainedDirectoryNames.length} bundles retained, ` +
      `${selection.prunedDirectoryNames.length} pruned`,
    tree: compactedTree.sha,
    parents: [],
  });
  // force: an orphan commit is never a fast-forward. A publish landing between
  // the tip read above and this update is discarded with the old tip — log the
  // replaced tip so that (harmless, self-healing) loss is observable.
  await api('PATCH', `/git/refs/${encodeURIComponent(`heads/${options.branch}`)}`, {
    sha: compactionCommit.sha,
    force: true,
  });
  log(
    `compacted ${options.branch}: ${selection.retainedDirectoryNames.length} bundles retained, ` +
      `${selection.prunedDirectoryNames.length} pruned, history squashed to one commit ` +
      `(replaced tip ${tipCommitSha.slice(0, 12)} — a publish racing this window is recaptured on its next run)`,
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
        !(error instanceof MapStorePruneApiError) || error.status === 422 || error.status === 409 || error.status >= 500;
      if (!retryable || attemptNumber === maximumAttempts) throw error;
      log(`map store prune attempt ${attemptNumber} failed (${String(error)}); retrying`);
      await sleep(attemptNumber * 2000);
    }
  }
  throw lastError;
}
