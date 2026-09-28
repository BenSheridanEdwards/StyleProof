// Positive evidence that a head-only surface was never declared on the base commit.
//
// With a spec overlay (`styleproof-ci --spec-ref <head>`) the base side runs the HEAD
// capture harness against BASE application code, so a surface the pull request adds
// is attempted on base and usually fails there (its route or test id does not exist
// yet). That failure is not baseline repair debt: the base never declared the surface.
//
// A failed base capture alone is never evidence. A ledger entry is set aside only when
// git proves all of: the head harness declares the key literally (`key: '<name>'`),
// the base harness does not mention the name at all, and the head captured it. The
// harness is located in the head tree and bound to the head manifest's `specHash`, so
// the check works from any directory of the repository (the Action runs at the root
// even when the capture ran in a package directory). Any missing input, ambiguity, or
// git error keeps the entry in the ledger (fail closed).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { SurfaceCaptureFailure } from './bundle.js';
import { readMapManifest } from './manifest.js';
import { runGit, sha256 } from '../node-util.js';

const FULL_SHA = /^[0-9a-f]{40}$/;
/** Keys we can search for literally: a bounded name plus a numeric width (never `@auto`). */
const WIDTH_KEY = /^([a-z0-9][a-z0-9._-]{0,199})@[1-9]\d{1,4}$/;
const GIT_TIMEOUT_MS = 60_000;

export type BaselineFailureEvidence = {
  /** Capture failure ledger read from the base bundle manifest. */
  failures: readonly SurfaceCaptureFailure[];
  baseSha?: string;
  headSha?: string;
  /** Spec path recorded by each side's manifest (relative to the capture directory). */
  baseSpec?: string;
  headSpec?: string;
  /** sha256 of the spec bytes the head capture ran (head manifest `specHash`). */
  headSpecHash?: string;
  /** Capture keys present in the head bundle. */
  headKeys: ReadonlySet<string>;
  /** Any directory inside the consumer repository. Defaults to `process.cwd()`. */
  cwd?: string;
};

export type BaselineFailurePartition = {
  /** Entries that still count as baseline capture failures. */
  failures: SurfaceCaptureFailure[];
  /** Keys set aside because the base commit never declared the surface (sorted). */
  undeclaredOnBase: string[];
};

/** `git grep -q` outcome: true = match, false = no match, null = git could not answer. */
function gitGrepMatches(cwd: string, args: string[], sha: string, scope: string): boolean | null {
  const result = runGit(cwd, ['grep', '-q', ...args, sha, '--', scope], {
    // Never reach the network from the trusted report job: a missing blob is an error.
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' },
    timeout: GIT_TIMEOUT_MS,
  });
  if (result.status === 0) return true;
  if (result.status === 1 && !result.error) return false;
  return null;
}

const blobHash = (top: string, sha: string, file: string): string | null => {
  const r = spawnSync('git', ['cat-file', 'blob', `${sha}:${file}`], {
    cwd: top,
    maxBuffer: 1 << 28,
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
  });
  return r.status === 0 && r.stdout ? sha256(r.stdout) : null;
};

/** The harness the spec overlay swaps, as a repository-root path: the spec's directory,
 *  or just the spec when it sits at the capture root. The spec is found in the head tree
 *  by its capture-relative path and must hash to the head manifest's `specHash`. */
function locateHarness(top: string, headSha: string, spec: string, specHash: string): string | null {
  const normalized = spec.replace(/\\/g, '/');
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) return null;
  const listed = runGit(top, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', headSha], {
    timeout: GIT_TIMEOUT_MS,
  });
  if (listed.status !== 0) return null;
  const matches = listed.stdout
    .split('\0')
    .filter((file) => file === normalized || file.endsWith(`/${normalized}`))
    .filter((file) => blobHash(top, headSha, file) === specHash);
  if (matches.length !== 1) return null;
  const located = matches[0];
  return path.posix.dirname(normalized) === '.' ? located : path.posix.dirname(located);
}

const declaredKeyPattern = (name: string): string =>
  `key[[:space:]]*:[[:space:]]*["'\`]${name.replace(/\./g, '\\.')}["'\`]`;

function gitTopLevel(cwd: string): string | null {
  const r = runGit(cwd, ['rev-parse', '--show-toplevel'], { timeout: GIT_TIMEOUT_MS });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** Split the base failure ledger into real failures and surfaces the base never declared. */
export function partitionBaselineFailures(input: BaselineFailureEvidence): BaselineFailurePartition {
  const keep = (): BaselineFailurePartition => ({ failures: [...input.failures], undeclaredOnBase: [] });
  if (input.failures.length === 0) return keep();
  const { baseSha, headSha, baseSpec, headSpec, headSpecHash } = input;
  if (!baseSha || !headSha || !FULL_SHA.test(baseSha) || !FULL_SHA.test(headSha) || baseSha === headSha) return keep();
  if (!baseSpec || baseSpec !== headSpec || !headSpecHash) return keep();
  const top = gitTopLevel(input.cwd ?? process.cwd());
  if (!top) return keep();
  const located = locateHarness(top, headSha, baseSpec, headSpecHash);
  if (!located) return keep();
  // `:(top)` keeps the pathspec repository-rooted whatever directory git runs in.
  const scope = `:(top)${located}`;
  const cwd = top;

  const verdicts = new Map<string, boolean>();
  const undeclared = (name: string): boolean => {
    const cached = verdicts.get(name);
    if (cached !== undefined) return cached;
    const verdict =
      gitGrepMatches(cwd, ['-E', '-e', declaredKeyPattern(name)], headSha, scope) === true &&
      gitGrepMatches(cwd, ['-F', '-e', name], baseSha, scope) === false;
    verdicts.set(name, verdict);
    return verdict;
  };

  const failures: SurfaceCaptureFailure[] = [];
  const undeclaredOnBase: string[] = [];
  for (const failure of input.failures) {
    const name = WIDTH_KEY.exec(failure.key)?.[1];
    if (name && input.headKeys.has(failure.key) && undeclared(name)) undeclaredOnBase.push(failure.key);
    else failures.push(failure);
  }
  return { failures, undeclaredOnBase: undeclaredOnBase.sort((a, b) => a.localeCompare(b)) };
}

/** Read the base bundle's failure ledger and set aside surfaces the base never declared. */
export function readBaselineFailureLedger(
  beforeDir: string,
  afterDir: string,
  headKeys: ReadonlySet<string>,
): BaselineFailurePartition & { sha?: string } {
  const base = readMapManifest(beforeDir);
  const failures = base?.surfaceCaptureFailures ?? [];
  if (failures.length === 0) return { failures: [], undeclaredOnBase: [], sha: base?.sha };
  const head = readMapManifest(afterDir);
  return {
    ...partitionBaselineFailures({
      failures,
      baseSha: base?.sha,
      headSha: head?.sha,
      baseSpec: base?.spec,
      headSpec: head?.spec,
      headSpecHash: head?.specHash,
      headKeys,
    }),
    sha: base?.sha,
  };
}
