import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { inferBaseRef } from './gitref.js';
import { COVERAGE_LEDGER } from './coverage.js';

export const DEFAULT_MAP_DIR = '.styleproof/maps';
export const DEFAULT_MAP_LABEL = 'current';
export const DEFAULT_MAP_STORE_BRANCH = 'styleproof-maps';
export const DEFAULT_REMOTE = 'origin';
export const MAP_MANIFEST = 'styleproof-manifest.json';
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

/** Bundle files that sit alongside the maps but are NOT surfaces (manifest, coverage
 *  ledger, and any future sidecar). Every place that enumerates surface maps must skip
 *  these, or a sidecar reads as a phantom "new surface". */
export const RESERVED_BUNDLE_FILES: ReadonlySet<string> = new Set([
  MAP_MANIFEST,
  COVERAGE_LEDGER,
  BROWSER_BUILD_SIDECAR,
]);

/** True for a captured surface map (`<key>@<width>.json[.gz]`), false for metadata. */
export function isMapFile(name: string): boolean {
  return !RESERVED_BUNDLE_FILES.has(name) && /\.json(\.gz)?$/.test(name);
}

export class MapStoreError extends Error {}

export interface MapManifest {
  version: 1;
  packageVersion: string;
  sha: string;
  dirty: boolean;
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

interface GitHttpExtraHeader {
  key: string;
  value: string;
}

function effectiveGitHttpExtraHeaders(cwd: string): GitHttpExtraHeader[] {
  const configuredHeaders = runGit(cwd, ['config', '--includes', '--get-regexp', '^http\\..*\\.extraheader$'], 1 << 20);
  if (configuredHeaders.status !== 0) return [];
  return configuredHeaders.stdout
    .split('\n')
    .filter(Boolean)
    .flatMap((configuredHeader) => {
      const separatorIndex = configuredHeader.indexOf(' ');
      if (separatorIndex === -1) return [];
      return [
        {
          key: configuredHeader.slice(0, separatorIndex),
          value: configuredHeader.slice(separatorIndex + 1),
        },
      ];
    });
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
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, BROWSER_BUILD_SIDECAR), 'utf8')) as {
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
  const specPath = path.resolve(options.cwd, options.spec);
  const lock = detectLockfile(options.cwd);
  return {
    packageVersion: styleProofPackageVersion(),
    spec: path.relative(options.cwd, specPath) || options.spec,
    specHash: hashFile(specPath) ?? 'missing',
    lockfile: lock.file,
    lockfileHash: lock.hash,
    playwrightVersion: playwrightVersion(options.cwd),
    platform: process.platform,
    arch: process.arch,
    nodeMajor: process.versions.node.split('.')[0] ?? process.versions.node,
    baseUrl: options.baseUrl,
  };
}

