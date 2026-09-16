// The capture manifest: environment fingerprints, the compatibility key, git source
// identity (SHA + dirty state), and the strict v1 reader/writer.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { sha256 } from '../node-util.js';
import { readRegularFileNoFollow } from '../safe-filesystem.js';
import { realNow } from '../spec-clock.js';
import { MAP_MANIFEST, MapStoreError, readBrowserBuildSidecar, readSurfaceCaptureFailures } from './bundle.js';
import type { SurfaceCaptureFailure } from './bundle.js';
import { git, gitStdout } from './git-transport.js';
import {
  asRecord,
  boundedString,
  canonicalContentHash,
  canonicalInstant,
  hasDuplicateJsonKeys,
  matchesBoundedString,
  optionalBoundedString,
  readJsonFile,
} from './json.js';

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
  /** Real browser build; the npm `@playwright/test` version can hold constant while this changes. */
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

const MAX_MAP_MANIFEST_BYTES = 16_777_216;
const GENERATED_DIRTY_ALLOWLIST = new Set(['next-env.d.ts']);
const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;
const PLAYWRIGHT_PACKAGES = ['@playwright/test', 'playwright', 'playwright-core'];

const styleProofPackageVersion = (): string =>
  readJsonFile<{ version?: string }>(new URL('../../package.json', import.meta.url))?.version ?? 'unknown';

function playwrightVersion(cwd: string): string | undefined {
  try {
    const pkgPath = createRequire(path.join(cwd, 'package.json')).resolve('@playwright/test/package.json');
    return readJsonFile<{ version?: string }>(pkgPath)?.version;
  } catch {
    return undefined;
  }
}

function packageLockPlaywrightHash(content: Buffer): string | undefined {
  try {
    const lock = JSON.parse(content.toString('utf8')) as {
      packages?: Record<string, unknown>;
      dependencies?: Record<string, unknown>;
    };
    const runtime = PLAYWRIGHT_PACKAGES.map(
      (name) => [name, lock.packages?.[`node_modules/${name}`] ?? lock.dependencies?.[name]] as const,
    ).filter((entry) => entry[1] !== undefined);
    return runtime.length > 0 ? sha256(JSON.stringify(runtime)) : undefined;
  } catch {
    return undefined;
  }
}

/** Playwright descriptors of a text lockfile (pnpm, yarn, bun): `name@version` matches plus
 *  each Playwright block header with its resolved version. */
