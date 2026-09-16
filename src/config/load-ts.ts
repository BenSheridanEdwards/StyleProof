/**
 * Evaluating a discovered `styleproof.config.ts` without a loader. Bare
 * specifiers (`styleproof`) resolve from the config file's own package roots and,
 * for a linked git worktree, the host working tree's — never from `process.cwd()`.
 * Fails closed: an unloadable `.ts` throws and is never read as `{}`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gitOutput } from '../node-util.js';
import { errorMessage } from '../util.js';
import { plainObject, StyleProofConfigError } from './schema.js';

const UNLOADABLE_TS = 'STYLEPROOF_UNLOADABLE_TS';

export function isGitRoot(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code?: string }).code) : '';
}

function isMissingStyleProofPackage(error: unknown): boolean {
  const message = errorMessage(error);
  const moduleNotFound =
    errorCode(error) === 'ERR_MODULE_NOT_FOUND' ||
    message.includes('ERR_MODULE_NOT_FOUND') ||
    /cannot find package/i.test(message);
  return moduleNotFound && /styleproof/i.test(message);
}

/** A `.ts` import failure Node could not evaluate (no type stripping, or `styleproof` unresolvable). */
export function isUnloadableTypeScriptConfig(filename: string, error: unknown): boolean {
  if (!filename.endsWith('.ts')) return false;
  const code = errorCode(error);
  if (error instanceof StyleProofConfigError && code === UNLOADABLE_TS) return true;
  return (
    code === 'ERR_UNKNOWN_FILE_EXTENSION' ||
    /Unknown file extension|ERR_UNKNOWN_FILE_EXTENSION/.test(errorMessage(error)) ||
    isMissingStyleProofPackage(error)
  );
}

export function unloadableStyleProofConfigMessage(filePath: string, error: unknown): string {
  const reason = errorMessage(error);
  const lines = [`${filePath} could not be evaluated`, `  ${reason}`];
  if (isMissingStyleProofPackage(error) || /cannot find package/i.test(reason)) {
    lines.push('  searched package roots:', ...findStyleProofConfigPackageRoots(filePath).map((root) => `    ${root}`));
  }
  lines.push(
    '  Next: run on a Node that can evaluate TypeScript with the styleproof package resolvable, ' +
      'or replace styleproof.config.ts with styleproof.config.mjs / styleproof.config.js.',
  );
  return lines.join('\n');
}

export function unloadableTypeScriptConfigError(filePath: string, error: unknown): StyleProofConfigError {
  const wrapped = new StyleProofConfigError(unloadableStyleProofConfigMessage(filePath, error));
  (wrapped as { code?: string }).code = UNLOADABLE_TS;
  wrapped.cause = error instanceof Error ? error : undefined;
  return wrapped;
}

function gitRevParse(cwd: string, flag: string): string | undefined {
  const raw = gitOutput(cwd, ['rev-parse', flag]);
  if (!raw) return undefined;
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd, raw);
}

/** Main working-tree root when `cwd` is a linked git worktree; undefined in a normal checkout. */
function linkedHostWorkingTree(cwd: string): { hostRoot: string; toplevel: string } | undefined {
  const toplevel = gitRevParse(cwd, '--show-toplevel');
  const commonDir = gitRevParse(cwd, '--git-common-dir');
  if (!toplevel || !commonDir || path.basename(commonDir) !== '.git') return undefined;
  const hostRoot = path.dirname(commonDir);
  if (path.resolve(hostRoot) === path.resolve(toplevel)) return undefined;
  return { hostRoot, toplevel };
}

