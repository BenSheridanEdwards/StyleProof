import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { CiWorktreeSession, consumerRelativeFromRepoRoot, gitRepoRoot, worktreeRunCwd } from './ci-worktree.js';
import { inferBaseRef } from './gitref.js';
import { realNow } from './spec-clock.js';
import { COVERAGE_LEDGER } from './coverage.js';
import { readRegularFileNoFollow } from './safe-filesystem.js';

export const DEFAULT_MAP_DIR = '.styleproof/maps';
export const DEFAULT_MAP_LABEL = 'current';
export const DEFAULT_MAP_STORE_BRANCH = 'styleproof-maps';
export const DEFAULT_REMOTE = 'origin';
export const MAP_MANIFEST = 'styleproof-manifest.json';
/** Per-surface capture failures recorded when baseline-only tolerate mode is on. */
export const SURFACE_CAPTURE_FAILURES_DIR = 'styleproof-surface-capture-failures';
/** Run-level marker proving that capture hit a fatal determinism/self-check failure. */
export const FATAL_CAPTURE_MARKER = 'styleproof-fatal-capture.flag';

export type SurfaceCaptureFailure = {
  /** Capture key (`<surface>@<width>` or crawl label). */
  key: string;
  /** Local diagnostic detail. Never publish this raw value. */
  reason: string;
  /** `self-check` failures are never tolerated and should not appear here. */
  kind?: 'capture';
};

/** Public, bounded failure receipt shared by diff JSON, report JSON, and Markdown. */
export type BaselineFailureReceipt = {
  key: string;
  reason: 'capture_failed';
};

const PUBLIC_CAPTURE_FAILURE_KEY = /^[a-z0-9][a-z0-9._-]{0,199}@(auto|[1-9]\d{1,4})$/;

/** Convert private capture diagnostics into stable public receipts without exception text. */
export function baselineFailureReceipts(failures: readonly SurfaceCaptureFailure[]): BaselineFailureReceipt[] {
  return failures.map((failure) => ({
    key: PUBLIC_CAPTURE_FAILURE_KEY.test(failure.key)
      ? failure.key
      : `capture-${createHash('sha256').update(failure.key).digest('hex').slice(0, 12)}`,
    reason: 'capture_failed',
  }));
}
/** Sidecar written during a capture run (where a browser handle is in scope) recording
 *  the real browser build (`browser().version()`). `writeMapManifest` runs after Playwright
 *  has exited — no browser — so it reads the build back from here. Not a surface map. */
export const BROWSER_BUILD_SIDECAR = 'styleproof-browser.json';
const GENERATED_DIRTY_ALLOWLIST = new Set(['next-env.d.ts']);
const GIT_REPOSITORY_ENVIRONMENT_VARIABLES = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_INTERNAL_SUPER_PREFIX',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
] as const;

/** Sidecar recording where a run's BASELINE maps came from — restored from the
 *  exact base SHA, restored from a nearest ancestor (with the no-relevant-changes
 *  proof), or captured fresh (#367: reuse must never be silent). Written locally
 *  by the CI driver into its base dir; never a surface map. */
export const BASELINE_PROVENANCE_FILE = 'styleproof-baseline-provenance.json';

/** The confidence ledger (#399) — per-surface trust statuses bundled with the
 *  maps. Defined here (not in confidence-ledger.ts, its owning module, which
 *  re-exports it) so {@link RESERVED_BUNDLE_FILES} needs no import cycle. */
export const CONFIDENCE_LEDGER = 'styleproof-confidence.json';

/** Bundle files that sit alongside the maps but are NOT surfaces (manifest, coverage
 *  ledger, and any future sidecar). Every place that enumerates surface maps must skip
 *  these, or a sidecar reads as a phantom "new surface". */
export const RESERVED_BUNDLE_FILES: ReadonlySet<string> = new Set([
  MAP_MANIFEST,
  COVERAGE_LEDGER,
  BROWSER_BUILD_SIDECAR,
  BASELINE_PROVENANCE_FILE,
  CONFIDENCE_LEDGER,
]);

/** True for a captured surface map (`<key>@<width>.json[.gz]`), false for metadata. */
export function isMapFile(name: string): boolean {
  return !RESERVED_BUNDLE_FILES.has(name) && /\.json(\.gz)?$/.test(name);
}

/** Canonical byte identity for every regular artifact consumed from one capture directory. */
export type CaptureEvidenceReceipt = {
  algorithm: 'sha256';
  digest: string;
  fileCount: number;
  mapCount: number;
  byteCount: number;
};

export const MAX_MAP_MANIFEST_BYTES = 16_777_216;
export const MAX_CAPTURE_EVIDENCE_FILES = 100_000;
export const MAX_CAPTURE_EVIDENCE_FILE_BYTES = 16 * 1024 * 1024;
// Large suites retain screenshots alongside computed-style maps. Keep the
// aggregate finite while allowing the existing per-file and file-count bounds
// to compose into a useful evidence bundle.
export const MAX_CAPTURE_EVIDENCE_TOTAL_BYTES = 512 * 1024 * 1024;

function unsafeCaptureEvidence(): never {
  throw new MapStoreError('unsafe capture evidence — expected a bounded tree of regular files');
}

/** Hash a complete capture directory with unambiguous path/content framing.
 * Every entry is read no-follow and the sorted relative path is part of the hash. */
export function captureEvidenceReceipt(dir: string): CaptureEvidenceReceipt {
  const files: string[] = [];
  const visit = (directory: string, prefix = ''): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs
        .readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    } catch {
      return unsafeCaptureEvidence();
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) unsafeCaptureEvidence();
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) files.push(relative);
      else unsafeCaptureEvidence();
      if (files.length > MAX_CAPTURE_EVIDENCE_FILES) unsafeCaptureEvidence();
    }
  };
  visit(dir);
  files.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  const hash = createHash('sha256').update('styleproof-capture-evidence-v1\0');
  let byteCount = 0;
  let mapCount = 0;
  for (const relative of files) {
    let bytes: Buffer;
    try {
      bytes = readRegularFileNoFollow(path.join(dir, ...relative.split('/')), MAX_CAPTURE_EVIDENCE_FILE_BYTES);
    } catch {
      return unsafeCaptureEvidence();
    }
    byteCount += bytes.length;
    if (!Number.isSafeInteger(byteCount) || byteCount > MAX_CAPTURE_EVIDENCE_TOTAL_BYTES) unsafeCaptureEvidence();
    if (!relative.includes('/') && isMapFile(relative)) mapCount++;
    const relativeBytes = Buffer.from(relative, 'utf8');
    hash.update(`${relativeBytes.length}:`).update(relativeBytes).update(`${bytes.length}:`).update(bytes);
  }
  return { algorithm: 'sha256', digest: hash.digest('hex'), fileCount: files.length, mapCount, byteCount };
}

export type CaptureEvidenceBindingReceipt = {
  version: 1;
  before: CaptureEvidenceReceipt;
  after: CaptureEvidenceReceipt;
};

export function captureEvidenceBindingReceipt(beforeDir: string, afterDir: string): CaptureEvidenceBindingReceipt {
  return { version: 1, before: captureEvidenceReceipt(beforeDir), after: captureEvidenceReceipt(afterDir) };
}

const CRAWL_BUNDLE_FILES = new Set([...RESERVED_BUNDLE_FILES, FATAL_CAPTURE_MARKER]);
const GENERATED_CAPTURE_ARTIFACT = /@\d+\.(?:json(?:\.gz)?|png|(?:hover|focus|active)\.png)$/;
const SURFACE_CAPTURE_FAILURE_ARTIFACT = /^[a-zA-Z0-9@._-]+-[0-9a-f]{8}\.json$/;

/** True when a top-level entry is owned by StyleProof capture generation. */
export function isOwnedCaptureArtifact(name: string): boolean {
  return CRAWL_BUNDLE_FILES.has(name) || name === SURFACE_CAPTURE_FAILURES_DIR || GENERATED_CAPTURE_ARTIFACT.test(name);
}

/** True when a flat failure receipt name could have been emitted by StyleProof. */
export function isSurfaceCaptureFailureArtifact(name: string): boolean {
  return SURFACE_CAPTURE_FAILURE_ARTIFACT.test(name);
}

/** Clear only artifacts that a crawl owns when refreshing a reused output directory.
 * Generated sidecars and the `<surface>@<width>` namespace are reserved StyleProof output;
 * unrelated names are preserved. Preflight before removal so malformed state cannot
 * leave a half-cleared bundle. */
