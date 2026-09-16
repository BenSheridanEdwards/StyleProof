// The sha-keyed map store branch: publish a captured bundle (three push routes: isolated,
// workflow token, consumer checkout), restore one bundle, list stored SHAs, and resolve the
// base/head bundle pair a cached compare runs against.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CiWorktreeSession, consumerRelativeFromRepoRoot, gitRepoRoot, worktreeRunCwd } from '../ci-worktree.js';
import { inferBaseRef } from '../gitref.js';
import { removeDirRecursive } from '../node-util.js';
import { errorMessage } from '../util.js';
import {
  MAP_MANIFEST,
  MAP_STORE_README,
  MapStoreError,
  MapStoreNotFoundError,
  MapStorePreconditionError,
} from './bundle.js';
import {
  type GitResult,
  GITHUB_EXTRA_HEADER_KEY,
  type StoreTarget,
  assertRemote,
  checkoutMapStore,
  configArguments,
  copyDir,
  effectiveGitHttpExtraHeaders,
  git,
  gitFailureMessage,
  gitStdout,
  lookupBranch,
  mapStoreRestoreAttempts,
  networkGit,
  removeTempWorkspace,
  retryBlocking,
  safeSegment,
  storeTarget,
  workflowTokenCredentialArguments,
} from './git-transport.js';
import { type MapManifest, currentGitSha, expectedCompatibilityKey, readMapManifest } from './manifest.js';

/** The commit subject `map-store-prune` parses bundle dates from. */
export const mapPublishCommitMessage = (sha: string, compatibilityKey: string): string =>
  `StyleProof map ${sha.slice(0, 12)} ${compatibilityKey}`;

const describeFailure = (label: string, result: GitResult): string =>
  `${label}: ${gitFailureMessage(result, `git exited ${result.status}`)}`;

const withFailures = (result: GitResult, failures: string[]): GitResult => ({ ...result, stderr: failures.join('\n') });

/** Retry through Git's credential lookup after clearing the rejected header. */
function pushWithWorkflowToken(checkout: string, branch: string): GitResult {
  git(checkout, ['config', '--local', '--unset-all', GITHUB_EXTRA_HEADER_KEY], 1 << 20);
  const credential = ['-c', `${GITHUB_EXTRA_HEADER_KEY}=`, ...workflowTokenCredentialArguments()];
  return networkGit(checkout, [...credential, 'push', '-q', 'origin', `HEAD:${branch}`]);
}

/** The temporary checkout is a blob:none partial clone that upload-pack cannot lazy-fetch
 *  from, so fetch the branch tip through the consumer's own credentials first; negotiation
 *  then narrows the import to the newly committed objects. A missing branch is fine. */
function pushViaConsumerCheckout(
  { cwd, remote, branch }: StoreTarget,
  checkout: string,
  failures: string[],
): GitResult {
  const commit = gitStdout(checkout, ['rev-parse', 'HEAD']);
  const tipRef = 'refs/styleproof/map-store-tip';
  const importTip = networkGit(cwd, [
    'fetch',
    '-q',
    '--no-write-fetch-head',
    remote,
    `+refs/heads/${branch}:${tipRef}`,
  ]);
  if (importTip.status !== 0) failures.push(describeFailure('consumer tip fetch', importTip));
  try {
    const importCommit = git(cwd, ['fetch', '-q', '--no-write-fetch-head', checkout, commit], 1 << 20);
    if (importCommit.status !== 0) {
      return withFailures(importCommit, [...failures, describeFailure('consumer checkout import', importCommit)]);
    }
    const push = networkGit(cwd, ['push', '-q', remote, `${commit}:refs/heads/${branch}`]);
    return push.status === 0
      ? push
      : withFailures(push, [...failures, describeFailure('consumer checkout push', push)]);
  } finally {
    git(cwd, ['update-ref', '-d', tipRef]);
  }
}

function pushMapStoreCommit(target: StoreTarget, checkout: string, authenticationArguments: string[]): GitResult {
  const failures: string[] = [];
  const isolated = networkGit(checkout, [...authenticationArguments, 'push', '-q', 'origin', `HEAD:${target.branch}`]);
  if (isolated.status === 0) return isolated;
  failures.push(describeFailure('isolated map-store push', isolated));
  if (process.env.STYLEPROOF_MAP_STORE_TOKEN) {
    const viaToken = pushWithWorkflowToken(checkout, target.branch);
    if (viaToken.status === 0) return viaToken;
    failures.push(describeFailure('workflow-token credential push', viaToken));
  }
  return pushViaConsumerCheckout(target, checkout, failures);
}

type PublishAttempt = {
  target: StoreTarget;
  sha: string;
  compatibilityKey: string;
  dir: string;
  includeHar: boolean;
  manifest: MapManifest;
  authenticationArguments: string[];
};