/** Every directory with a package.json walking up from `startDir` to `stopAt` (or the git root). */
function collectPackageJsonDirs(startDir: string, stopAt?: string): string[] {
  const packageRoots: string[] = [];
  let dir = path.resolve(startDir);
  const stop = stopAt === undefined ? undefined : path.resolve(stopAt);
  for (;;) {
    try {
      if (fs.existsSync(path.join(dir, 'package.json'))) packageRoots.push(dir);
    } catch {
      // unreadable directory — keep walking
    }
    if (stop !== undefined ? dir === stop : isGitRoot(dir)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return packageRoots;
}

function findHostWorktreePackageRoots(configDir: string): string[] {
  const linked = linkedHostWorkingTree(configDir);
  if (!linked) return [];
  const rel = path.relative(linked.toplevel, configDir);
  const hostStart =
    rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? path.join(linked.hostRoot, rel) : linked.hostRoot;
  return [...new Set([...collectPackageJsonDirs(hostStart, linked.hostRoot), linked.hostRoot])];
}

/** Package roots to resolve `styleproof` from: the config file's, then a linked worktree's host, then its own dir. */
function findStyleProofConfigPackageRoots(filePath: string): string[] {
  const configDir = path.dirname(path.resolve(filePath));
  return [...new Set([...collectPackageJsonDirs(configDir), ...findHostWorktreePackageRoots(configDir), configDir])];
}

function resolveFromPackageRoots(specifier: string, roots: readonly string[]): string | undefined {
  for (const root of roots) {
    try {
      return createRequire(path.join(root, 'package.json')).resolve(specifier);
    } catch {
      // try the next root
    }
  }
  return undefined;
}

const BARE_SPECIFIER_IN_IMPORT = /(?<=(?:^|[\s(;{])(?:import|export)(?:\s+type)?\b[^'"\n]*?)(['"])([^'"]+)\1/gm;
const LOCAL_SPECIFIER = /^(?:[./]|file:|node:|#)/;

function rewriteBareSpecifiersToResolvedUrls(source: string, roots: readonly string[]): string {
  return source.replace(BARE_SPECIFIER_IN_IMPORT, (full, quote: string, spec: string) => {
    if (LOCAL_SPECIFIER.test(spec)) return full;
    const resolved = resolveFromPackageRoots(spec, roots);
    return resolved ? `${quote}${pathToFileURL(resolved).href}${quote}` : full;
  });
}

const isDirectory = (dir: string): boolean => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

function nodePathForRoots(roots: readonly string[]): string {
  const dirs = roots.map((root) => path.join(root, 'node_modules')).filter(isDirectory);
  const existing = process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : [];
  return [...dirs, ...existing].join(path.delimiter);
}

function spawnConfigModuleEval(filePath: string, cwd: string, roots: readonly string[], extraNodeArgs: string[] = []) {
  return spawnSync(
    process.execPath,
    [
      ...extraNodeArgs,
      '--no-warnings',
      '--input-type=module',
      '-e',
      `import mod from ${JSON.stringify(pathToFileURL(filePath).href)};
       const config = mod?.default ?? mod;
       process.stdout.write(JSON.stringify(config));`,
    ],
    { encoding: 'utf8', cwd, env: { ...process.env, NODE_PATH: nodePathForRoots(roots) } },
  );
}

/** Run `run` against a temp copy of the config with bare specifiers rewritten to file URLs. */
function withRewrittenConfigCopy<T>(
  filePath: string,
  ext: '.mjs' | '.ts',
  run: (tmp: string, roots: string[], cwd: string) => T,
): T {
  const dir = path.dirname(filePath);
  const roots = findStyleProofConfigPackageRoots(filePath);
  const tmp = path.join(
    dir,
    `.styleproof-config-eval-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}${ext}`,
  );
  try {
    fs.writeFileSync(tmp, rewriteBareSpecifiersToResolvedUrls(fs.readFileSync(filePath, 'utf8'), roots));
    return run(tmp, roots, roots[0] ?? dir);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function parseEvalOutput(filePath: string, stdout: string): Record<string, unknown> {
  return plainObject(JSON.parse(stdout), 'the default export', path.basename(filePath));
}

/** JS-shaped `.ts` (no type syntax) — works on every supported Node, including 18/20. */
function evaluateTypeScriptAsPlainModuleSync(filePath: string): Record<string, unknown> {
  return withRewrittenConfigCopy(filePath, '.mjs', (tmp, roots, cwd) => {
    const result = spawnConfigModuleEval(tmp, cwd, roots);
    if (result.status !== 0) {
      throw new Error(
        (result.stderr || result.stdout || 'sync loader cannot evaluate TypeScript').trim() ||
          'sync loader cannot evaluate TypeScript; use loadStyleProofConfigAsync()',
      );
    }
    return parseEvalOutput(filePath, result.stdout);
  });
}

/** Evaluate a discovered `.ts` config synchronously: plain-module first, then type stripping. */
export function evaluateTypeScriptConfigSync(filePath: string): Record<string, unknown> {
  let plainError: unknown;
  try {
    return evaluateTypeScriptAsPlainModuleSync(filePath);
  } catch (error) {
    plainError = error;
  }
  const stripped = withRewrittenConfigCopy(filePath, '.ts', (tmp, roots, cwd) =>
    spawnConfigModuleEval(tmp, cwd, roots, ['--experimental-strip-types']),
  );
  if (stripped.status === 0) {
    try {
      return parseEvalOutput(filePath, stripped.stdout);
    } catch (error) {
      throw unloadableTypeScriptConfigError(filePath, error);
    }
  }
  const stripText = `${stripped.stderr ?? ''}${stripped.stdout ?? ''}`;
  if (/bad option|unknown option|is not allowed/i.test(stripText)) {
    throw unloadableTypeScriptConfigError(filePath, plainError);
  }
  throw unloadableTypeScriptConfigError(
    filePath,
    new Error(stripText.trim() || 'sync loader cannot evaluate TypeScript'),
  );
}