export function clearCaptureOutput(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const candidates = fs.readdirSync(dir).filter((name) => isOwnedCaptureArtifact(name));
  const classified = candidates.map((name) => {
    const target = path.join(dir, name);
    const stat = fs.lstatSync(target);
    if (name !== SURFACE_CAPTURE_FAILURES_DIR && stat.isDirectory()) {
      throw new MapStoreError(`generated capture artifact is a directory: ${target}`);
    }
    return { name, target, stat };
  });
  for (const { name, target, stat } of classified) {
    const recursive = name === SURFACE_CAPTURE_FAILURES_DIR && stat.isDirectory() && !stat.isSymbolicLink();
    fs.rmSync(target, { force: true, recursive });
  }
}

export class MapStoreError extends Error {}

/** A restore that failed because the requested bundle is genuinely absent — the map
 *  store branch does not exist yet, or it holds no bundle for this SHA/compatibility.
 *  This is an EXPECTED cache miss (the cold path should recapture), NOT an infrastructure
 *  fault. Kept distinct from a plain {@link MapStoreError} (network, clone, timeout, auth)
 *  so a caller can recapture on a true miss but fail loudly on a transient fault instead
 *  of silently paying a full cold recapture every flaky run. Extends MapStoreError, so
 *  existing `instanceof MapStoreError` handlers still catch it. */
export class MapStoreNotFoundError extends MapStoreError {}

/** An upload refused because of the CONSUMER's own state (a dirty working tree,
 *  a missing manifest) — a precondition the user must fix, never a transient
 *  store/network fault. Kept distinct so the CLI can exit with the usage code
 *  (2, "fix your invocation/tree") instead of the retryable fault code (5,
 *  "re-run the job"): retrying a dirty tree can never succeed. */
export class MapStorePreconditionError extends MapStoreError {}

export interface MapManifest {
  version: 1;
  packageVersion: string;
  sha: string;
  dirty: boolean;
  /** Repo-relative files/directories excluded from dirty provenance for this capture. */
  dirtyAllow?: string[];
  spec: string;
  specHash: string;
  lockfile?: string;
  lockfileHash?: string;
  playwrightVersion?: string;
  /** Real browser build (`browser().version()`), recorded at capture time. The npm
   *  `@playwright/test` version can hold constant while this changes (re-download, a
   *  different browser store, a CI image bump), so this is what actually gates a compare. */
  browserVersion?: string;
  platform: string;
  arch: string;
  nodeMajor: string;
  baseUrl?: string;
  screenshots: boolean;
  har: boolean;
  compatibilityKey: string;
  createdAt: string;
  /** Surfaces that failed during a tolerated baseline capture (partial bundle). */
  surfaceCaptureFailures?: SurfaceCaptureFailure[];
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

function gitProcessEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const variableName of GIT_REPOSITORY_ENVIRONMENT_VARIABLES) delete environment[variableName];
  return environment;
}

function runGit(cwd: string, args: string[], maxBuffer = 1 << 28) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer, env: gitProcessEnvironment() });
}

/** Node's recursive `rmSync` can spuriously throw ENOTEMPTY (also EBUSY/EPERM) on macOS and
 *  Windows when a directory is unlinked while the OS — or a lingering Git helper — still holds
 *  a handle to one of its children. It surfaces most on a busy CI runner where several
 *  StyleProof runs churn TMPDIR at once. Node retries exactly this class of transient error
 *  when given `maxRetries`/`retryDelay`, so route every recursive removal through here rather
 *  than the bare `{ recursive: true, force: true }` (which retries nothing). */
