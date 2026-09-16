/**
 * Discovery and loading of the consumer's `styleproof.config.ts` (or `.mjs` /
 * `.js` / legacy `.json`). Discovery walks upward from the start directory to the
 * git root, so a package-subdirectory cwd still finds the repo-root config;
 * relative file-path fields resolve from that config file's directory, never from
 * `process.cwd()`. A missing file is `{}`; a file that exists but cannot be read,
 * evaluated, or validated throws — a discovered `.ts` never falls back to sibling
 * JSON or to the default spec.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { errorMessage } from '../util.js';
import {
  evaluateTypeScriptConfigSync,
  isGitRoot,
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
};

export type StyleProofConfigLoad = {
  config: StyleProofConfig;
  /** Directory path fields resolve from: the config file's dir, or `startDir` if none. */
  configDir: string;
  configFile?: string;
  searched: string[];
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

/** Import an ESM config (.ts, .mjs, or .js); an unloadable `.ts` falls back to the sync evaluator. */
async function loadEsmConfig(found: StyleProofConfigLocation): Promise<Record<string, unknown>> {
  try {
    const mod = await import(pathToFileURL(found.path).href);
    return plainObject(mod.default ?? mod, 'the default export', found.filename);
  } catch (e) {
    if (e instanceof StyleProofConfigError) throw e;
    if (isUnloadableTypeScriptConfig(found.filename, e)) {
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

/**
 * Walk from `startDir` toward the git root (or filesystem root); the nearest
 * directory with any config file wins (ESM over JSON). Never walks past a `.git`
 * boundary, so a parent checkout's config cannot leak in.
 */
export function discoverStyleProofConfig(startDir = process.cwd()): StyleProofConfigDiscovery {
  const searched: string[] = [];
  let dir = path.resolve(startDir);
  for (;;) {
    searched.push(...CONFIG_FILENAMES.map((filename) => path.join(dir, filename)));
    const location = locationAt(dir);
    if (location) return { location, searched };
    if (isGitRoot(dir)) break;
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

function parseLoadedConfigSync(dir: string): StyleProofConfig {
  const esm = findEsmConfig(dir);
  if (esm?.filename.endsWith('.ts')) return parseConfigRecord(evaluateTypeScriptConfigSync(esm.path), esm.filename);
  if (!esm) return loadJsonConfig(dir, true);
  process.stderr.write(
    `styleproof: ${esm.filename} detected but sync loader called. ` +
      `Use loadStyleProofConfigAsync() to evaluate ${esm.filename}.\n`,
  );
  return loadJsonConfig(dir, false);
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
  };
}

/** Sync load plus the directory the file was found in (or `cwd` when none exists). */
export function loadStyleProofConfigWithLocation(cwd = process.cwd()): StyleProofConfigLoad {
  const startDir = path.resolve(cwd);
  const discovery = discoverStyleProofConfig(startDir);
  return located(startDir, discovery.location ? parseLoadedConfigSync(discovery.location.dir) : {}, discovery);
}

/** Async load plus the directory the file was found in (or `cwd` when none exists). */
export async function loadStyleProofConfigWithLocationAsync(cwd = process.cwd()): Promise<StyleProofConfigLoad> {
  const startDir = path.resolve(cwd);
  const discovery = discoverStyleProofConfig(startDir);
  return located(startDir, discovery.location ? await parseLoadedConfigAsync(discovery.location.dir) : {}, discovery);
}

/**
 * Sync load. A discovered `.ts` is evaluated or fails closed; a `.mjs`/`.js`
 * warns to use the async loader; JSON-only emits a deprecation warning.
 */
export function loadStyleProofConfig(cwd = process.cwd()): StyleProofConfig {
  return loadStyleProofConfigWithLocation(cwd).config;
}

/** Async load: ESM config (.ts/.mjs/.js) over legacy JSON. */
export async function loadStyleProofConfigAsync(cwd = process.cwd()): Promise<StyleProofConfig> {
  return (await loadStyleProofConfigWithLocationAsync(cwd)).config;
}
