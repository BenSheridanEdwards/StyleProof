// Git plumbing for the map store: the hook-safe git environment, bounded network git,
// http.extraheader credential discovery, temporary checkouts, and blocking retries.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitOutput, removeDirRecursive, runGit } from '../node-util.js';
import { DEFAULT_MAP_STORE_BRANCH, DEFAULT_REMOTE, MapStoreError } from './bundle.js';

export type GitResult = SpawnSyncReturns<string>;

/** Hook-exported repository variables would redirect every spawned git at the caller's repo. */
const GIT_REPOSITORY_ENVIRONMENT_VARIABLES = (
  'GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_DIR GIT_GRAFT_FILE GIT_INDEX_FILE GIT_INTERNAL_SUPER_PREFIX ' +
  'GIT_OBJECT_DIRECTORY GIT_PREFIX GIT_REPLACE_REF_BASE GIT_SHALLOW_FILE GIT_WORK_TREE'
).split(' ');

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of GIT_REPOSITORY_ENVIRONMENT_VARIABLES) delete environment[name];
  return environment;
}

export const git = (cwd: string, args: string[], maxBuffer?: number): GitResult =>
  runGit(cwd, args, { maxBuffer, env: gitEnvironment() });

export const gitStdout = (cwd: string, args: string[]): string => gitOutput(cwd, args, gitEnvironment());

/** Default git operation timeout for map-store operations (120s). Exported for test assertions. */
export const DEFAULT_MAP_STORE_GIT_TIMEOUT_MILLISECONDS = 120_000;

/** A git call that may touch the network: bounded by the timeout and never prompts. */
export function networkGit(cwd: string, args: string[], maxBuffer = 1 << 20): GitResult {
  const configured = Number(process.env.STYLEPROOF_MAP_STORE_GIT_TIMEOUT_MS);
  const timeout =
    Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_MAP_STORE_GIT_TIMEOUT_MILLISECONDS;
  const env = { ...gitEnvironment(), GIT_TERMINAL_PROMPT: '0' };
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer, timeout, env });
}

export function gitFailureMessage(result: GitResult, fallback: string): string {
  const standardError = typeof result.stderr === 'string' ? result.stderr.trim() : '';
  return standardError || result.error?.message || fallback;
}

/** Restore retries an INFRASTRUCTURE fault this many times; a genuine miss is never retried.
 *  Overridable via `STYLEPROOF_MAP_STORE_RESTORE_ATTEMPTS` (tests pin it to 1). */
export function mapStoreRestoreAttempts(): number {
  const configured = Number(process.env.STYLEPROOF_MAP_STORE_RESTORE_ATTEMPTS);
  return Number.isInteger(configured) && configured > 0 ? configured : 3;
}

/** Retry a store operation with a blocking `attempt * 250ms` backoff between tries — these
 *  are short-lived CLI processes with nothing else to do while git recovers. */
export function retryBlocking<T>(
  attempts: number,
  run: (attempt: number) => { value: T } | { error: string },
): { value: T } | { failures: string[] } {
  const failures: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const outcome = run(attempt);
    if ('value' in outcome) return outcome;
    failures.push(outcome.error);
    if (attempt < attempts) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 250);
  }
  return { failures };
}

const WORKFLOW_TOKEN_CREDENTIAL_HELPER =
  '!f() { if [ "$1" = get ]; then printf \'%s\\n\' username=x-access-token "password=$STYLEPROOF_MAP_STORE_TOKEN"; fi; }; f';

export const workflowTokenCredentialArguments = (): string[] => [
  '-c',
  'credential.helper=',
  '-c',
  `credential.helper=${WORKFLOW_TOKEN_CREDENTIAL_HELPER}`,
];

export const GITHUB_EXTRA_HEADER_KEY = ['http.https:', '', 'github.com', '.extraheader'].join('/');

export type GitHttpExtraHeader = { key: string; value: string };

/** `key value` lines from `git config --get-regexp`. */
function configPairs(stdout: string): GitHttpExtraHeader[] {
  return stdout
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const separator = line.indexOf(' ');
      return separator === -1 ? [] : [{ key: line.slice(0, separator), value: line.slice(separator + 1) }];
    });
}

const EXTRA_HEADER_PATTERN = '^http\\..*\\.extraheader$';

function configuredExtraHeaders(cwd: string): GitHttpExtraHeader[] {
  const direct = configPairs(git(cwd, ['config', '--includes', '--get-regexp', EXTRA_HEADER_PATTERN], 1 << 20).stdout);
  if (direct.length > 0) return direct;
  const includes = configPairs(
    git(cwd, ['config', '--local', '--get-regexp', '^includeIf\\..*\\.path$'], 1 << 20).stdout,
  );
  return includes.flatMap(({ value }) =>
    configPairs(git(cwd, ['config', '--file', value, '--get-regexp', EXTRA_HEADER_PATTERN], 1 << 20).stdout),
  );
}

