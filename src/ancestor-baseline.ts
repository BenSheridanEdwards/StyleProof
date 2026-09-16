// Nearest-ancestor baseline reuse. On a base cache miss for commit B, the maps stored for
// the nearest first-parent ancestor A may serve as B's baseline only when NONE of the
// paths changed between A and B is capture-relevant. Every uncertainty (no stored
// ancestor, no declared source roots, any git failure) resolves to a full capture, and
// reuse never launders provenance: the caller records a BaselineProvenance sidecar.
import { runGit } from './node-util.js';
import { canonicalPath } from './affected-surfaces.js';

/** Callers treat any throw from this module as "fall back to a full capture", never as fatal. */
export class AncestorBaselineError extends Error {}

/** How many first-parent ancestors of the requested commit the walk considers. */
export const DEFAULT_ANCESTOR_WALK_LIMIT = 50;

/** File names that are relevant at any depth: harness configs plus package manifests and
 *  lockfiles (the compatibility key binds only the ROOT lockfile). */
const ALWAYS_RELEVANT_FILE_NAMES = new Set([
  'styleproof.config.json',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]);
const CAPTURE_PLAYWRIGHT_CONFIG_FILE_NAME = /^playwright(?:\.styleproof)?\.config\.[cm]?[jt]s$/;

function gitLines(cwd: string, args: string[], what: string): string[] {
  const result = runGit(cwd, args);
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim() || result.error?.message || `git exited ${result.status}`;
    throw new AncestorBaselineError(`${what} failed: ${detail}`);
  }
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

/** First-parent ancestors of `sha`, nearest first, excluding `sha` itself, bounded to `limit`. */
export function listFirstParentAncestors(options: { sha: string; cwd: string; limit?: number }): string[] {
  const limit = options.limit ?? DEFAULT_ANCESTOR_WALK_LIMIT;
  const revisions = gitLines(
    options.cwd,
    ['rev-list', '--first-parent', `--max-count=${limit + 1}`, options.sha],
    `rev-list --first-parent ${options.sha}`,
  );
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

const baseName = (canonical: string): string => canonical.slice(canonical.lastIndexOf('/') + 1);

/** The capture-relevant subset of `changedPaths`: the spec and its directory, the Playwright
 *  capture config, `styleproof.config.json`, package manifests/lockfiles, and anything under
 *  a declared source root. With NO roots (or a root meaning the whole repo) every path is
 *  relevant, so reuse can never fire on an undeclared app layout. Pure and fs-free. */
export function captureRelevantChangedPaths(options: {
  changedPaths: readonly string[];
  spec: string;
  sourceRoots: readonly string[];
}): string[] {
  const spec = canonicalPath(options.spec);
  const specDirectory = spec.includes('/') ? spec.slice(0, spec.lastIndexOf('/')) : '';
  const sourceRoots = options.sourceRoots.map((root) => canonicalPath(root));
  if (sourceRoots.length === 0 || sourceRoots.some((root) => root === '')) return [...options.changedPaths];
  return options.changedPaths.filter((originalPath) => {
    const changed = canonicalPath(originalPath);
    const name = baseName(changed);
    return (
      ALWAYS_RELEVANT_FILE_NAMES.has(name) ||
      CAPTURE_PLAYWRIGHT_CONFIG_FILE_NAME.test(name) ||
      changed === spec ||
      isSameOrUnderDirectory(changed, specDirectory) ||
      sourceRoots.some((root) => isSameOrUnderDirectory(changed, root))
    );
  });
}

/** Reuse names the ancestor and carries the no-relevant-changes proof; capture names the reason. */
export type AncestorBaselineReusePlan =
  | { decision: 'reuse'; ancestorSha: string; ancestorDepth: number; changedPathCount: number }
  | { decision: 'capture'; reason: string };

/** Decide whether the nearest stored-ancestor bundle may serve as the requested commit's
 *  baseline. FAIL-SAFE: any error returns a `capture` verdict; this never throws. */
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