function removeDirRecursive(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

/** Best-effort removal of a THROWAWAY temp workspace (an `fs.mkdtemp` dir under `os.tmpdir()`).
 *  Retries the transient race like {@link removeDirRecursive}, but a residual failure is
 *  swallowed instead of thrown: the temp dir is disposable (the OS reclaims `/var/folders`,
 *  and CI reaps leftovers), so a fully successful capture/publish must never be reported as
 *  failed just because its scratch dir would not unlink — an ENOTEMPTY from cleanup is not an
 *  upload failure. */
function removeTempWorkspace(dir: string | undefined): void {
  if (!dir) return;
  try {
    removeDirRecursive(dir);
  } catch {
    // Disposable scratch dir — leave it for the OS / CI reaper rather than fail the run.
  }
}

const DEFAULT_MAP_STORE_GIT_TIMEOUT_MILLISECONDS = 30_000;

function mapStoreGitTimeoutMilliseconds(): number {
  const configuredTimeout = Number(process.env.STYLEPROOF_MAP_STORE_GIT_TIMEOUT_MS);
  return Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.floor(configuredTimeout)
    : DEFAULT_MAP_STORE_GIT_TIMEOUT_MILLISECONDS;
}

function runMapStoreNetworkGit(cwd: string, args: string[], maxBuffer = 1 << 20) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer,
    timeout: mapStoreGitTimeoutMilliseconds(),
    env: {
      ...gitProcessEnvironment(),
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

function gitFailureMessage(result: ReturnType<typeof spawnSync>, fallback: string): string {
  const standardError = typeof result.stderr === 'string' ? result.stderr.trim() : '';
  if (standardError) return standardError;
  if (result.error) return result.error.message;
  return fallback;
}

const DEFAULT_MAP_STORE_RESTORE_ATTEMPTS = 3;

/** How many times {@link restoreMapBundle} retries an INFRASTRUCTURE fault (network,
 *  clone, timeout) before giving up. A genuine cache miss is never retried. Overridable
 *  via `STYLEPROOF_MAP_STORE_RESTORE_ATTEMPTS` (tests pin it to 1 to stay fast). */
function mapStoreRestoreAttempts(): number {
  const configured = Number(process.env.STYLEPROOF_MAP_STORE_RESTORE_ATTEMPTS);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAP_STORE_RESTORE_ATTEMPTS;
}

/** Blocking backoff between map-store network retries. Blocks the thread on purpose:
 *  these are short-lived CLI processes with nothing else to do while git recovers. */
function mapStoreBackoff(attempt: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 250);
}

const WORKFLOW_TOKEN_CREDENTIAL_HELPER =
  '!f() { if [ "$1" = get ]; then printf \'%s\\n\' username=x-access-token "password=$STYLEPROOF_MAP_STORE_TOKEN"; fi; }; f';

export function workflowTokenCredentialArguments(): string[] {
  return ['-c', 'credential.helper=', '-c', `credential.helper=${WORKFLOW_TOKEN_CREDENTIAL_HELPER}`];
}

interface GitHttpExtraHeader {
  key: string;
  value: string;
}

function parseGitHttpExtraHeaders(configuredHeaders: string): GitHttpExtraHeader[] {
  return configuredHeaders
    .split('\n')
    .filter(Boolean)
    .flatMap((configuredHeader) => {
      const separatorIndex = configuredHeader.indexOf(' ');
      if (separatorIndex === -1) return [];
      return [{ key: configuredHeader.slice(0, separatorIndex), value: configuredHeader.slice(separatorIndex + 1) }];
    });
}

function resetInheritedGitHttpExtraHeaders(configuredHeaders: GitHttpExtraHeader[]): GitHttpExtraHeader[] {
  const resetHeaderKeys = new Set<string>();
  return configuredHeaders.flatMap((configuredHeader) => {
    if (resetHeaderKeys.has(configuredHeader.key)) return [configuredHeader];
    resetHeaderKeys.add(configuredHeader.key);
    return configuredHeader.value === ''
      ? [configuredHeader]
      : [{ key: configuredHeader.key, value: '' }, configuredHeader];
  });
}

function effectiveGitHttpExtraHeaders(cwd: string): GitHttpExtraHeader[] {
  const mapStoreToken = process.env.STYLEPROOF_MAP_STORE_TOKEN;
  if (mapStoreToken) {
    return [
      {
        key: ['http.https:', '', 'github.com', '.extraheader'].join('/'),
        value: '',
      },
      {
        key: ['http.https:', '', 'github.com', '.extraheader'].join('/'),
        value: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${mapStoreToken}`).toString('base64')}`,
      },
    ];
  }

  const configuredHeaders = runGit(cwd, ['config', '--includes', '--get-regexp', '^http\\..*\\.extraheader$'], 1 << 20);
  const effectiveHeaders = parseGitHttpExtraHeaders(configuredHeaders.stdout);
  if (effectiveHeaders.length > 0) return resetInheritedGitHttpExtraHeaders(effectiveHeaders);

  const registeredIncludes = runGit(cwd, ['config', '--local', '--get-regexp', '^includeIf\\..*\\.path$'], 1 << 20);
  const includedHeaders = registeredIncludes.stdout
    .split('\n')
    .filter(Boolean)
    .flatMap((registeredInclude) => {
      const separatorIndex = registeredInclude.indexOf(' ');
      if (separatorIndex === -1) return [];
      const includedConfigPath = registeredInclude.slice(separatorIndex + 1);
      const includedHeaders = runGit(
        cwd,
        ['config', '--file', includedConfigPath, '--get-regexp', '^http\\..*\\.extraheader$'],
        1 << 20,
      );
      return parseGitHttpExtraHeaders(includedHeaders.stdout);
    });
  if (includedHeaders.length > 0) return resetInheritedGitHttpExtraHeaders(includedHeaders);

  return [];
}

function gitOutput(cwd: string, args: string[]): string {
  const r = runGit(cwd, args);
  return r.status === 0 ? r.stdout.trim() : '';
}

function hash(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function hashFile(file: string): string | undefined {
  try {
    return hash(fs.readFileSync(file));
  } catch {
    return undefined;
  }
}

function styleProofPackageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function consumerRequire(cwd: string) {
  return createRequire(path.join(cwd, 'package.json'));
}

function playwrightVersion(cwd: string): string | undefined {
  try {
    const pkgPath = consumerRequire(cwd).resolve('@playwright/test/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

function detectLockfile(cwd: string): { file?: string; hash?: string } {
  for (const file of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']) {
    const full = path.join(cwd, file);
    const h = hashFile(full);
    if (h) return { file, hash: h };
  }
  return {};
}

/** Record the real browser build into the capture dir. Called from a capture run, where a
 *  Playwright browser handle is in scope. Write-or-CLEAR semantics: an undefined version
 *  REMOVES any existing sidecar rather than leaving it, so a reused capture dir (e.g. the
 *  default `.styleproof/maps/current`) can never carry a PRIOR run's build into this run's
 *  manifest — that would stamp a false browser-build fingerprint the compatibility guard
 *  then trusts. Best-effort: the delete is forced and ignores a missing file. */
export function writeBrowserBuildSidecar(dir: string, browserVersion: string | undefined): void {
  const sidecar = path.join(dir, BROWSER_BUILD_SIDECAR);
  if (!browserVersion) {
    fs.rmSync(sidecar, { force: true });
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sidecar, JSON.stringify({ browserVersion }, null, 2));
}

function readBrowserBuildSidecar(dir: string): string | undefined {
  try {
    const parsed = JSON.parse(readRegularFileNoFollow(path.join(dir, BROWSER_BUILD_SIDECAR)).toString('utf8')) as {
      browserVersion?: string;
    };
    return parsed.browserVersion;
  } catch {
    return undefined;
  }
}

function hasHar(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && hasHar(full)) return true;
    if (entry.isFile() && entry.name.endsWith('.har')) return true;
  }
  return false;
}

function compatibilityInput(options: { cwd: string; spec: string; baseUrl?: string }) {
  // Normalize FIRST: a relative cwd ('.') made createRequire throw inside
  // playwrightVersion, silently dropping that field from the key — so publish
  // and restore could stamp DIFFERENT keys for the same environment, and every
  // cache lookup missed (a silent full-recapture tax, never an error).
  const cwd = path.resolve(options.cwd);
  const specPath = path.resolve(cwd, options.spec);
  const lock = detectLockfile(cwd);
  return {
    packageVersion: styleProofPackageVersion(),
    spec: path.relative(cwd, specPath) || options.spec,
    specHash: hashFile(specPath) ?? 'missing',
    lockfile: lock.file,
    lockfileHash: lock.hash,
    playwrightVersion: playwrightVersion(cwd),
    platform: process.platform,
    arch: process.arch,
    nodeMajor: process.versions.node.split('.')[0] ?? process.versions.node,
    baseUrl: options.baseUrl,
  };
}

/** Hash only inputs available both during capture and in a detached restore probe.
 *  The installed Playwright package remains manifest evidence, but detached probe
 *  worktrees intentionally have no node_modules. The lockfile hash already binds
 *  the resolved dependency graph, so hashing the installed lookup made every
 *  capture key differ from its later restore key. */
function compatibilityKeyForInput(input: ReturnType<typeof compatibilityInput>): string {
  const { playwrightVersion: recordedPlaywrightVersion, ...stableCompatibilityInput } = input;
  void recordedPlaywrightVersion;
  return hash(JSON.stringify(stableCompatibilityInput)).slice(0, 16);
}

export function expectedCompatibilityKey(options: { cwd?: string; spec?: string; baseUrl?: string } = {}): string {
  return compatibilityKeyForInput(
    compatibilityInput({
      cwd: options.cwd ?? process.cwd(),
      spec: options.spec ?? 'e2e/styleproof.spec.ts',
      baseUrl: options.baseUrl,
    }),
  );
}

export function currentGitSha(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  const fromEvent = (() => {
    // pull_request_target is deliberately absent: there GITHUB_SHA *is* the base
    // tip, so its default checkout would be relabeled to the fork's (attacker-
    // chosen) head. A pull_request_target job that really checks out the head
    // gets the right SHA from `git rev-parse HEAD` with no relabel needed.
    if (!env.GITHUB_EVENT_PATH || !['pull_request', 'workflow_run'].includes(env.GITHUB_EVENT_NAME ?? '')) {
      return undefined;
    }
    try {
      const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) as {
        pull_request?: { head?: { sha?: string } };
        workflow_run?: { head_sha?: string };
      };
      return event.pull_request?.head?.sha ?? event.workflow_run?.head_sha;
    } catch {
      return undefined;
    }
  })();
  // STYLEPROOF_SHA/GITHUB_HEAD_SHA are explicit overrides: they always win, and
  // a malformed value errors instead of silently falling through to a wrong label.
  const explicit = env.STYLEPROOF_SHA || env.GITHUB_HEAD_SHA;
  if (explicit) {
    if (!/^[0-9a-f]{7,40}$/i.test(explicit)) {
      throw new MapStoreError(`STYLEPROOF_SHA/GITHUB_HEAD_SHA is not a commit SHA: ${explicit}`);
    }
    return explicit;
  }
  const head = gitOutput(cwd, ['rev-parse', 'HEAD']);
  if (head) {
    // The checked-out tree is the truth. The one exception: a checkout of the
    // synthetic GITHUB_SHA commit (pull_request merge commit / workflow_run
    // default tip) is labeled with the event's real head, because nothing ever
    // restores by the synthetic SHA. A checkout of anything else — e.g. the
    // base branch in a cache-miss job — keeps its own SHA, so a base-tree map
    // is never published under the head's store key (a false-green poisoning).
    if (fromEvent && head === env.GITHUB_SHA) return fromEvent;
    return head;
  }
  const fallback = fromEvent ?? env.GITHUB_SHA;
  if (fallback && /^[0-9a-f]{7,40}$/i.test(fallback)) return fallback;
  throw new MapStoreError('must run inside a git repository, or pass --sha <commit>');
}

export function refSha(ref: string, cwd = process.cwd()): string {
  const sha = gitOutput(cwd, ['rev-parse', `${ref}^{commit}`]);
  if (!sha) throw new MapStoreError(`could not resolve ${ref} to a commit`);
  return sha;
}

/**
 * True if any tracked file is modified/added/deleted. `ignore` (repo-relative files or
 * directories) are excluded — pass the map OUTPUT dir when re-sampling AFTER a capture,
 * so the maps the capture just wrote don't read as tree dirt and mask a real source
 * edit, and pass `--dirty-allow` paths for files a dev tool rewrites on every run
 * (the ambient equivalent of the built-in next-env.d.ts allowance).
 */
export function workingTreeDirty(cwd = process.cwd(), ignore?: string | readonly string[]): boolean {
  // Enumerate every untracked file. Git otherwise collapses a wholly untracked
  // directory to `dir/`, which makes an exact dirty allowance for generated
  // first-adoption harness files impossible to honor.
  const r = runGit(cwd, ['status', '--porcelain', '--untracked-files=all']);
  const status = r.status === 0 ? r.stdout.trimEnd() : '';
  if (!status) return false;
  const prefixes = (typeof ignore === 'string' ? [ignore] : (ignore ?? []))
    .filter(Boolean)
    .map((p) => `${p.replace(/\/+$/, '')}/`);
  // Porcelain quotes paths with special characters ("with space.ts", \t, …) and
  // renders renames as `old -> new`; both must be normalized or `ignore`
  // prefixes silently fail to match and a legitimately-allowed rewrite reads as
  // dirt (a spurious publish refusal — never a false green).
  const unquote = (p: string): string => {
    if (!p.startsWith('"') || !p.endsWith('"')) return p;
    try {
      return JSON.parse(p) as string;
    } catch {
      return p;
    }
  };
  const allowed = (file: string): boolean =>
    GENERATED_DIRTY_ALLOWLIST.has(file) ||
    prefixes.some((prefix) => file === prefix.slice(0, -1) || file.startsWith(prefix));
  return status.split(/\r?\n/).some((line) => {
    const raw = line.slice(3).trim();
    if (!raw) return false;
    // A rename dirties the tree unless BOTH sides are allowed.
    const files = raw.includes(' -> ') ? raw.split(' -> ').map((side) => unquote(side.trim())) : [unquote(raw)];
    return !files.every(allowed);
  });
}

export function remoteExists(remote = DEFAULT_REMOTE, cwd = process.cwd()): boolean {
  return runGit(cwd, ['remote', 'get-url', remote], 1 << 20).status === 0;
}

/** Assemble a {@link MapManifest} from the compatibility inputs and the caller-resolved
 *  git fields. Shared by {@link writeMapManifest} (spec capture) and
 *  {@link writeCaptureManifest} (one-shot capture) so the object shape lives in one place. */
function failureFileName(key: string): string {
  // Sanitization can collide distinct keys (`a/b@1280` vs `a_b@1280`); suffix a
  // short hash of the RAW key so a later write can never erase another surface's
  // ledger entry (which would resurface its missing surface as greenfield-new).
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 8);
  const stem = key.replace(/[^a-zA-Z0-9@._-]+/g, '_').slice(0, 200);
  return `${stem}-${digest}.json`;
}

function boundedFailureText(value: string, maximumLength: number, fallback: string): string {
  const controlFree = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? ' ' : character;
    })
    .join('');
  const normalized = controlFree.replace(/\s+/g, ' ').trim();
  return (normalized || fallback).slice(0, maximumLength);
}