function publishMapStoreAttempt(options: PublishAttempt): { ok: boolean; phase: 'setup' | 'publish'; error: string } {
  const bundlePath = `${options.sha}/${options.compatibilityKey}`;
  let checkout: string | undefined;
  try {
    checkout = checkoutMapStore(options.target, { filter: 'blob:none', sparseSegment: options.sha });
    git(checkout, ['config', 'user.name', 'github-actions[bot]']);
    git(checkout, ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
    fs.writeFileSync(path.join(checkout, 'README.md'), MAP_STORE_README);
    const bundle = path.join(checkout, bundlePath);
    removeDirRecursive(bundle);
    copyDir(options.dir, bundle, options.includeHar);
    if (!options.includeHar) {
      fs.writeFileSync(path.join(bundle, MAP_MANIFEST), JSON.stringify({ ...options.manifest, har: false }, null, 2));
    }
    git(checkout, ['add', '-A', '--sparse', '--', 'README.md', bundlePath]);
    git(checkout, ['commit', '-q', '-m', mapPublishCommitMessage(options.sha, options.compatibilityKey)], 1 << 20);
    const push = pushMapStoreCommit(options.target, checkout, options.authenticationArguments);
    return { ok: push.status === 0, phase: 'publish', error: push.stderr.trim() || `git exited ${push.status}` };
  } catch (error) {
    return { ok: false, phase: 'setup', error: errorMessage(error) };
  } finally {
    removeTempWorkspace(checkout);
  }
}

export async function publishMapBundle(options: {
  dir: string;
  branch?: string;
  remote?: string;
  cwd?: string;
  includeHar?: boolean;
}): Promise<{ sha: string; compatibilityKey: string; branch: string }> {
  const target = storeTarget(options);
  const manifest = readMapManifest(options.dir);
  if (!manifest) throw new MapStorePreconditionError(`no ${MAP_MANIFEST} in ${options.dir}`);
  if (manifest.dirty) {
    throw new MapStorePreconditionError(
      `not uploading ${options.dir}: working tree was dirty when the map was captured. Commit first, then rerun styleproof-map.`,
    );
  }
  assertRemote(target);
  const sha = safeSegment(manifest.sha, 'sha');
  const compatibilityKey = safeSegment(manifest.compatibilityKey, 'compatibility key');
  const attempt: PublishAttempt = {
    target,
    sha,
    compatibilityKey,
    dir: options.dir,
    includeHar: options.includeHar === true,
    manifest,
    authenticationArguments: configArguments(effectiveGitHttpExtraHeaders(target.cwd)),
  };
  const outcome = retryBlocking(5, (number) => {
    const result = publishMapStoreAttempt(attempt);
    return result.ok ? { value: true } : { error: `attempt ${number} ${result.phase}:\n${result.error}` };
  });
  if ('failures' in outcome) throw new MapStoreError(outcome.failures.join('\n') || `could not push ${target.branch}`);
  return { sha, compatibilityKey, branch: target.branch };
}

export interface CachedCaptureDirs {
  beforeDir: string;
  afterDir: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  compatibilityKey: string;
  tmpRoot: string;
}

/** `miss` is an expected cache miss (never retried → NotFound); `infra` is a transient fault (retried). */
type RestoreAttempt = { status: 'hit'; manifest: MapManifest } | { status: 'miss' | 'infra'; message: string };

type RestoreRequest = StoreTarget & { sha: string; compatibilityKey?: string; outDir: string };

const miss = (message: string): RestoreAttempt => ({ status: 'miss', message });

function copyRestoredBundle(tmp: string, { sha, branch, compatibilityKey, outDir }: RestoreRequest): RestoreAttempt {
  const shaDir = path.join(tmp, sha);
  if (!fs.existsSync(shaDir)) return miss(`no cached map for ${sha} on ${branch}`);
  const candidates = fs
    .readdirSync(shaDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (!compatibilityKey || entry.name === compatibilityKey))
    .map((entry) => entry.name)
    .sort();
  if (!candidates.length) {
    const scope = compatibilityKey
      ? `map for ${sha} with compatibility ${compatibilityKey}`
      : `map bundle under ${sha}`;
    return miss(`no cached ${scope} on ${branch}`);
  }
  removeDirRecursive(outDir);
  copyDir(path.join(shaDir, candidates[0]), outDir, true);
  const manifest = readMapManifest(outDir);
  return manifest ? { status: 'hit', manifest } : miss(`cached map for ${sha} is missing ${MAP_MANIFEST}`);
}

/** One restore attempt: probe the branch, check out the one SHA's tree, copy the bundle. */
function restoreMapStoreAttempt(request: RestoreRequest): RestoreAttempt {
  let tmp: string;
  try {
    if (!lookupBranch(request)) return miss(`map store branch ${request.branch} does not exist`);
    // tree:0 keeps the clone to one exact-SHA subtree; an absent bundle surfaces as an empty tree.
    tmp = checkoutMapStore(request, { filter: 'tree:0', sparseSegment: request.sha, branchExists: true });
  } catch (error) {
    return { status: 'infra', message: errorMessage(error) };
  }
  try {
    return copyRestoredBundle(tmp, request);
  } finally {
    removeTempWorkspace(tmp);
  }
}

export function restoreMapBundle(options: {
  sha: string;
  outDir: string;
  branch?: string;
  remote?: string;
  cwd?: string;
  compatibilityKey?: string;
}): MapManifest {
  const target = storeTarget(options);
  const sha = safeSegment(options.sha, 'sha');
  const compatibilityKey = options.compatibilityKey && safeSegment(options.compatibilityKey, 'compatibility key');
  assertRemote(target);
  const attempts = mapStoreRestoreAttempts();
  const outcome = retryBlocking<MapManifest>(attempts, () => {
    const result = restoreMapStoreAttempt({
      ...target,
      sha,
      compatibilityKey: compatibilityKey || undefined,
      outDir: options.outDir,
    });
    if (result.status === 'hit') return { value: result.manifest };
    // A genuine miss is terminal — the cold path recaptures. Only infra faults retry.
    if (result.status === 'miss') throw new MapStoreNotFoundError(result.message);
    return { error: result.message };
  });
  if ('value' in outcome) return outcome.value;
  throw new MapStoreError(
    `could not restore ${sha} from ${target.branch} after ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}: ` +
      (outcome.failures.at(-1) || 'unknown map store error'),
  );
}

/** The commit SHAs with at least one stored bundle (the branch tip's top-level directories),
 *  via one `tree:0` no-checkout clone plus a root `ls-tree`. A missing branch is an EMPTY
 *  set; any network failure throws so the caller falls back rather than trust a partial listing. */
export function listMapStoreBundleShas(options: { branch?: string; remote?: string; cwd?: string } = {}): Set<string> {
  const target = storeTarget(options);
  assertRemote(target);
  if (!lookupBranch(target)) return new Set();
  const tmp = checkoutMapStore(target, { filter: 'tree:0', branchExists: true });
  try {
    const listing = networkGit(tmp, ['ls-tree', '--name-only', 'HEAD'], 1 << 20);
    if (listing.status !== 0) throw new MapStoreError(gitFailureMessage(listing, 'could not list map store bundles'));
    const names = listing.stdout.split('\n').map((name) => name.trim());
    return new Set(names.filter((name) => /^[0-9a-f]{7,40}$/i.test(name)));
  } finally {
    removeTempWorkspace(tmp);
  }
}

/** Restore the base and head bundles for a cached compare into a fresh temp root. The base
 *  key is computed from a detached base worktree so its spec/lockfile match what was published. */
export function resolveCachedCaptureDirs(options: {
  command: string;
  args: string[];
  spec: string;
  branch?: string;
  remote?: string;
  cwd?: string;
  baseUrl?: string;
  usage: string;
}): CachedCaptureDirs {
  const cwd = options.cwd ?? process.cwd();
  if (options.args.length > 1) throw new MapStoreError(options.usage);
  if (!fs.existsSync(path.resolve(cwd, options.spec))) {
    throw new MapStoreError(`${options.command}: no StyleProof spec at ${options.spec}`);
  }
  const baseRef = options.args[0] ?? inferBaseRef();
  const baseSha = gitStdout(cwd, ['rev-parse', `${baseRef}^{commit}`]);
  if (!baseSha) throw new MapStoreError(`could not resolve ${baseRef} to a commit`);
  const headSha = currentGitSha(cwd);
  const compatibilityKey = expectedCompatibilityKey({ cwd, spec: options.spec, baseUrl: options.baseUrl });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-cache-'));
  const dirs = { beforeDir: path.join(tmpRoot, 'base'), afterDir: path.join(tmpRoot, 'head') };
  const restore = (sha: string, outDir: string, key: string) =>
    restoreMapBundle({ sha, outDir, branch: options.branch, remote: options.remote, cwd, compatibilityKey: key });
  let worktrees: CiWorktreeSession | undefined;
  try {
    const repoRoot = gitRepoRoot(cwd);
    const consumerRel = consumerRelativeFromRepoRoot(repoRoot, cwd);
    worktrees = new CiWorktreeSession(repoRoot);
    const baseWorktree = worktrees.addDetached(baseSha, 'cache-base');
    const baseCwd = worktreeRunCwd(baseWorktree, consumerRel);
    restore(
      baseSha,
      dirs.beforeDir,
      expectedCompatibilityKey({ cwd: baseCwd, spec: options.spec, baseUrl: options.baseUrl }),
    );
    restore(headSha, dirs.afterDir, compatibilityKey);
    return { ...dirs, baseRef, baseSha, headSha, compatibilityKey, tmpRoot };
  } catch (error) {
    removeTempWorkspace(tmpRoot);
    throw error;
  } finally {
    worktrees?.dispose();
  }
}

export function cleanupCachedCaptureDirs(captureDirs: CachedCaptureDirs | null): void {
  if (captureDirs) removeTempWorkspace(captureDirs.tmpRoot);
}