export function expectedCompatibilityKey(options: { cwd?: string; spec?: string; baseUrl?: string } = {}): string {
  return hash(
    JSON.stringify(
      compatibilityInput({
        cwd: options.cwd ?? process.cwd(),
        spec: options.spec ?? 'e2e/styleproof.spec.ts',
        baseUrl: options.baseUrl,
      }),
    ),
  ).slice(0, 16);
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
 * True if any tracked file is modified/added/deleted. `ignorePrefix` (a repo-relative
 * directory) is excluded — pass the map OUTPUT dir when re-sampling AFTER a capture, so
 * the maps the capture just wrote don't read as tree dirt and mask a real source edit.
 */
export function workingTreeDirty(cwd = process.cwd(), ignorePrefix?: string): boolean {
  const r = runGit(cwd, ['status', '--porcelain']);
  const status = r.status === 0 ? r.stdout.trimEnd() : '';
  if (!status) return false;
  const prefix = ignorePrefix ? `${ignorePrefix.replace(/\/+$/, '')}/` : undefined;
  return status.split(/\r?\n/).some((line) => {
    const file = line.slice(3).trim();
    if (!file || GENERATED_DIRTY_ALLOWLIST.has(file)) return false;
    if (prefix && (file === prefix.slice(0, -1) || file.startsWith(prefix))) return false;
    return true;
  });
}

export function remoteExists(remote = DEFAULT_REMOTE, cwd = process.cwd()): boolean {
  return runGit(cwd, ['remote', 'get-url', remote], 1 << 20).status === 0;
}

/** Assemble a {@link MapManifest} from the compatibility inputs and the caller-resolved
 *  git fields. Shared by {@link writeMapManifest} (spec capture) and
 *  {@link writeCaptureManifest} (one-shot capture) so the object shape lives in one place. */
function buildManifest(options: {
  dir: string;
  input: ReturnType<typeof compatibilityInput>;
  sha: string;
  dirty: boolean;
  screenshots: boolean;
}): MapManifest {
  const { dir, input } = options;
  const browserVersion = readBrowserBuildSidecar(dir);
  return {
    version: 1,
    packageVersion: input.packageVersion,
    sha: options.sha,
    dirty: options.dirty,
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
    compatibilityKey: hash(JSON.stringify(input)).slice(0, 16),
    createdAt: new Date().toISOString(),
  };
}

export function writeMapManifest(options: {
  dir: string;
  spec: string;
  sha?: string;
  screenshots: boolean;
  dirty?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): MapManifest {
  const cwd = options.cwd ?? process.cwd();
  const input = compatibilityInput({ cwd, spec: options.spec, baseUrl: options.env?.BASE_URL ?? process.env.BASE_URL });
  const manifest = buildManifest({
    dir: options.dir,
    input,
    sha: options.sha ?? currentGitSha(cwd, options.env),
    dirty: options.dirty ?? workingTreeDirty(cwd),
    screenshots: options.screenshots,
  });
  fs.writeFileSync(path.join(options.dir, MAP_MANIFEST), JSON.stringify(manifest, null, 2));
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
  fs.writeFileSync(path.join(options.dir, MAP_MANIFEST), JSON.stringify(manifest, null, 2));
  return manifest;
}

export function readMapManifest(dir: string): MapManifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MAP_MANIFEST), 'utf8')) as MapManifest;
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