/** Record one tolerated surface failure (safe under parallel Playwright workers). */
export function recordSurfaceCaptureFailure(dir: string, failure: SurfaceCaptureFailure): void {
  const sub = path.join(dir, SURFACE_CAPTURE_FAILURES_DIR);
  const normalized: SurfaceCaptureFailure = {
    key: boundedFailureText(failure.key, 256, 'capture'),
    reason: boundedFailureText(failure.reason, 1024, 'capture failed'),
    ...(failure.kind ? { kind: failure.kind } : {}),
  };
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, failureFileName(failure.key)), JSON.stringify(normalized));
}

/** Read tolerated failures written during capture (sorted by key). */
export function readSurfaceCaptureFailures(dir: string): SurfaceCaptureFailure[] {
  const sub = path.join(dir, SURFACE_CAPTURE_FAILURES_DIR);
  if (!fs.existsSync(sub)) return [];
  return fs
    .readdirSync(sub)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(sub, name), 'utf8')) as SurfaceCaptureFailure)
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Record a run-level capture failure that must never be tolerated or published. */
export function markFatalCaptureFailure(dir: string, reason: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, FATAL_CAPTURE_MARKER), reason);
}

/** Read the fatal marker written by a capture worker, if one exists. */
export function readFatalCaptureFailure(dir: string): string | undefined {
  try {
    return (
      readRegularFileNoFollow(path.join(dir, FATAL_CAPTURE_MARKER)).toString('utf8').trim() ||
      'unknown fatal capture failure'
    );
  } catch {
    return undefined;
  }
}

/** Split a capture key at the last `@` (`home@1280` → `home` + `1280`). */
export function captureKeyParts(key: string): { surface: string; width: string } {
  const at = key.lastIndexOf('@');
  if (at === -1) return { surface: key, width: '' };
  return { surface: key.slice(0, at), width: key.slice(at + 1) };
}

/**
 * Whether a baseline failure ledger entry accounts for a missing capture key on head.
 * `surface@auto` (viewport detection failed before width sweep) matches any width for
 * that exact surface key. Width-specific failures match only the same key.
 */
export function baselineFailureMatchesSurface(failureKey: string, surfaceKey: string): boolean {
  if (failureKey === surfaceKey) return true;
  const failure = captureKeyParts(failureKey);
  const surface = captureKeyParts(surfaceKey);
  if (failure.surface !== surface.surface) return false;
  return failure.width === 'auto';
}

/** True when any ledger entry explains why `surfaceKey` is absent from the base bundle. */
export function surfaceMissingMatchesBaselineFailure(
  surfaceKey: string,
  failures: readonly SurfaceCaptureFailure[],
): boolean {
  return failures.some((f) => baselineFailureMatchesSurface(f.key, surfaceKey));
}

/** Head capture keys missing on base that the baseline failure ledger explains (sorted). */
export function explainedMissingBaselineSurfaces(
  surfaces: readonly { surface: string; missing?: 'before' | 'after' }[],
  failures: readonly SurfaceCaptureFailure[],
): string[] {
  return surfaces
    .filter((s) => s.missing === 'before' && surfaceMissingMatchesBaselineFailure(s.surface, failures))
    .map((s) => s.surface)
    .sort((a, b) => a.localeCompare(b));
}

function buildManifest(options: {
  dir: string;
  input: ReturnType<typeof compatibilityInput>;
  sha: string;
  dirty: boolean;
  dirtyAllow?: readonly string[];
  screenshots: boolean;
  surfaceCaptureFailures?: SurfaceCaptureFailure[];
}): MapManifest {
  const { dir, input } = options;
  const browserVersion = readBrowserBuildSidecar(dir);
  return {
    version: 1,
    packageVersion: input.packageVersion,
    sha: options.sha,
    dirty: options.dirty,
    ...(options.dirtyAllow?.length ? { dirtyAllow: [...options.dirtyAllow] } : {}),
    spec: input.spec,
    specHash: input.specHash,
    ...(input.lockfile ? { lockfile: input.lockfile } : {}),
    ...(input.lockfileHash ? { lockfileHash: input.lockfileHash } : {}),
    ...(input.playwrightVersion ? { playwrightVersion: input.playwrightVersion } : {}),
    ...(browserVersion ? { browserVersion } : {}),
    platform: input.platform,
    arch: input.arch,
    nodeMajor: input.nodeMajor,
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    screenshots: options.screenshots,
    har: hasHar(dir),
    compatibilityKey: compatibilityKeyForInput(input),
    // Real wall clock even when the spec-process clock is frozen — a manifest
    // stamped with the frozen instant would misreport when the capture ran.
    createdAt: new Date(realNow()).toISOString(),
    ...(options.surfaceCaptureFailures?.length ? { surfaceCaptureFailures: options.surfaceCaptureFailures } : {}),
  };
}

function writeBoundedManifest(dir: string, manifest: MapManifest): void {
  parseMapManifest(manifest);
  const serialized = JSON.stringify(manifest, null, 2);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_MAP_MANIFEST_BYTES) invalidMapManifest();
  fs.writeFileSync(path.join(dir, MAP_MANIFEST), serialized);
}

export function writeMapManifest(options: {
  dir: string;
  spec: string;
  sha?: string;
  screenshots: boolean;
  dirty?: boolean;
  dirtyAllow?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): MapManifest {
  const cwd = options.cwd ?? process.cwd();
  const input = compatibilityInput({ cwd, spec: options.spec, baseUrl: options.env?.BASE_URL ?? process.env.BASE_URL });
  const surfaceCaptureFailures = readSurfaceCaptureFailures(options.dir);
  const manifest = buildManifest({
    dir: options.dir,
    input,
    sha: options.sha ?? currentGitSha(cwd, options.env),
    dirty: options.dirty ?? workingTreeDirty(cwd),
    dirtyAllow: options.dirtyAllow,
    screenshots: options.screenshots,
    surfaceCaptureFailures,
  });
  writeBoundedManifest(options.dir, manifest);
  return manifest;
}

/**
 * Write a `styleproof-manifest.json` for a one-shot `styleproof-capture` output dir,
 * so a two-directory `styleproof-diff design <build>` has the same-environment guard
 * on both sides (v4 refuses to compare a manifest-less side). Unlike
 * {@link writeMapManifest}, this may run OUTSIDE a git repo (a design mockup, a static
 * export), so the git-derived fields degrade gracefully: `sha` falls back to
 * `'uncommitted'` and `dirty` to `true` rather than throwing. The parts the guard
 * actually consumes — `compatibilityKey`, `platform`/`arch`/`nodeMajor`,
 * `playwrightVersion`, `browserVersion`, `baseUrl` — are recorded the same way as a
 * spec capture. Overwrites any existing manifest in `dir`.
 */
export function writeCaptureManifest(options: {
  dir: string;
  screenshots: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): MapManifest {
  const cwd = options.cwd ?? process.cwd();
  // A one-shot capture has no spec file; key comparability off the capture inputs only.
  const input = compatibilityInput({ cwd, spec: MAP_MANIFEST, baseUrl: options.env?.BASE_URL ?? process.env.BASE_URL });
  // Degrade the git fields gracefully outside a repo (a design mockup): no HEAD → uncommitted/dirty.
  const sha = gitOutput(cwd, ['rev-parse', 'HEAD']) || 'uncommitted';
  const manifest = buildManifest({
    dir: options.dir,
    input,
    sha,
    dirty: sha === 'uncommitted' ? true : workingTreeDirty(cwd),
    screenshots: options.screenshots,
  });
  fs.mkdirSync(options.dir, { recursive: true });
  writeBoundedManifest(options.dir, manifest);
  return manifest;
}

const MAP_MANIFEST_FIELDS = new Set([
  'version',
  'packageVersion',
  'sha',
  'dirty',
  'dirtyAllow',
  'spec',
  'specHash',
  'lockfile',
  'lockfileHash',
  'playwrightVersion',
  'browserVersion',
  'platform',
  'arch',
  'nodeMajor',
  'baseUrl',
  'screenshots',
  'har',
  'compatibilityKey',
  'createdAt',
  'surfaceCaptureFailures',
]);

function invalidMapManifest(): never {
  throw new MapStoreError(`invalid ${MAP_MANIFEST} — expected a valid v1 capture manifest`);
}

function hasUnsafeControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code === 0x7f || code < 0x20;
  });
}

