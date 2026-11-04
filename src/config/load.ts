/**
 * Discovery and loading of the consumer's `styleproof.config.ts` (or `.mjs` /
 * `.js` / legacy `.json`). Discovery walks upward from the start directory to the
 * git root through safe owned folders, including non-git project parents;
 * relative file-path fields resolve from that config file's directory, never from
 * `process.cwd()`. A missing file is `{}`; a file that exists but cannot be read,
 * evaluated, or validated throws — a discovered `.ts` never falls back to sibling
 * JSON or to the default spec.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { errorMessage } from '../util.js';
import {
  evaluateTypeScriptConfigSync,
  isUnloadableTypeScriptConfig,
  unloadableTypeScriptConfigError,
} from './load-ts.js';
import { configError, parseConfigRecord, plainObject, StyleProofConfigError, type StyleProofConfig } from './schema.js';

const CONFIG_TS = 'styleproof.config.ts';
const CONFIG_JSON = 'styleproof.config.json';
const ESM_CONFIG_FILENAMES = [CONFIG_TS, 'styleproof.config.mjs', 'styleproof.config.js'];
/** Filenames probed at each directory while walking toward the repo root. */
const CONFIG_FILENAMES = [...ESM_CONFIG_FILENAMES, CONFIG_JSON];

/** Built-in spec path when no config (and no `--spec`) declares one. */
export const DEFAULT_STYLEPROOF_SPEC = 'e2e/styleproof.spec.ts';

export type StyleProofConfigLocation = { path: string; dir: string; filename: string };

export type StyleProofConfigDiscovery = {
  location?: StyleProofConfigLocation;
  /** Every `styleproof.config.*` candidate probed, nearest first. */
  searched: string[];
  /** Config found beyond a trust boundary; never read or evaluated. */
  skippedConfig?: string;
};

export type StyleProofConfigLoad = {
  config: StyleProofConfig;
  /** Directory path fields resolve from: the config file's dir, or `startDir` if none. */
  configDir: string;
  configFile?: string;
  searched: string[];
  /** Config found beyond a trust boundary; never read or evaluated. */
  skippedConfig?: string;
};

/** Read + parse the legacy JSON config; undefined when it does not exist. */
function readJsonConfigObject(dir: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, CONFIG_JSON), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw configError(CONFIG_JSON, `could not read the file — ${errorMessage(e)}`);
  }
  try {
    return plainObject(JSON.parse(raw), 'the file', CONFIG_JSON);
  } catch (e) {
    if (e instanceof StyleProofConfigError) throw e;
    throw configError(CONFIG_JSON, `invalid JSON — ${errorMessage(e)}`);
  }
}

function loadJsonConfig(dir: string, deprecationWarning: boolean): StyleProofConfig {
  const record = readJsonConfigObject(dir);
  if (!record) return {};
  if (deprecationWarning) {
    process.stderr.write(
      `styleproof: ${CONFIG_JSON} is deprecated; migrate to ${CONFIG_TS} for type-safe config.\n` +
        `  Create styleproof.config.ts with: import { defineConfig } from 'styleproof'; export default defineConfig({ ... });\n`,
    );
  }
  return parseConfigRecord(record, CONFIG_JSON);
}

function findEsmConfig(dir: string): StyleProofConfigLocation | undefined {
  for (const filename of ESM_CONFIG_FILENAMES) {
    const configPath = path.join(dir, filename);
    if (fs.existsSync(configPath)) return { path: configPath, dir, filename };
  }
  return undefined;
}

/** Import a config's default record without applying the StyleProof policy schema. */
export async function importConfigRecord(filePath: string) {
  const mod = await import(pathToFileURL(filePath).href);

  return plainObject(mod.default ?? mod, 'the default export', path.basename(filePath));
}

/** Import an ESM config (.ts, .mjs, or .js); an unloadable `.ts` falls back to the sync evaluator. */
async function loadEsmConfig(found: StyleProofConfigLocation): Promise<Record<string, unknown>> {
  try {
    return await importConfigRecord(found.path);
  } catch (e) {
    if (e instanceof StyleProofConfigError) throw e;
    if (isUnloadableTypeScriptConfig(found.path, e)) {
      try {
        return evaluateTypeScriptConfigSync(found.path);
      } catch (syncError) {
        if (syncError instanceof StyleProofConfigError) throw syncError;
        throw unloadableTypeScriptConfigError(found.path, syncError);
      }
    }
    throw configError(found.filename, `could not load — ${errorMessage(e)}`);
  }
}

function locationAt(dir: string): StyleProofConfigLocation | undefined {
  const esm = findEsmConfig(dir);
  if (esm) return esm;
  const jsonPath = path.join(dir, CONFIG_JSON);
  return fs.existsSync(jsonPath) ? { path: jsonPath, dir, filename: CONFIG_JSON } : undefined;
}

