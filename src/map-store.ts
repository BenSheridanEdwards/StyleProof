import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { inferBaseRef } from './gitref.js';

export const DEFAULT_MAP_DIR = '.styleproof/maps';
export const DEFAULT_MAP_LABEL = 'current';
export const DEFAULT_MAP_STORE_BRANCH = 'styleproof-maps';
export const DEFAULT_REMOTE = 'origin';
export const MAP_MANIFEST = 'styleproof-manifest.json';

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

function runGit(cwd: string, args: string[], maxBuffer = 1 << 28) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer });
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
  const fromEnv = env.GITHUB_SHA || env.GITHUB_HEAD_SHA;
  if (fromEnv && /^[0-9a-f]{7,40}$/i.test(fromEnv)) return fromEnv;
  const sha = gitOutput(cwd, ['rev-parse', 'HEAD']);
  if (!sha) throw new MapStoreError('must run inside a git repository, or pass --sha <commit>');
  return sha;
}

export function refSha(ref: string, cwd = process.cwd()): string {
  const sha = gitOutput(cwd, ['rev-parse', `${ref}^{commit}`]);
  if (!sha) throw new MapStoreError(`could not resolve ${ref} to a commit`);
  return sha;
}

export function workingTreeDirty(cwd = process.cwd()): boolean {
  return gitOutput(cwd, ['status', '--porcelain']) !== '';
}

export function remoteExists(remote = DEFAULT_REMOTE, cwd = process.cwd()): boolean {
  return runGit(cwd, ['remote', 'get-url', remote], 1 << 20).status === 0;
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
  const manifest: MapManifest = {
    version: 1,
    packageVersion: input.packageVersion,
    sha: options.sha ?? currentGitSha(cwd, options.env),
    dirty: options.dirty ?? workingTreeDirty(cwd),
    spec: input.spec,
    specHash: input.specHash,
    ...(input.lockfile ? { lockfile: input.lockfile } : {}),
    ...(input.lockfileHash ? { lockfileHash: input.lockfileHash } : {}),
    ...(input.playwrightVersion ? { playwrightVersion: input.playwrightVersion } : {}),
    platform: input.platform,
    arch: input.arch,
    nodeMajor: input.nodeMajor,
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    screenshots: options.screenshots,
    har: hasHar(options.dir),
    compatibilityKey: hash(JSON.stringify(input)).slice(0, 16),
    createdAt: new Date().toISOString(),
  };
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
  if (JSON.stringify(beforeRuntime) === JSON.stringify(afterRuntime)) return;
  throw new MapStoreError(
    [
      'maps were captured in different runtime environments',
      `before ${before.sha.slice(0, 12)}: ${before.compatibilityKey} (${before.platform}/${before.arch}, Playwright ${before.playwrightVersion ?? 'unknown'})`,
      `after  ${after.sha.slice(0, 12)}: ${after.compatibilityKey} (${after.platform}/${after.arch}, Playwright ${after.playwrightVersion ?? 'unknown'})`,
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-map-store-'));
  if (runGit(cwd, ['ls-remote', '--exit-code', '--heads', remote, branch], 1 << 20).status === 0) {
    const clone = spawnSync('git', ['clone', '-q', '--depth', '1', '--branch', branch, remoteUrl, tmp], {
      encoding: 'utf8',
      maxBuffer: 1 << 20,
    });
    if (clone.status !== 0) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw new MapStoreError(clone.stderr.trim() || 'could not clone map store branch');
    }
  } else {
    runGit(tmp, ['init', '-q', '-b', branch]);
    runGit(tmp, ['remote', 'add', 'origin', remoteUrl]);
  }
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