function boundedString(value: unknown, maximumLength = 4096): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= maximumLength && !hasUnsafeControlCharacter(value)
  );
}

function optionalBoundedString(value: unknown, maximumLength = 4096): boolean {
  return value === undefined || boundedString(value, maximumLength);
}

function canonicalInstant(value: unknown): value is string {
  if (!boundedString(value, 64)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function canonicalContentHash(value: unknown): value is string {
  return value === 'missing' || (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value));
}

/** JSON.parse keeps only the last duplicate key. Certification manifests must
 * reject that ambiguity instead. This scanner runs only after JSON.parse has
 * established valid JSON grammar, and checks every nested object. */
export function hasDuplicateJsonKeys(source: string): boolean {
  let offset = 0;
  let duplicate = false;
  const whitespace = () => {
    while (/\s/.test(source[offset] ?? '')) offset++;
  };
  const stringValue = (): string => {
    const start = offset++;
    while (offset < source.length) {
      if (source[offset] === '\\') {
        offset += 2;
        continue;
      }
      if (source[offset++] === '"') return JSON.parse(source.slice(start, offset)) as string;
    }
    return '';
  };
  function value(): void {
    whitespace();
    if (source[offset] === '{') return objectValue();
    if (source[offset] === '[') return arrayValue();
    if (source[offset] === '"') {
      stringValue();
      return;
    }
    while (offset < source.length && !/[\s,\]}]/.test(source[offset] ?? '')) offset++;
  }
  const objectValue = (): void => {
    offset++;
    const keys = new Set<string>();
    whitespace();
    while (source[offset] !== '}') {
      const key = stringValue();
      if (keys.has(key)) duplicate = true;
      keys.add(key);
      whitespace();
      offset++;
      value();
      whitespace();
      if (source[offset] !== ',') break;
      offset++;
      whitespace();
    }
    offset++;
  };
  const arrayValue = (): void => {
    offset++;
    whitespace();
    while (source[offset] !== ']') {
      value();
      whitespace();
      if (source[offset] !== ',') break;
      offset++;
      whitespace();
    }
    offset++;
  };
  value();
  return duplicate;
}

function matchesBoundedString(value: unknown, expression: RegExp, maximumLength = 4096): value is string {
  return boundedString(value, maximumLength) && expression.test(value);
}

function validSurfaceCaptureFailures(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 10_000) return false;
  return value.every((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const failure = entry as Record<string, unknown>;
    if (Object.keys(failure).some((field) => !['key', 'reason', 'kind'].includes(field))) return false;
    return (
      boundedString(failure.key, 256) &&
      boundedString(failure.reason) &&
      (failure.kind === undefined || failure.kind === 'capture')
    );
  });
}

function parseMapManifest(value: unknown): MapManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidMapManifest();
  const manifest = value as Record<string, unknown>;
  if (Object.keys(manifest).some((field) => !MAP_MANIFEST_FIELDS.has(field))) invalidMapManifest();
  const dirtyAllowValid =
    manifest.dirtyAllow === undefined ||
    (Array.isArray(manifest.dirtyAllow) &&
      manifest.dirtyAllow.length <= 1_000 &&
      manifest.dirtyAllow.every((entry) => boundedString(entry)));
  const createdAtValid = canonicalInstant(manifest.createdAt);
  const lockfilePairValid =
    (manifest.lockfile === undefined && manifest.lockfileHash === undefined) ||
    (boundedString(manifest.lockfile) &&
      /^[A-Za-z0-9._/-]+$/.test(manifest.lockfile) &&
      canonicalContentHash(manifest.lockfileHash));
  const manifestValid = [
    manifest.version === 1,
    boundedString(manifest.packageVersion, 128),
    matchesBoundedString(manifest.sha, /^(?:[0-9a-f]{40}|uncommitted)$/, 40),
    manifest.sha !== 'uncommitted' || manifest.dirty === true,
    typeof manifest.dirty === 'boolean',
    dirtyAllowValid,
    boundedString(manifest.spec),
    canonicalContentHash(manifest.specHash),
    lockfilePairValid,
    optionalBoundedString(manifest.playwrightVersion, 128),
    optionalBoundedString(manifest.browserVersion, 256),
    matchesBoundedString(manifest.platform, /^[A-Za-z0-9._-]+$/, 128),
    matchesBoundedString(manifest.arch, /^[A-Za-z0-9._-]+$/, 128),
    matchesBoundedString(manifest.nodeMajor, /^\d+$/, 16),
    optionalBoundedString(manifest.baseUrl),
    typeof manifest.screenshots === 'boolean',
    typeof manifest.har === 'boolean',
    matchesBoundedString(manifest.compatibilityKey, /^[0-9a-f]{16}$/, 16),
    createdAtValid,
    validSurfaceCaptureFailures(manifest.surfaceCaptureFailures),
  ].every(Boolean);
  if (!manifestValid) invalidMapManifest();
  return manifest as unknown as MapManifest;
}

export function readMapManifest(dir: string): MapManifest | null {
  let content: string;
  try {
    content = readRegularFileNoFollow(path.join(dir, MAP_MANIFEST), MAX_MAP_MANIFEST_BYTES).toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return invalidMapManifest();
  }
  try {
    if (Buffer.byteLength(content, 'utf8') > MAX_MAP_MANIFEST_BYTES) invalidMapManifest();
    const parsed = JSON.parse(content) as unknown;
    if (hasDuplicateJsonKeys(content)) invalidMapManifest();
    return parseMapManifest(parsed);
  } catch (error) {
    if (error instanceof MapStoreError) throw error;
    return invalidMapManifest();
  }
}

/** Where a run's baseline maps came from (#367). `ancestor-reuse` carries the
 *  no-relevant-changes proof: how many paths changed between the restored
 *  ancestor and the requested base commit (all of them capture-irrelevant),
 *  and the declared app source roots the relevance gate ran against. The
 *  restored bundle itself stays byte-identical to what was verified at capture
 *  time — this sidecar only records the reuse decision, it never rewrites the
 *  bundle's own manifest or SHA. */
export type BaselineProvenance = {
  version: 1;
  baseline: 'exact-restore' | 'ancestor-reuse' | 'captured';
  /** The base commit this run needed a baseline for. */
  requestedSha: string;
  /** The commit whose stored bundle was restored (absent for `captured`). */
  restoredSha?: string;
  /** 1 = the base commit's direct first-parent parent. */
  ancestorDepth?: number;
  /** `git diff --name-only <restoredSha> <requestedSha>` path count — the proof. */
  changedPathCount?: number;
  /** The app source roots the relevance gate was declared with. */
  sourceRoots?: string[];
};

/** Record the baseline-provenance sidecar into a base map dir (#367: no silent reuse). */
export function writeBaselineProvenance(dir: string, provenance: BaselineProvenance): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, BASELINE_PROVENANCE_FILE), JSON.stringify(provenance, null, 2));
}

/** Read the baseline-provenance sidecar; `null` when absent or unreadable. */
export function readBaselineProvenance(dir: string): BaselineProvenance | null {
  try {
    return JSON.parse(
      readRegularFileNoFollow(path.join(dir, BASELINE_PROVENANCE_FILE)).toString('utf8'),
    ) as BaselineProvenance;
  } catch {
    return null;
  }
}

