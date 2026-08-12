/**
 * Nearest-ancestor baseline reuse — the CONSERVATIVE first step of issue #367.
 *
 * The map store keys bundles by whole-tree commit SHA, so every base-branch
 * merge is a full base-side cache miss even when the merge touched nothing a
 * capture renders (docs, CI config, unrelated packages). On a merge train that
 * cost is the steady state: every PR pays a double full capture.
 *
 * This module decides, on a base cache miss for commit B, whether the maps
 * stored for the NEAREST first-parent ancestor A of B may serve as B's
 * baseline: only when NONE of the paths changed between A and B is
 * capture-relevant. The rule is deliberately coarse (bundle-level, not
 * per-surface) and every uncertainty resolves to a full capture:
 *
 *   - no ancestor with a stored bundle inside the bounded walk → capture;
 *   - any changed path under a declared app source root, under the capture
 *     spec's directory, a `styleproof.config.json`, or a package
 *     manifest/lockfile → capture;
 *   - NO app source roots declared → every changed path counts as relevant
 *     (reuse then only fires on an empty diff) — opting in without declaring
 *     roots must never widen reuse;
 *   - any git failure (shallow clone, unknown SHA, no repo) → capture.
 *
 * Reuse never launders provenance: the ancestor bundle is restored byte-for-
 * byte (its manifest still names A), and the caller records a
 * {@link import('./map-store.js').BaselineProvenance} sidecar so the report
 * and diff JSON state the reuse and its proof (the changed-path count).
 *
 * Path matching reuses {@link canonicalPath} from the affected-surfaces module
 * so a `./`-prefixed or `//`-collapsed spelling can never dodge the gate.
 */
import { spawnSync } from 'node:child_process';
import { canonicalPath } from './affected-surfaces.js';

/** A readable failure walking ancestors or diffing trees. Callers treat any
 *  throw from this module as "fall back to a full capture", never as fatal. */
export class AncestorBaselineError extends Error {}

/** How many first-parent ancestors of the requested commit the walk considers. */
export const DEFAULT_ANCESTOR_WALK_LIMIT = 50;

const STYLEPROOF_CONFIG_FILE_NAME = 'styleproof.config.json';

/** Package manifests and lockfiles: a change to any of them (at any depth — a
 *  monorepo subpackage's included) can change what the app renders with, and
 *  the compatibility key only binds the ROOT lockfile. Always relevant. */
const PACKAGE_MANIFEST_FILE_NAMES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]);

function runGit(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
}

function gitLines(cwd: string, args: string[], what: string): string[] {
  const result = runGit(cwd, args);
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim() || result.error?.message || `git exited ${result.status}`;
    throw new AncestorBaselineError(`${what} failed: ${detail}`);
  }
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

/** First-parent ancestors of `sha`, nearest first, excluding `sha` itself,
 *  bounded to `limit`. A shallow history simply yields fewer ancestors; a git
 *  failure (unknown SHA, not a repository) throws {@link AncestorBaselineError}. */
export function listFirstParentAncestors(options: { sha: string; cwd: string; limit?: number }): string[] {
  const limit = options.limit ?? DEFAULT_ANCESTOR_WALK_LIMIT;
  const revisions = gitLines(
    options.cwd,
    ['rev-list', '--first-parent', `--max-count=${limit + 1}`, options.sha],
    `rev-list --first-parent ${options.sha}`,
  );
  // The first line is `sha` itself (as a full SHA) — the walk wants ancestors only.
  return revisions.slice(1);
}

/** Paths changed between two commits' TREES (`git diff --name-only A B`). */
export function changedPathsBetween(options: { ancestorSha: string; sha: string; cwd: string }): string[] {
  return gitLines(
    options.cwd,
    ['diff', '--name-only', options.ancestorSha, options.sha],
    `git diff --name-only ${options.ancestorSha.slice(0, 12)} ${options.sha.slice(0, 12)}`,
  );
}

function isSameOrUnderDirectory(candidate: string, directory: string): boolean {
  return directory !== '' && (candidate === directory || candidate.startsWith(`${directory}/`));
}