function unsafeDiscoveryFolder(dir: string): string | undefined {
  try {
    const stat = fs.statSync(dir);
    if (stat.uid !== process.getuid!() && stat.uid !== 0) return 'owned by another user';
    if (stat.mode & 0o002) return 'world-writable';
    return undefined;
  } catch {
    return 'cannot stat folder';
  }
}

function findGitBoundary(start: string): string | undefined {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function discoveryFolderRejection(dir: string, start: string): string | undefined {
  if (dir === start || process.platform === 'win32') return undefined;
  return unsafeDiscoveryFolder(dir);
}

function endsDiscovery(dir: string, windowsBoundary: string | undefined): boolean {
  return fs.existsSync(path.join(dir, '.git')) || (process.platform === 'win32' && !windowsBoundary);
}

const reportedDiscoveryRefusals = new Set<string>();

function isConfigFile(configPath: string): boolean {
  try {
    return fs.statSync(configPath).isFile();
  } catch {
    return false;
  }
}

/** Probe existence only; never read or evaluate a skipped config. */
function reportDiscoveryRefusal(dir: string, reason: string): string | undefined {
  const remedy =
    'Next: run StyleProof from the folder that holds the config' +
    (process.platform === 'win32' ? '.' : '; on POSIX, fix ownership or remove world-write permission.');
  let candidate = dir;
  for (;;) {
    for (const filename of CONFIG_FILENAMES) {
      const configPath = path.join(candidate, filename);
      if (!isConfigFile(configPath)) continue;
      const notice = `styleproof: warning: ${configPath} was not loaded (${reason}); built-in defaults apply. ${remedy}\n`;
      if (reportedDiscoveryRefusals.has(notice)) return configPath;
      reportedDiscoveryRefusals.add(notice);
      process.stderr.write(notice);
      return configPath;
    }
    if (fs.existsSync(path.join(candidate, '.git'))) return;
    const parent = path.dirname(candidate);
    if (parent === candidate) return;
    candidate = parent;
  }
}

/** Accept the start folder; walk trusted ancestors up to the nearest .git marker. */
export function discoverStyleProofConfig(startDir = process.cwd()): StyleProofConfigDiscovery {
  const searched: string[] = [];
  const start = path.resolve(startDir);
  let dir = start;
  // These path-based checks do not prevent subtree renames between stat and import (TOCTOU).
  // POSIX mode checks do not inspect macOS ACLs.
  const windowsBoundary = process.platform === 'win32' ? findGitBoundary(start) : undefined;
  for (;;) {
    const reason = discoveryFolderRejection(dir, start);
    if (reason) {
      const skippedConfig = reportDiscoveryRefusal(dir, `unsafe folder ${dir}: ${reason}`);
      return { searched, skippedConfig };
    }
    searched.push(...CONFIG_FILENAMES.map((filename) => path.join(dir, filename)));
    const location = locationAt(dir);
    if (location) return { location, searched };
    if (endsDiscovery(dir, windowsBoundary)) {
      if (process.platform === 'win32' && !windowsBoundary && path.dirname(dir) !== dir) {
        const skippedConfig = reportDiscoveryRefusal(
          path.dirname(dir),
          'parent config outside a repository on Windows',
        );
        return { searched, skippedConfig };
      }
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { searched };
}

/** Resolve a config-declared file path from the config file's directory. */
export function resolveStyleProofConfigPath(filePath: string, configDir: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(configDir, filePath);
}

function resolvePathFields<T extends object>(
  block: T | undefined,
  configDir: string,
  fields: (keyof T)[],
): T | undefined {
  if (!block) return undefined;
  const out = { ...block };
  for (const field of fields) {
    const value = block[field];
    if (typeof value === 'string') out[field] = resolveStyleProofConfigPath(value, configDir) as T[keyof T];
  }
  return out;
}

/** Resolve filesystem path fields from `configDir`; non-file fields are unchanged. */
export function resolveStyleProofConfigFilePaths(config: StyleProofConfig, configDir: string): StyleProofConfig {
  const crawl = resolvePathFields(config.crawl, configDir, [
    'setup',
    'authBoundaryExclude',
    'incompleteUiExclude',
    'out',
  ]);
  const coverage = resolvePathFields(config.coverage, configDir, ['manifest']);
  const affected = resolvePathFields(config.affected, configDir, ['graph']);
  const productState = resolvePathFields(config.productState, configDir, ['legacyPairs', 'critical']);
  return {
    ...config,
    spec: config.spec === undefined ? undefined : resolveStyleProofConfigPath(config.spec, configDir),
    ...(crawl ? { crawl } : {}),
    ...(coverage ? { coverage } : {}),
    ...(affected ? { affected } : {}),
    ...(productState ? { productState } : {}),
  };
}

/** Import JavaScript at its original URL, preserving package semantics and module identity.
 *  Validate before serialization so invalid functions or toJSON hooks cannot hide policy. */
function loadJavaScriptConfigSync(found: StyleProofConfigLocation, asyncLoad = false): StyleProofConfig {
  const result = spawnSync(
    process.execPath,
    [
      ...(asyncLoad ? ['--require', fileURLToPath(new URL('../../bin/config-warnings.cjs', import.meta.url))] : []),
      '--input-type=module',
      '-e',
      `import { writeFileSync } from 'node:fs';
       import { plainObject, parseConfigRecord } from ${JSON.stringify(new URL('./schema.js', import.meta.url).href)};
       try {
       ${
         asyncLoad
           ? `const { loadStyleProofConfigWithLocationAsync } = await import(${JSON.stringify(import.meta.url)});
              const { config } = await loadStyleProofConfigWithLocationAsync(${JSON.stringify(found.dir)});`
           : `const mod = await import(${JSON.stringify(pathToFileURL(found.path).href)});
              const config = plainObject(mod.default ?? mod, 'the default export', ${JSON.stringify(found.filename)});`
       }
       writeFileSync(3, JSON.stringify(structuredClone(parseConfigRecord(config, ${JSON.stringify(found.filename)}))));
       } catch (error) {
         process.stderr.write(error instanceof Error ? error.message : String(error));
         process.exitCode = 1;
       }
       await Promise.all([process.stdout, process.stderr].map(stream => new Promise(resolve => stream.write('', resolve))));
       process.exit(process.exitCode ?? 0);`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', 'pipe'] },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.error || result.status !== 0) {
    const reason =
      (result.stderr || '').trim() ||
      (result.error ? errorMessage(result.error) : `config process exited ${result.status}`);
    if (reason.startsWith(`${found.filename}:`)) throw new StyleProofConfigError(reason);
    throw configError(found.filename, `could not load — ${reason}`);
  }
  if (result.stderr) process.stderr.write(result.stderr);
  try {
    return parseConfigRecord(
      plainObject(JSON.parse(String(result.output[3])), 'the default export', found.filename),
      found.filename,
    );
  } catch (error) {
    throw configError(found.filename, `could not load — ${errorMessage(error)}`);
  }
}

function parseLoadedConfigSync(dir: string): StyleProofConfig {
  const esm = findEsmConfig(dir);
  if (esm?.filename.endsWith('.ts')) return parseConfigRecord(evaluateTypeScriptConfigSync(esm.path), esm.filename);
  if (!esm) return loadJsonConfig(dir, true);
  return loadJavaScriptConfigSync(esm);
}

async function parseLoadedConfigAsync(dir: string): Promise<StyleProofConfig> {
  const esm = findEsmConfig(dir);
  if (!esm) return loadJsonConfig(dir, true);
  return parseConfigRecord(await loadEsmConfig(esm), esm.filename);
}

function located(
  startDir: string,
  config: StyleProofConfig,
  discovery: StyleProofConfigDiscovery,
): StyleProofConfigLoad {
  return {
    config,
    configDir: discovery.location?.dir ?? startDir,
    configFile: discovery.location?.filename,
    searched: discovery.searched,
    skippedConfig: discovery.skippedConfig,
  };
}

/** Sync load plus the directory the file was found in (or `cwd` when none exists). */
export function loadStyleProofConfigWithLocation(cwd = process.cwd()): StyleProofConfigLoad {
  const startDir = path.resolve(cwd);
  const discovery = discoverStyleProofConfig(startDir);
  return located(startDir, discovery.location ? parseLoadedConfigSync(discovery.location.dir) : {}, discovery);
}

/** Async load plus location; isolate checkout imports when another dependency copy may already be loaded. */
export async function loadStyleProofConfigWithLocationAsync(
  cwd = process.cwd(),
  options: { isolated?: boolean } = {},
): Promise<StyleProofConfigLoad> {
  const startDir = path.resolve(cwd);
  const discovery = discoverStyleProofConfig(startDir);
  const config = discovery.location
    ? options.isolated && discovery.location.filename !== CONFIG_JSON
      ? loadJavaScriptConfigSync(discovery.location, true)
      : await parseLoadedConfigAsync(discovery.location.dir)
    : {};
  return located(startDir, config, discovery);
}

/**
 * Sync load. A discovered `.ts`/`.mjs`/`.js` is evaluated or fails closed;
 * JSON-only emits a deprecation warning.
 */
export function loadStyleProofConfig(cwd = process.cwd()): StyleProofConfig {
  return loadStyleProofConfigWithLocation(cwd).config;
}

/** Async load: ESM config (.ts/.mjs/.js) over legacy JSON. */
export async function loadStyleProofConfigAsync(cwd = process.cwd()): Promise<StyleProofConfig> {
  return (await loadStyleProofConfigWithLocationAsync(cwd)).config;
}