/** True if `dir` holds at least one captured surface map (`<key>@<width>.json[.gz]`),
 *  ignoring metadata sidecars. Distinguishes a real capture that merely lacks a manifest
 *  (a legacy committed-map bundle — v4 refuses it) from an empty/bare dir (no baseline
 *  yet — the missing-map guards own that). */
function dirHasMaps(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some(isMapFile);
  } catch {
    return false;
  }
}

/** Which side(s) of a two-directory compare hold captured maps but NO
 *  `styleproof-manifest.json` — a legacy committed-map bundle. Since v4 that is
 *  unsupported: without a manifest the same-environment guard can't be enforced, so the
 *  CLI refuses (exit 2). `null` means every side WITH maps also has a manifest (nothing to
 *  refuse). A side with zero maps is NOT flagged — an empty/bare dir is "no baseline yet",
 *  handled by the base/head-missing guards, not this one. Pure: presence reads only, so the
 *  CLI layer owns the exit code and the library stays side-effect-free. */
export function manifestlessSide(beforeDir: string, afterDir: string): 'before' | 'after' | 'both' | null {
  const before = dirHasMaps(beforeDir) && readMapManifest(beforeDir) == null;
  const after = dirHasMaps(afterDir) && readMapManifest(afterDir) == null;
  if (before && after) return 'both';
  if (before) return 'before';
  if (after) return 'after';
  return null;
}

/** Fail-loud message for a manifest-less compare. Since v4 a side without a
 *  `styleproof-manifest.json` is unsupported: the same-environment guard can't be
 *  enforced, so captures from different browser builds or platforms would diff as
 *  false changes. The CLI raises this and exits 2 (usage/capture error) — the
 *  legacy "compare anyway" tolerance is gone. */
export function manifestlessError(side: 'before' | 'after' | 'both'): string {
  const carry = side === 'both' ? 'before and after carry' : `${side} carries`;
  return (
    `styleproof: ${carry} no ${MAP_MANIFEST} — environment compatibility can't be verified, so ` +
    'captures from different browser builds or platforms would diff as false changes. ' +
    'Re-capture with current StyleProof (styleproof-map, or styleproof-capture for a one-shot ' +
    'diff); maps without a manifest are unsupported since v4.'
  );
}

export type SourceBindingReceipt = {
  status: 'bound' | 'unverified';
  compatibility: 'matched' | 'not-applicable';
  before: {
    expected: string | null;
    observed: string | null;
    result: 'matched' | 'no-capture' | 'unverified';
  };
  after: {
    expected: string | null;
    observed: string | null;
    result: 'matched' | 'no-capture' | 'unverified';
  };
};