function textLockfilePlaywrightHash(content: Buffer): string | undefined {
  const text = content.toString('utf8');
  const descriptors = new Set<string>();
  for (const match of text.matchAll(/(?:@playwright\/test|playwright(?:-core)?)@(?:npm:)?([0-9][0-9A-Za-z.+-]*)/g)) {
    descriptors.add(match[0]);
  }
  for (const block of text.split(/\r?\n\s*\r?\n/)) {
    const header = block.split(/\r?\n/, 1)[0] ?? '';
    if (!/(?:@playwright\/test|playwright(?:-core)?)[@:"]/i.test(header)) continue;
    const version = block.match(/^\s*version:\s*['"]?([^'"\s]+)|^\s*version\s+['"]([^'"]+)/m);
    const resolvedVersion = version?.[1] ?? version?.[2];
    if (resolvedVersion) descriptors.add(`${header.trim()}=${resolvedVersion}`);
  }
  return descriptors.size > 0 ? sha256(JSON.stringify([...descriptors].sort())) : undefined;
}

function detectLockfile(cwd: string): { file?: string; hash?: string; playwrightRuntimeHash?: string } {
  for (const file of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']) {
    let content: Buffer;
    try {
      content = fs.readFileSync(path.join(cwd, file));
    } catch {
      continue;
    }
    const playwrightRuntimeHash =
      file === 'package-lock.json' ? packageLockPlaywrightHash(content) : textLockfilePlaywrightHash(content);
    return { file, hash: sha256(content), playwrightRuntimeHash };
  }
  return {};
}

function hasHar(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir, { withFileTypes: true }).some((entry) => {
    if (entry.isDirectory()) return hasHar(path.join(dir, entry.name));
    return entry.isFile() && entry.name.endsWith('.har');
  });
}

type CompatibilityInput = ReturnType<typeof compatibilityInput>;

function compatibilityInput(options: { cwd: string; spec: string; baseUrl?: string }) {
  // Resolve FIRST: a relative cwd made createRequire throw inside playwrightVersion, so
  // publish and restore stamped different keys for one environment and every lookup missed.
  const cwd = path.resolve(options.cwd);
  const specPath = path.resolve(cwd, options.spec);
  const lock = detectLockfile(cwd);
  let specHash: string;
  try {
    specHash = sha256(fs.readFileSync(specPath));
  } catch {
    specHash = 'missing';
  }
  return {
    packageVersion: styleProofPackageVersion(),
    spec: path.relative(cwd, specPath) || options.spec,
    specHash,
    lockfile: lock.file,
    lockfileHash: lock.hash,
    playwrightRuntimeHash: lock.playwrightRuntimeHash,
    playwrightVersion: playwrightVersion(cwd),
    platform: process.platform,
    arch: process.arch,
    nodeMajor: process.versions.node.split('.')[0] ?? process.versions.node,
    baseUrl: options.baseUrl,
  };
}

/** Hash only the capture-runtime inputs available both at capture time and in a detached
 *  restore probe (no node_modules): the full lockfile and installed Playwright stay
 *  provenance, the lockfile's Playwright descriptor is the contract. */
function compatibilityKeyForInput(input: CompatibilityInput): string {
  const { packageVersion, spec, specHash, playwrightRuntimeHash, platform, arch, nodeMajor, baseUrl } = input;
  const stable = { packageVersion, spec, specHash, playwrightRuntimeHash, platform, arch, nodeMajor, baseUrl };
  return sha256(JSON.stringify(stable)).slice(0, 16);
}

export function expectedCompatibilityKey(options: { cwd?: string; spec?: string; baseUrl?: string } = {}): string {
  const cwd = options.cwd ?? process.cwd();
  return compatibilityKeyForInput(
    compatibilityInput({ cwd, spec: options.spec ?? 'e2e/styleproof.spec.ts', baseUrl: options.baseUrl }),
  );
}

/** The PR / workflow_run head from the event payload. pull_request_target is deliberately
 *  absent: there GITHUB_SHA is the base tip, and relabeling it would hand the default
 *  checkout the fork's (attacker-chosen) head. */
function eventHeadSha(env: NodeJS.ProcessEnv): string | undefined {
  if (!env.GITHUB_EVENT_PATH || !['pull_request', 'workflow_run'].includes(env.GITHUB_EVENT_NAME ?? ''))
    return undefined;
  const event = readJsonFile<{ pull_request?: { head?: { sha?: string } }; workflow_run?: { head_sha?: string } }>(
    env.GITHUB_EVENT_PATH,
  );
  return event?.pull_request?.head?.sha ?? event?.workflow_run?.head_sha;
}

export function currentGitSha(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  // Explicit overrides always win; a malformed value errors instead of mislabeling.
  const explicit = env.STYLEPROOF_SHA || env.GITHUB_HEAD_SHA;
  if (explicit) {
    if (!COMMIT_SHA.test(explicit))
      throw new MapStoreError(`STYLEPROOF_SHA/GITHUB_HEAD_SHA is not a commit SHA: ${explicit}`);
    return explicit;
  }
  const fromEvent = eventHeadSha(env);
  const head = gitStdout(cwd, ['rev-parse', 'HEAD']);
  // The checked-out tree is the truth. Only a checkout of the synthetic GITHUB_SHA (merge
  // commit) is labeled with the event's real head; a base-branch checkout keeps its own SHA
  // so a base-tree map is never published under the head's store key.
  if (head) return fromEvent && head === env.GITHUB_SHA ? fromEvent : head;
  const fallback = fromEvent ?? env.GITHUB_SHA;
  if (fallback && COMMIT_SHA.test(fallback)) return fallback;
  throw new MapStoreError('must run inside a git repository, or pass --sha <commit>');
}

function unquotePorcelain(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value;
  }
}

/** Porcelain quotes special-character paths and renders renames as `old -> new`; both
 *  must be unwrapped or an allowance silently misses and reads as dirt. */
function porcelainPaths(line: string): string[] {
  const raw = line.slice(3).trim();
  return raw ? raw.split(' -> ').map((side) => unquotePorcelain(side.trim())) : [];
}

/** True if any tracked file is modified/added/deleted. `ignore` (repo-relative files or
 *  directories) covers the map output dir and `--dirty-allow` paths a tool rewrites every run. */
export function workingTreeDirty(cwd = process.cwd(), ignore?: string | readonly string[]): boolean {
  // --untracked-files=all: git otherwise collapses an untracked directory to `dir/`.
  const result = git(cwd, ['status', '--porcelain', '--untracked-files=all']);
  const status = result.status === 0 ? result.stdout.trimEnd() : '';
  if (!status) return false;
  const prefixes = (typeof ignore === 'string' ? [ignore] : (ignore ?? []))
    .filter(Boolean)
    .map((p) => `${p.replace(/\/+$/, '')}/`);
  const allowed = (file: string): boolean =>
    GENERATED_DIRTY_ALLOWLIST.has(file) ||
    prefixes.some((prefix) => file === prefix.slice(0, -1) || file.startsWith(prefix));
  // A rename dirties the tree unless BOTH sides are allowed.
  return status.split(/\r?\n/).some((line) => {
    const files = porcelainPaths(line);
    return files.length > 0 && !files.every(allowed);
  });
}

/** Drop undefined/empty optional fields so the serialized manifest carries only what was known. */
const compact = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;

function stampManifest(
  options: { dir: string; cwd?: string; env?: NodeJS.ProcessEnv; screenshots: boolean; dirtyAllow?: readonly string[] },
  spec: string,
  source: (cwd: string, env?: NodeJS.ProcessEnv) => Pick<MapManifest, 'sha' | 'dirty' | 'surfaceCaptureFailures'>,
): MapManifest {
  const cwd = options.cwd ?? process.cwd();
  const input = compatibilityInput({ cwd, spec, baseUrl: options.env?.BASE_URL ?? process.env.BASE_URL });
  const { sha, dirty, surfaceCaptureFailures } = source(cwd, options.env);
  const manifest = compact<MapManifest>({
    version: 1,
    packageVersion: input.packageVersion,
    sha,
    dirty,
    dirtyAllow: options.dirtyAllow?.length ? [...options.dirtyAllow] : undefined,
    spec: input.spec,
    specHash: input.specHash,
    lockfile: input.lockfile || undefined,
    lockfileHash: input.lockfileHash || undefined,
    playwrightVersion: input.playwrightVersion || undefined,
    browserVersion: readBrowserBuildSidecar(options.dir) || undefined,
    platform: input.platform,
    arch: input.arch,
    nodeMajor: input.nodeMajor,
    baseUrl: input.baseUrl || undefined,
    screenshots: options.screenshots,
    har: hasHar(options.dir),
    compatibilityKey: compatibilityKeyForInput(input),
    // Real wall clock even when the spec-process clock is frozen.
    createdAt: new Date(realNow()).toISOString(),
    surfaceCaptureFailures: surfaceCaptureFailures?.length ? surfaceCaptureFailures : undefined,
  });
  parseMapManifest(manifest);
  const serialized = JSON.stringify(manifest, null, 2);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_MAP_MANIFEST_BYTES) invalidMapManifest();
  fs.mkdirSync(options.dir, { recursive: true });
  fs.writeFileSync(path.join(options.dir, MAP_MANIFEST), serialized);
  return manifest;
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
  return stampManifest(options, options.spec, (cwd, env) => ({
    sha: options.sha ?? currentGitSha(cwd, env),
    dirty: options.dirty ?? workingTreeDirty(cwd),
    surfaceCaptureFailures: readSurfaceCaptureFailures(options.dir),
  }));
}

/** Manifest for a one-shot `styleproof-capture` output dir so a two-directory diff has the
 *  same-environment guard on both sides. May run OUTSIDE a git repo (a design mockup), so
 *  the git fields degrade: `sha` becomes `uncommitted` and `dirty` true. A one-shot capture
 *  has no spec file, so comparability is keyed off the capture inputs only. */
export function writeCaptureManifest(options: {
  dir: string;
  screenshots: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): MapManifest {
  return stampManifest(options, MAP_MANIFEST, (cwd) => {
    const sha = gitStdout(cwd, ['rev-parse', 'HEAD']) || 'uncommitted';
    return { sha, dirty: sha === 'uncommitted' ? true : workingTreeDirty(cwd) };
  });
}

function invalidMapManifest(): never {
  throw new MapStoreError(`invalid ${MAP_MANIFEST} — expected a valid v1 capture manifest`);
}

function validSurfaceCaptureFailures(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 10_000) return false;
  return value.every((entry) => {
    const failure = asRecord(entry);
    if (!failure || Object.keys(failure).some((field) => !['key', 'reason', 'kind'].includes(field))) return false;
    return (
      boundedString(failure.key, 256) &&
      boundedString(failure.reason) &&
      (failure.kind === undefined || failure.kind === 'capture')
    );
  });
}

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
type FieldRule = (value: unknown, manifest: Record<string, unknown>) => boolean;

/** One rule per manifest field; the key set doubles as the closed field list. */
const MANIFEST_FIELD_RULES: Record<keyof MapManifest, FieldRule> = {
  version: (value) => value === 1,
  packageVersion: (value) => boundedString(value, 128),
  sha: (value, manifest) =>
    matchesBoundedString(value, /^(?:[0-9a-f]{40}|uncommitted)$/, 40) &&
    (value !== 'uncommitted' || manifest.dirty === true),
  dirty: (value) => typeof value === 'boolean',
  dirtyAllow: (value) =>
    value === undefined ||
    (Array.isArray(value) && value.length <= 1_000 && value.every((entry) => boundedString(entry))),
  spec: (value) => boundedString(value),
  specHash: canonicalContentHash,
  lockfile: (value, manifest) =>
    value === undefined
      ? manifest.lockfileHash === undefined
      : boundedString(value) && /^[A-Za-z0-9._/-]+$/.test(value) && canonicalContentHash(manifest.lockfileHash),
  lockfileHash: () => true, // paired with `lockfile` above
  playwrightVersion: (value) => optionalBoundedString(value, 128),
  browserVersion: (value) => optionalBoundedString(value, 256),
  platform: (value) => matchesBoundedString(value, SAFE_NAME, 128),
  arch: (value) => matchesBoundedString(value, SAFE_NAME, 128),
  nodeMajor: (value) => matchesBoundedString(value, /^\d+$/, 16),
  baseUrl: (value) => optionalBoundedString(value),
  screenshots: (value) => typeof value === 'boolean',
  har: (value) => typeof value === 'boolean',
  compatibilityKey: (value) => matchesBoundedString(value, /^[0-9a-f]{16}$/, 16),
  createdAt: canonicalInstant,
  surfaceCaptureFailures: validSurfaceCaptureFailures,
};

function parseMapManifest(value: unknown): MapManifest {
  const manifest = asRecord(value);
  if (!manifest) return invalidMapManifest();
  const valid =
    Object.keys(manifest).every((field) => Object.hasOwn(MANIFEST_FIELD_RULES, field)) &&
    Object.entries(MANIFEST_FIELD_RULES).every(([field, rule]) => rule(manifest[field], manifest));
  if (!valid) invalidMapManifest();
  return manifest as unknown as MapManifest;
}

/** `null` when absent; throws for anything present that is not a valid v1 manifest. */
export function readMapManifest(dir: string): MapManifest | null {
  let content: string;
  try {
    content = readRegularFileNoFollow(path.join(dir, MAP_MANIFEST), MAX_MAP_MANIFEST_BYTES).toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return invalidMapManifest();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return invalidMapManifest();
  }
  if (hasDuplicateJsonKeys(content)) invalidMapManifest();
  return parseMapManifest(parsed);
}