/**
 * The subset of `changedPaths` that is capture-relevant, conservatively:
 * the capture spec and anything in its directory (colocated harness files),
 * any `styleproof.config.json`, any package manifest/lockfile, and anything
 * under a declared app source root. With NO source roots declared — or a root
 * that canonicalizes to the repo root — every changed path is relevant, so
 * reuse can never fire on an undeclared app layout. Pure and fs-free.
 */
export function captureRelevantChangedPaths(options: {
  changedPaths: readonly string[];
  spec: string;
  sourceRoots: readonly string[];
}): string[] {
  const spec = canonicalPath(options.spec);
  const specDirectory = spec.includes('/') ? spec.slice(0, spec.lastIndexOf('/')) : '';
  const sourceRoots = options.sourceRoots.map((root) => canonicalPath(root));
  // Fail closed: no roots (or a root meaning "the whole repo") bounds nothing.
  if (sourceRoots.length === 0 || sourceRoots.some((root) => root === '')) return [...options.changedPaths];
  return options.changedPaths.filter((originalPath) => {
    const changed = canonicalPath(originalPath);
    const baseName = changed.includes('/') ? changed.slice(changed.lastIndexOf('/') + 1) : changed;
    if (baseName === STYLEPROOF_CONFIG_FILE_NAME) return true;
    if (PACKAGE_MANIFEST_FILE_NAMES.has(baseName)) return true;
    if (changed === spec || isSameOrUnderDirectory(changed, specDirectory)) return true;
    return sourceRoots.some((root) => isSameOrUnderDirectory(changed, root));
  });
}

/** The verdict of {@link planAncestorBaselineReuse}: reuse names the ancestor
 *  and carries the no-relevant-changes proof; capture names the reason. */
export type AncestorBaselineReusePlan =
  | { decision: 'reuse'; ancestorSha: string; ancestorDepth: number; changedPathCount: number }
  | { decision: 'capture'; reason: string };

/**
 * Decide whether the nearest stored-ancestor bundle may serve as the requested
 * commit's baseline. FAIL-SAFE BY CONTRACT: any error in the walk or the diff
 * returns a `capture` verdict with the failure as its reason — this function
 * never throws and never returns a reuse verdict it could not prove.
 */
export function planAncestorBaselineReuse(options: {
  requestedSha: string;
  /** Commit SHAs that have a stored bundle (top-level dirs of the map store branch). */
  availableShas: ReadonlySet<string>;
  spec: string;
  sourceRoots: readonly string[];
  cwd: string;
  limit?: number;
}): AncestorBaselineReusePlan {
  try {
    const ancestors = listFirstParentAncestors({ sha: options.requestedSha, cwd: options.cwd, limit: options.limit });
    const nearestStoredIndex = ancestors.findIndex((ancestorSha) => options.availableShas.has(ancestorSha));
    if (nearestStoredIndex === -1) {
      return {
        decision: 'capture',
        reason: `no stored bundle among the ${ancestors.length} nearest first-parent ancestor(s)`,
      };
    }
    const ancestorSha = ancestors[nearestStoredIndex];
    const changedPaths = changedPathsBetween({ ancestorSha, sha: options.requestedSha, cwd: options.cwd });
    const relevantPaths = captureRelevantChangedPaths({
      changedPaths,
      spec: options.spec,
      sourceRoots: options.sourceRoots,
    });
    if (relevantPaths.length > 0) {
      return {
        decision: 'capture',
        reason:
          `${relevantPaths.length} of ${changedPaths.length} path(s) changed since ancestor ` +
          `${ancestorSha.slice(0, 12)} are capture-relevant (first: ${relevantPaths[0]})`,
      };
    }
    return {
      decision: 'reuse',
      ancestorSha,
      ancestorDepth: nearestStoredIndex + 1,
      changedPathCount: changedPaths.length,
    };
  } catch (error) {
    return { decision: 'capture', reason: error instanceof Error ? error.message : String(error) };
  }
}