export function assertCompatibleMapDirs(beforeDir: string, afterDir: string): void {
  const before = readMapManifest(beforeDir);
  const after = readMapManifest(afterDir);
  if (!before || !after) return;
  const beforeRuntime = {
    platform: before.platform,
    arch: before.arch,
    nodeMajor: before.nodeMajor,
    playwrightVersion: before.playwrightVersion ?? '',
    baseUrl: before.baseUrl ?? '',
  };
  const afterRuntime = {
    platform: after.platform,
    arch: after.arch,
    nodeMajor: after.nodeMajor,
    playwrightVersion: after.playwrightVersion ?? '',
    baseUrl: after.baseUrl ?? '',
  };
  // Browser build is the actual renderer, but it's optional: only compare when BOTH sides
  // carry it, so bundles cached before this field existed stay comparable to each other.
  // A field on one side only can't be a proven mismatch.
  if (before.browserVersion && after.browserVersion) {
    (beforeRuntime as Record<string, string>).browserVersion = before.browserVersion;
    (afterRuntime as Record<string, string>).browserVersion = after.browserVersion;
  }
  if (JSON.stringify(beforeRuntime) === JSON.stringify(afterRuntime)) return;
  const build = (m: MapManifest) => (m.browserVersion ? `, browser ${m.browserVersion}` : '');
  throw new MapStoreError(
    [
      'maps were captured in different runtime environments',
      `before ${before.sha.slice(0, 12)}: ${before.compatibilityKey} (${before.platform}/${before.arch}, Playwright ${before.playwrightVersion ?? 'unknown'}${build(before)})`,
      `after  ${after.sha.slice(0, 12)}: ${after.compatibilityKey} (${after.platform}/${after.arch}, Playwright ${after.playwrightVersion ?? 'unknown'}${build(after)})`,
      'Next: rebuild one side with styleproof-map in the same environment, or let CI recapture both maps.',
    ].join('\n'),
  );
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

function checkoutMapStore(cwd: string, remote: string, branch: string): string {
  if (!remoteExists(remote, cwd)) throw new MapStoreError(`git remote ${remote} was not found`);
  const remoteUrl = gitOutput(cwd, ['remote', 'get-url', remote]);
  const httpExtraHeaders = effectiveGitHttpExtraHeaders(cwd);
  const authenticationArguments = httpExtraHeaders.flatMap(({ key, value }) => ['-c', `${key}=${value}`]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-map-store-'));
  if (runGit(cwd, ['ls-remote', '--exit-code', '--heads', remote, branch], 1 << 20).status === 0) {
    const clone = spawnSync(
      'git',
      [...authenticationArguments, 'clone', '-q', '--depth', '1', '--branch', branch, remoteUrl, tmp],
      {
        encoding: 'utf8',
        maxBuffer: 1 << 20,
        env: gitProcessEnvironment(),
      },
    );
    if (clone.status !== 0) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw new MapStoreError(clone.stderr.trim() || 'could not clone map store branch');
    }
  } else {
    runGit(tmp, ['init', '-q', '-b', branch]);
    runGit(tmp, ['remote', 'add', 'origin', remoteUrl]);
  }
  for (const { key, value } of httpExtraHeaders) runGit(tmp, ['config', '--local', key, value]);
  return tmp;
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
  if (!manifest) throw new MapStoreError(`no ${MAP_MANIFEST} in ${options.dir}`);
  if (manifest.dirty) {
    throw new MapStoreError(
      `not uploading ${options.dir}: working tree was dirty when the map was captured. Commit first, then rerun styleproof-map.`,
    );
  }
  if (!remoteExists(remote, cwd)) throw new MapStoreError(`git remote ${remote} was not found`);

  const sha = safeSegment(manifest.sha, 'sha');
  const compatibilityKey = safeSegment(manifest.compatibilityKey, 'compatibility key');
  const target = `${sha}/${compatibilityKey}`;

  let ok = false;
  let lastError = '';
  for (let attempt = 1; attempt <= 5; attempt++) {
    const tmp = checkoutMapStore(cwd, remote, branch);
    try {
      runGit(tmp, ['config', 'user.name', 'github-actions[bot]']);
      runGit(tmp, ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);

      fs.writeFileSync(
        path.join(tmp, 'README.md'),
        '# StyleProof maps\n\nMachine-generated reusable map bundles. Each folder is keyed by commit SHA and capture compatibility.\n',
      );
      fs.rmSync(path.join(tmp, target), { recursive: true, force: true });
      copyDir(options.dir, path.join(tmp, target), options.includeHar === true);
      if (!options.includeHar) {
        fs.writeFileSync(path.join(tmp, target, MAP_MANIFEST), JSON.stringify({ ...manifest, har: false }, null, 2));
      }

      runGit(tmp, ['add', '-A']);
      runGit(tmp, ['commit', '-q', '-m', `StyleProof map ${sha.slice(0, 12)} ${compatibilityKey}`], 1 << 20);
      const push = runGit(tmp, ['push', '-q', 'origin', `HEAD:${branch}`], 1 << 20);
      if (push.status === 0) {
        ok = true;
        break;
      }
      lastError = push.stderr.trim();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 250);
  }
  if (!ok) throw new MapStoreError(lastError || `could not push ${branch}`);
  return { sha, compatibilityKey, branch };
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
  if (runGit(cwd, ['ls-remote', '--exit-code', '--heads', remote, branch], 1 << 20).status !== 0) {
    throw new MapStoreError(`map store branch ${branch} does not exist`);
  }

  const tmp = checkoutMapStore(cwd, remote, branch);
  try {
    const shaDir = path.join(tmp, sha);
    if (!fs.existsSync(shaDir)) throw new MapStoreError(`no cached map for ${sha} on ${branch}`);
    const candidates = fs
      .readdirSync(shaDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !compatibilityKey || name === compatibilityKey)
      .sort();
    if (!candidates.length) {
      throw new MapStoreError(
        compatibilityKey
          ? `no cached map for ${sha} with compatibility ${compatibilityKey} on ${branch}`
          : `no cached map bundle under ${sha} on ${branch}`,
      );
    }
    const src = path.join(shaDir, candidates[0]);
    fs.rmSync(options.outDir, { recursive: true, force: true });
    copyDir(src, options.outDir, true);
    const manifest = readMapManifest(options.outDir);
    if (!manifest) throw new MapStoreError(`cached map for ${sha} is missing ${MAP_MANIFEST}`);
    return manifest;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
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
  try {
    restoreMapBundle({
      sha: baseSha,
      outDir: beforeDir,
      branch: options.branch,
      remote: options.remote,
      cwd,
      compatibilityKey,
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
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    throw e;
  }
}

export function cleanupCachedCaptureDirs(captureDirs: CachedCaptureDirs | null): void {
  if (captureDirs) fs.rmSync(captureDirs.tmpRoot, { recursive: true, force: true });
}