export function expectedSourceShaFlagsError(input: {
  beforeProvided: boolean;
  beforeSha?: string;
  afterProvided: boolean;
  afterSha?: string;
}): string | null {
  try {
    validateExpectedSourceShas({
      beforeSha: input.beforeProvided ? (input.beforeSha ?? '') : undefined,
      afterSha: input.afterProvided ? (input.afterSha ?? '') : undefined,
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function validateExpectedSourceShas(expected: { beforeSha?: string; afterSha?: string }): void {
  const beforeExpected = expected.beforeSha !== undefined;
  const afterExpected = expected.afterSha !== undefined;
  if (beforeExpected !== afterExpected) {
    throw new MapStoreError('trusted before and after SHAs must be supplied together');
  }
  if (beforeExpected && !/^[0-9a-f]{40}$/.test(expected.beforeSha ?? '')) {
    throw new MapStoreError('trusted before SHA must be a full lowercase commit SHA');
  }
  if (afterExpected && !/^[0-9a-f]{40}$/.test(expected.afterSha ?? '')) {
    throw new MapStoreError('trusted after SHA must be a full lowercase commit SHA');
  }
}

function comparableManifest(dir: string): MapManifest | null {
  const manifest = readMapManifest(dir);
  if (!manifest && dirHasMaps(dir)) {
    throw new MapStoreError('capture manifest is unavailable for a map-bearing directory');
  }
  return manifest;
}

function assertBoundManifest(manifest: MapManifest | null, expectedSha: string | undefined, side: string): void {
  if (expectedSha !== undefined && manifest?.dirty === true) {
    throw new MapStoreError('dirty capture cannot bind to a trusted commit SHA');
  }
  if (expectedSha !== undefined && manifest && manifest.sha !== expectedSha) {
    throw new MapStoreError(`${side} capture source does not match the trusted SHA`);
  }
}

function sourceBindingSide(manifest: MapManifest | null, expectedSha: string | undefined) {
  const result = expectedSha === undefined ? 'unverified' : manifest ? 'matched' : 'no-capture';
  return { expected: expectedSha ?? null, observed: manifest?.sha ?? null, result } as const;
}

function sourceBindingReceipt(
  before: MapManifest | null,
  after: MapManifest | null,
  expected: { beforeSha?: string; afterSha?: string },
): SourceBindingReceipt {
  return {
    status: expected.beforeSha !== undefined && expected.afterSha !== undefined ? 'bound' : 'unverified',
    compatibility: before && after ? 'matched' : 'not-applicable',
    before: sourceBindingSide(before, expected.beforeSha),
    after: sourceBindingSide(after, expected.afterSha),
  };
}

function runtimeIdentity(manifest: MapManifest): Record<string, string> {
  return {
    platform: manifest.platform,
    arch: manifest.arch,
    nodeMajor: manifest.nodeMajor,
    playwrightVersion: manifest.playwrightVersion ?? '',
    baseUrl: manifest.baseUrl ?? '',
  };
}

function assertCompatibleManifests(before: MapManifest, after: MapManifest): void {
  if (before.compatibilityKey !== after.compatibilityKey) {
    throw new MapStoreError(
      'maps were captured with different capture compatibility contracts\n' +
        'Next: rebuild one side with styleproof-map in the same environment, or let CI recapture both maps.',
    );
  }
  const beforeRuntime = runtimeIdentity(before);
  const afterRuntime = runtimeIdentity(after);
  // Browser build is optional for bundles captured before the field existed. Compare it only when both sides carry it.
  if (before.browserVersion && after.browserVersion) {
    beforeRuntime.browserVersion = before.browserVersion;
    afterRuntime.browserVersion = after.browserVersion;
  }
  if (JSON.stringify(beforeRuntime) !== JSON.stringify(afterRuntime)) {
    throw new MapStoreError(
      'maps were captured in different runtime environments\n' +
        'Next: rebuild one side with styleproof-map in the same environment, or let CI recapture both maps.',
    );
  }
}

export function assertCompatibleMapDirs(
  beforeDir: string,
  afterDir: string,
  expected: { beforeSha?: string; afterSha?: string } = {},
): SourceBindingReceipt {
  validateExpectedSourceShas(expected);
  const before = comparableManifest(beforeDir);
  const after = comparableManifest(afterDir);
  assertBoundManifest(before, expected.beforeSha, 'before');
  assertBoundManifest(after, expected.afterSha, 'after');
  const receipt = sourceBindingReceipt(before, after, expected);
  if (before && after) assertCompatibleManifests(before, after);
  return receipt;
}

function safeSegment(value: string, name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new MapStoreError(`${name} contains unsupported characters: ${value}`);
  return value;
}

function copyDir(src: string, dest: string, includeHar: boolean): void {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (source) => includeHar || !source.endsWith('.har'),
  });
}

function checkoutSparseSegment(tmp: string, branch: string, segment: string): void {
  const sparseCheckout = runGit(tmp, ['sparse-checkout', 'set', segment], 1 << 20);
  const checkout = sparseCheckout.status === 0 ? runGit(tmp, ['checkout', '-q', branch], 1 << 20) : sparseCheckout;
  if (checkout.status !== 0) {
    removeTempWorkspace(tmp);
    throw new MapStoreError(checkout.stderr.trim() || `could not check out ${segment} from map store`);
  }
}

function checkoutMapStore(
  cwd: string,
  remote: string,
  branch: string,
  sparseSegment?: string,
  sparseFilter = 'blob:none',
): string {
  if (!remoteExists(remote, cwd)) throw new MapStoreError(`git remote ${remote} was not found`);
  const remoteUrl = gitOutput(cwd, ['remote', 'get-url', remote]);
  const httpExtraHeaders = effectiveGitHttpExtraHeaders(cwd);
  const authenticationArguments = httpExtraHeaders.flatMap(({ key, value }) => ['-c', `${key}=${value}`]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-map-store-'));
  const branchLookup = runMapStoreNetworkGit(cwd, ['ls-remote', '--exit-code', '--heads', remote, branch], 1 << 20);
  if (branchLookup.status !== 0 && branchLookup.status !== 2) {
    removeTempWorkspace(tmp);
    throw new MapStoreError(gitFailureMessage(branchLookup, 'could not query map store branch'));
  }
  const branchExists = branchLookup.status === 0;
  if (branchExists) {
    const cloneArguments = sparseSegment
      ? [
          'clone',
          '-q',
          `--filter=${sparseFilter}`,
          '--no-checkout',
          '--depth',
          '1',
          '--single-branch',
          '--branch',
          branch,
        ]
      : ['clone', '-q', '--depth', '1', '--branch', branch];
    const clone = runMapStoreNetworkGit(cwd, [...authenticationArguments, ...cloneArguments, remoteUrl, tmp]);
    if (clone.status !== 0) {
      removeTempWorkspace(tmp);
      throw new MapStoreError(gitFailureMessage(clone, 'could not clone map store branch'));
    }
  } else {
    runGit(tmp, ['init', '-q', '-b', branch]);
    runGit(tmp, ['remote', 'add', 'origin', remoteUrl]);
  }
  for (const { key, value } of httpExtraHeaders) runGit(tmp, ['config', '--local', '--add', key, value]);
  if (sparseSegment && branchExists) checkoutSparseSegment(tmp, branch, sparseSegment);
  return tmp;
}

function pushMapStoreCommit(
  cwd: string,
  temporaryCheckout: string,
  remote: string,
  branch: string,
  authenticationArguments: string[],
) {
  const pushFailures: string[] = [];
  const isolatedPush = runMapStoreNetworkGit(
    temporaryCheckout,
    [...authenticationArguments, 'push', '-q', 'origin', `HEAD:${branch}`],
    1 << 20,
  );
  if (isolatedPush.status === 0) return isolatedPush;
  pushFailures.push(`isolated map-store push: ${gitFailureMessage(isolatedPush, `git exited ${isolatedPush.status}`)}`);

  const mapStoreToken = process.env.STYLEPROOF_MAP_STORE_TOKEN;
  if (mapStoreToken) {
    const githubExtraHeaderKey = ['http.https:', '', 'github.com', '.extraheader'].join('/');
    runGit(temporaryCheckout, ['config', '--local', '--unset-all', githubExtraHeaderKey], 1 << 20);
    const credentialPush = runMapStoreNetworkGit(temporaryCheckout, [
      '-c',
      `${githubExtraHeaderKey}=`,
      ...workflowTokenCredentialArguments(),
      'push',
      '-q',
      'origin',
      `HEAD:${branch}`,
    ]);
    if (credentialPush.status === 0) return credentialPush;
    pushFailures.push(
      `workflow-token credential push: ${gitFailureMessage(credentialPush, `git exited ${credentialPush.status}`)}`,
    );
  }

  const mapStoreCommit = gitOutput(temporaryCheckout, ['rev-parse', 'HEAD']);
  // The temporary checkout is a blob:none partial clone, and upload-pack refuses to
  // lazy-fetch while serving, so importing its commit demands every historic map blob
  // the filter skipped. Fetch the branch tip through the consumer checkout's own
  // credentials first: negotiation then narrows the import to the newly committed
  // objects, which the temporary checkout holds in full. A missing branch is fine -
  // then the temporary checkout is an unfiltered fresh repository.
  const mapStoreTipImportRef = 'refs/styleproof/map-store-tip';
  const importTip = runMapStoreNetworkGit(
    cwd,
    ['fetch', '-q', '--no-write-fetch-head', remote, `+refs/heads/${branch}:${mapStoreTipImportRef}`],
    1 << 20,
  );
  if (importTip.status !== 0) {
    pushFailures.push(`consumer tip fetch: ${gitFailureMessage(importTip, `git exited ${importTip.status}`)}`);
  }
  try {
    const importCommit = runGit(
      cwd,
      ['fetch', '-q', '--no-write-fetch-head', temporaryCheckout, mapStoreCommit],
      1 << 20,
    );
    if (importCommit.status !== 0) {
      return {
        ...isolatedPush,
        stderr: [
          ...pushFailures,
          `consumer checkout import: ${importCommit.stderr.trim() || `git exited ${importCommit.status}`}`,
        ].join('\n'),
      };
    }
    const consumerCheckoutPush = runMapStoreNetworkGit(
      cwd,
      ['push', '-q', remote, `${mapStoreCommit}:refs/heads/${branch}`],
      1 << 20,
    );
    if (consumerCheckoutPush.status === 0) return consumerCheckoutPush;
    return {
      ...consumerCheckoutPush,
      stderr: [
        ...pushFailures,
        `consumer checkout push: ${gitFailureMessage(consumerCheckoutPush, `git exited ${consumerCheckoutPush.status}`)}`,
      ].join('\n'),
    };
  } finally {
    runGit(cwd, ['update-ref', '-d', mapStoreTipImportRef]);
  }
}

function removeTemporaryMapStoreCheckout(temporaryCheckout: string | undefined): void {
  removeTempWorkspace(temporaryCheckout);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publishMapStoreAttempt(options: {
  cwd: string;
  remote: string;
  branch: string;
  sha: string;
  compatibilityKey: string;
  target: string;
  dir: string;
  includeHar: boolean;
  manifest: MapManifest;
  authenticationArguments: string[];
}): { ok: boolean; phase: 'setup' | 'publish'; error: string } {
  let temporaryCheckout: string | undefined;
  try {
    temporaryCheckout = checkoutMapStore(options.cwd, options.remote, options.branch, options.sha);
    runGit(temporaryCheckout, ['config', 'user.name', 'github-actions[bot]']);
    runGit(temporaryCheckout, ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
    fs.writeFileSync(
      path.join(temporaryCheckout, 'README.md'),
      '# StyleProof maps\n\nMachine-generated reusable map bundles. Each folder is keyed by commit SHA and capture compatibility.\n',
    );
    removeDirRecursive(path.join(temporaryCheckout, options.target));
    copyDir(options.dir, path.join(temporaryCheckout, options.target), options.includeHar);
    if (!options.includeHar) {
      fs.writeFileSync(
        path.join(temporaryCheckout, options.target, MAP_MANIFEST),
        JSON.stringify({ ...options.manifest, har: false }, null, 2),
      );
    }
    runGit(temporaryCheckout, ['add', '-A', '--sparse', '--', 'README.md', options.target]);
    runGit(
      temporaryCheckout,
      ['commit', '-q', '-m', `StyleProof map ${options.sha.slice(0, 12)} ${options.compatibilityKey}`],
      1 << 20,
    );
    const push = pushMapStoreCommit(
      options.cwd,
      temporaryCheckout,
      options.remote,
      options.branch,
      options.authenticationArguments,
    );
    return { ok: push.status === 0, phase: 'publish', error: push.stderr.trim() || `git exited ${push.status}` };
  } catch (error) {
    return { ok: false, phase: 'setup', error: errorMessage(error) };
  } finally {
    removeTemporaryMapStoreCheckout(temporaryCheckout);
  }
}

export function publishMapBundle(options: {
  dir: string;
  branch?: string;
  remote?: string;
  cwd?: string;
  includeHar?: boolean;
}): { sha: string; compatibilityKey: string; branch: string } {
  const cwd = options.cwd ?? process.cwd();
  const branch = options.branch ?? DEFAULT_MAP_STORE_BRANCH;
  const remote = options.remote ?? DEFAULT_REMOTE;
  const manifest = readMapManifest(options.dir);
  if (!manifest) throw new MapStorePreconditionError(`no ${MAP_MANIFEST} in ${options.dir}`);
  if (manifest.dirty) {
    throw new MapStorePreconditionError(
      `not uploading ${options.dir}: working tree was dirty when the map was captured. Commit first, then rerun styleproof-map.`,
    );
  }
  if (!remoteExists(remote, cwd)) throw new MapStoreError(`git remote ${remote} was not found`);

  const sha = safeSegment(manifest.sha, 'sha');
  const compatibilityKey = safeSegment(manifest.compatibilityKey, 'compatibility key');
  const target = `${sha}/${compatibilityKey}`;
  const pushAuthenticationArguments = effectiveGitHttpExtraHeaders(cwd).flatMap(({ key, value }) => [
    '-c',
    `${key}=${value}`,
  ]);

  let ok = false;
  let lastError = '';
  const attemptFailures: string[] = [];
  for (let attempt = 1; attempt <= 5; attempt++) {
    const result = publishMapStoreAttempt({
      cwd,
      remote,
      branch,
      sha,
      compatibilityKey,
      target,
      dir: options.dir,
      includeHar: options.includeHar === true,
      manifest,
      authenticationArguments: pushAuthenticationArguments,
    });
    if (result.ok) {
      ok = true;
      break;
    }
    attemptFailures.push(`attempt ${attempt} ${result.phase}:\n${result.error}`);
    lastError = attemptFailures.join('\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 250);
  }
  if (!ok) throw new MapStoreError(lastError || `could not push ${branch}`);
  return { sha, compatibilityKey, branch };
}

/** Outcome of a single {@link restoreMapBundle} attempt. `miss` is an expected cache
 *  miss (never retried → NotFound); `infra` is a transient fault (retried). */
type RestoreAttemptResult =
  { status: 'hit'; manifest: MapManifest } | { status: 'miss'; message: string } | { status: 'infra'; message: string };

/** One restore attempt: probe the branch, checkout the one SHA's tree, copy the bundle.
 *  Classifies its own failure so the retry loop stays trivial — a plain `runGit` on the
 *  probe would misread a network blip as "branch does not exist" and force a needless cold
 *  recapture, so the bounded network git's `--exit-code` (2 = true miss) is what decides. */
function restoreMapStoreAttempt(options: {
  cwd: string;
  remote: string;
  branch: string;
  sha: string;
  compatibilityKey?: string;
  outDir: string;
}): RestoreAttemptResult {
  const { cwd, remote, branch, sha, compatibilityKey, outDir } = options;
  const branchLookup = runMapStoreNetworkGit(cwd, ['ls-remote', '--exit-code', '--heads', remote, branch], 1 << 20);
  if (branchLookup.status === 2) return { status: 'miss', message: `map store branch ${branch} does not exist` };
  if (branchLookup.status !== 0) {
    return { status: 'infra', message: gitFailureMessage(branchLookup, 'could not query map store branch') };
  }

  let tmp: string;
  try {
    // checkoutMapStore throws only on infra (clone/checkout/network) — a bundle simply
    // being absent surfaces below as an empty tree, not an exception.
    // Restore needs one exact-SHA subtree. Avoid downloading every tree on a
    // long-lived map-store branch before sparse checkout narrows the request.
    tmp = checkoutMapStore(cwd, remote, branch, sha, 'tree:0');
  } catch (error) {
    return { status: 'infra', message: errorMessage(error) };
  }

  try {
    const shaDir = path.join(tmp, sha);
    if (!fs.existsSync(shaDir)) return { status: 'miss', message: `no cached map for ${sha} on ${branch}` };
    const candidates = fs
      .readdirSync(shaDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !compatibilityKey || name === compatibilityKey)
      .sort();
    if (!candidates.length) {
      return {
        status: 'miss',
        message: compatibilityKey
          ? `no cached map for ${sha} with compatibility ${compatibilityKey} on ${branch}`
          : `no cached map bundle under ${sha} on ${branch}`,
      };
    }
    removeDirRecursive(outDir);
    copyDir(path.join(shaDir, candidates[0]), outDir, true);
    const manifest = readMapManifest(outDir);
    if (!manifest) return { status: 'miss', message: `cached map for ${sha} is missing ${MAP_MANIFEST}` };
    return { status: 'hit', manifest };
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
  const cwd = options.cwd ?? process.cwd();
  const branch = options.branch ?? DEFAULT_MAP_STORE_BRANCH;
  const remote = options.remote ?? DEFAULT_REMOTE;
  const sha = safeSegment(options.sha, 'sha');
  const compatibilityKey = options.compatibilityKey
    ? safeSegment(options.compatibilityKey, 'compatibility key')
    : undefined;
  if (!remoteExists(remote, cwd)) throw new MapStoreError(`git remote ${remote} was not found`);

  const attempts = mapStoreRestoreAttempts();
  let lastInfraError = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = restoreMapStoreAttempt({ cwd, remote, branch, sha, compatibilityKey, outDir: options.outDir });
    if (result.status === 'hit') return result.manifest;
    // A genuine miss is terminal — the cold path recaptures. Only infra faults retry.
    if (result.status === 'miss') throw new MapStoreNotFoundError(result.message);
    lastInfraError = result.message;
    if (attempt < attempts) mapStoreBackoff(attempt);
  }

  throw new MapStoreError(
    `could not restore ${sha} from ${branch} after ${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}: ` +
      (lastInfraError || 'unknown map store error'),
  );
}

/**
 * The commit SHAs that currently have at least one stored bundle on the map
 * store branch — the top-level directory names at the branch tip. One bounded
 * network operation: a `tree:0` no-checkout clone plus one root `ls-tree`, so
 * no map blob (and no subtree) is downloaded. A missing branch is an EMPTY set
 * (nothing stored yet, not a fault); any network/clone failure throws a plain
 * {@link MapStoreError} so the caller can fall back rather than trust a
 * partial listing. Used by the nearest-ancestor baseline reuse (#367).
 */
export function listMapStoreBundleShas(options: { branch?: string; remote?: string; cwd?: string } = {}): Set<string> {
  const cwd = options.cwd ?? process.cwd();
  const branch = options.branch ?? DEFAULT_MAP_STORE_BRANCH;
  const remote = options.remote ?? DEFAULT_REMOTE;
  if (!remoteExists(remote, cwd)) throw new MapStoreError(`git remote ${remote} was not found`);
  const branchLookup = runMapStoreNetworkGit(cwd, ['ls-remote', '--exit-code', '--heads', remote, branch], 1 << 20);
  if (branchLookup.status === 2) return new Set();
  if (branchLookup.status !== 0) {
    throw new MapStoreError(gitFailureMessage(branchLookup, 'could not query map store branch'));
  }
  const remoteUrl = gitOutput(cwd, ['remote', 'get-url', remote]);
  const httpExtraHeaders = effectiveGitHttpExtraHeaders(cwd);
  const authenticationArguments = httpExtraHeaders.flatMap(({ key, value }) => ['-c', `${key}=${value}`]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-map-store-list-'));
  try {
    const clone = runMapStoreNetworkGit(cwd, [
      ...authenticationArguments,
      'clone',
      '-q',
      '--filter=tree:0',
      '--no-checkout',
      '--depth',
      '1',
      '--single-branch',
      '--branch',
      branch,
      remoteUrl,
      tmp,
    ]);
    if (clone.status !== 0) throw new MapStoreError(gitFailureMessage(clone, 'could not clone map store branch'));
    // The lazy root-tree fetch below goes back through the promisor remote, so the
    // clone's checkout must carry the same auth the clone itself used.
    for (const { key, value } of httpExtraHeaders) runGit(tmp, ['config', '--local', '--add', key, value]);
    const listing = runMapStoreNetworkGit(tmp, ['ls-tree', '--name-only', 'HEAD'], 1 << 20);
    if (listing.status !== 0) {
      throw new MapStoreError(gitFailureMessage(listing, 'could not list map store bundles'));
    }
    return new Set(
      listing.stdout
        .split('\n')
        .map((name) => name.trim())
        .filter((name) => /^[0-9a-f]{7,40}$/i.test(name)),
    );
  } finally {
    removeTempWorkspace(tmp);
  }
}

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
  const baseSha = refSha(baseRef, cwd);
  const headSha = currentGitSha(cwd);
  const compatibilityKey = expectedCompatibilityKey({ cwd, spec: options.spec, baseUrl: options.baseUrl });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-cache-'));
  const beforeDir = path.join(tmpRoot, 'base');
  const afterDir = path.join(tmpRoot, 'head');
  let worktrees: CiWorktreeSession | undefined;
  try {
    const repoRoot = gitRepoRoot(cwd);
    const consumerRel = consumerRelativeFromRepoRoot(repoRoot, cwd);
    worktrees = new CiWorktreeSession(repoRoot);
    const baseWorktree = worktrees.addDetached(baseSha, 'cache-base');
    const baseCompatibilityKey = expectedCompatibilityKey({
      cwd: worktreeRunCwd(baseWorktree, consumerRel),
      spec: options.spec,
      baseUrl: options.baseUrl,
    });
    restoreMapBundle({
      sha: baseSha,
      outDir: beforeDir,
      branch: options.branch,
      remote: options.remote,
      cwd,
      compatibilityKey: baseCompatibilityKey,
    });
    restoreMapBundle({
      sha: headSha,
      outDir: afterDir,
      branch: options.branch,
      remote: options.remote,
      cwd,
      compatibilityKey,
    });
    return { beforeDir, afterDir, baseRef, baseSha, headSha, compatibilityKey, tmpRoot };
  } catch (e) {
    removeTempWorkspace(tmpRoot);
    throw e;
  } finally {
    worktrees?.dispose();
  }
}

export function cleanupCachedCaptureDirs(captureDirs: CachedCaptureDirs | null): void {
  if (captureDirs) removeTempWorkspace(captureDirs.tmpRoot);
}