/** The auth headers a map-store git must carry: the workflow token when set, else the
 *  checkout's `http.*.extraheader` (following conditional includes). Each key's first
 *  occurrence is preceded by an empty reset so inherited values never stack. */
export function effectiveGitHttpExtraHeaders(cwd: string): GitHttpExtraHeader[] {
  const token = process.env.STYLEPROOF_MAP_STORE_TOKEN;
  if (token) {
    const value = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    return [
      { key: GITHUB_EXTRA_HEADER_KEY, value: '' },
      { key: GITHUB_EXTRA_HEADER_KEY, value },
    ];
  }
  const seen = new Set<string>();
  return configuredExtraHeaders(cwd).flatMap((header) => {
    if (seen.has(header.key)) return [header];
    seen.add(header.key);
    return header.value === '' ? [header] : [{ key: header.key, value: '' }, header];
  });
}

export const configArguments = (headers: GitHttpExtraHeader[]): string[] =>
  headers.flatMap(({ key, value }) => ['-c', `${key}=${value}`]);

export type StoreTarget = { cwd: string; branch: string; remote: string };

export function storeTarget(options: { cwd?: string; branch?: string; remote?: string }): StoreTarget {
  return {
    cwd: options.cwd ?? process.cwd(),
    branch: options.branch ?? DEFAULT_MAP_STORE_BRANCH,
    remote: options.remote ?? DEFAULT_REMOTE,
  };
}

export function assertRemote({ cwd, remote }: StoreTarget): void {
  if (git(cwd, ['remote', 'get-url', remote], 1 << 20).status !== 0) {
    throw new MapStoreError(`git remote ${remote} was not found`);
  }
}

/** Whether the store branch exists on the remote. `--exit-code` 2 is a true miss; any other
 *  failure is infrastructure and throws, so a network blip never reads as "no branch". */
export function lookupBranch({ cwd, remote, branch }: StoreTarget): boolean {
  const lookup = networkGit(cwd, ['ls-remote', '--exit-code', '--heads', remote, branch], 1 << 20);
  if (lookup.status === 0) return true;
  if (lookup.status === 2) return false;
  throw new MapStoreError(gitFailureMessage(lookup, 'could not query map store branch'));
}

export function safeSegment(value: string, name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new MapStoreError(`${name} contains unsupported characters: ${value}`);
  return value;
}

export function copyDir(src: string, dest: string, includeHar: boolean): void {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true, filter: (source) => includeHar || !source.endsWith('.har') });
}

/** Best-effort removal of a throwaway `os.tmpdir()` workspace: a residual ENOTEMPTY must
 *  never turn a successful publish or restore into a failure. */
export function removeTempWorkspace(dir: string | undefined): void {
  if (!dir) return;
  try {
    removeDirRecursive(dir);
  } catch {
    // Disposable scratch dir — leave it for the OS / CI reaper.
  }
}

function checkoutSparseSegment(tmp: string, branch: string, segment: string): void {
  const sparse = git(tmp, ['sparse-checkout', 'set', segment], 1 << 20);
  const checkout = sparse.status === 0 ? git(tmp, ['checkout', '-q', branch], 1 << 20) : sparse;
  if (checkout.status !== 0)
    throw new MapStoreError(checkout.stderr.trim() || `could not check out ${segment} from map store`);
}

/** A temporary clone of the store branch (or a fresh repository when the branch does not
 *  exist yet). With `filter`, a no-checkout partial clone; with `sparseSegment`, only that
 *  top-level directory is checked out. The caller removes the returned directory. */
export function checkoutMapStore(
  target: StoreTarget,
  options: { filter?: string; sparseSegment?: string; branchExists?: boolean } = {},
): string {
  const { cwd, remote, branch } = target;
  assertRemote(target);
  const remoteUrl = gitStdout(cwd, ['remote', 'get-url', remote]);
  const headers = effectiveGitHttpExtraHeaders(cwd);
  const branchExists = options.branchExists ?? lookupBranch(target);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-map-store-'));
  try {
    if (branchExists) {
      const shape = options.filter ? `--filter=${options.filter} --no-checkout --depth 1 --single-branch` : '--depth 1';
      const clone = networkGit(cwd, [
        ...configArguments(headers),
        'clone',
        '-q',
        ...shape.split(' '),
        '--branch',
        branch,
        remoteUrl,
        tmp,
      ]);
      if (clone.status !== 0) throw new MapStoreError(gitFailureMessage(clone, 'could not clone map store branch'));
    } else {
      git(tmp, ['init', '-q', '-b', branch]);
      git(tmp, ['remote', 'add', 'origin', remoteUrl]);
    }
    // Lazy fetches go back through the promisor remote, so the clone must carry the same auth.
    for (const { key, value } of headers) git(tmp, ['config', '--local', '--add', key, value]);
    if (options.sparseSegment && branchExists) checkoutSparseSegment(tmp, branch, options.sparseSegment);
    return tmp;
  } catch (error) {
    removeTempWorkspace(tmp);
    throw error;
  }
}
