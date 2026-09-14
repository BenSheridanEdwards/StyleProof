/**
 * The consumer-owned `styleproof.config.ts` (or legacy `styleproof.config.json`)
 * at the repo root, loaded once and shared by every CLI. This is the "config-only
 * integration" surface: a consumer declares its project facts HERE — the spec path,
 * the tracked files its dev tooling rewrites, the surface → entry-module map — and
 * the generated hook and workflow stay generic, needing no per-repo flag threading
 * and no edits when a new knob ships.
 *
 * Precedence everywhere: explicit flag > environment variable > this file >
 * built-in default. The Action and CLIs share this validator, so a malformed
 * gate-policy key cannot silently fall back to a weaker default.
 *
 * Discovery walks upward from the start directory to the git root (or filesystem
 * root) so a package-subdirectory cwd still finds the repo-root config. Relative
 * file-path fields (`spec`, crawl setup/exclude/out, `coverage.manifest`,
 * `affected.graph`) resolve from that config file's directory — never from
 * `process.cwd()` — so `spec: 'hud/tests/e2e/styleproof.spec.ts'` stays valid
 * when the CLI is invoked with `cwd=hud`. A missing file is an empty config. A
 * file that exists but cannot be parsed, evaluated, or carries a wrongly-typed
 * known key is a LOUD error: config the user wrote must never be silently
 * dropped (a typo'd `dirtyAllow` that quietly stops applying would resurrect
 * exactly the dirty-capture problem it exists to solve). An unloadable
 * `styleproof.config.ts` (unknown `.ts` extension, or `import { defineConfig }
 * from 'styleproof'` cannot resolve) fails closed — never `{}`, never a
 * sibling JSON policy, and never the default `e2e/styleproof.spec.ts` while
 * that file is the discovered config. A missing spec after that walk fails
 * closed and names every config path that was searched.
 *
 * Migration: TS config takes precedence. When only JSON exists, a deprecation
 * warning is emitted. Both formats work during transition.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const STYLEPROOF_CONFIG_TS = 'styleproof.config.ts';
const STYLEPROOF_CONFIG_MJS = 'styleproof.config.mjs';
const STYLEPROOF_CONFIG_JS = 'styleproof.config.js';
const STYLEPROOF_CONFIG_JSON = 'styleproof.config.json';

/** Filenames probed at each directory while walking toward the repo root. */
export const STYLEPROOF_CONFIG_FILENAMES = [
  STYLEPROOF_CONFIG_TS,
  STYLEPROOF_CONFIG_MJS,
  STYLEPROOF_CONFIG_JS,
  STYLEPROOF_CONFIG_JSON,
] as const;

/** Built-in spec path when no config (and no `--spec`) declares one. */
export const DEFAULT_STYLEPROOF_SPEC = 'e2e/styleproof.spec.ts';

/** `styleproof-affected` inputs a consumer can pin once instead of per-invocation. */
export type AffectedConfig = {
  /** Capture key → surface entry module path (repo-relative, as in the graph). */
  surfaces?: Record<string, string>;
  /** Path to a dependency-cruiser JSON for the source tree. */
  graph?: string;
  /** Default git base ref for changed-file derivation (e.g. "origin/main"). */
  base?: string;
};

/** Pre-map / crawl adoption knobs a consumer can pin once in styleproof.config.ts. */
export type CrawlConfig = {
  /** Running app origin for pre-map crawl / one-shot crawl (e.g. http://127.0.0.1:3000). */
  baseUrl?: string;
  /** Route paths or key=path entries for the crawl. */
  routes?: string[];
  /** JSON setup steps file (env-interpolated). Never put secrets here — use ${ENV}. */
  setup?: string;
  /** JSON auth-boundary exclusion file (key → reason). Limited evidence only. */
  authBoundaryExclude?: string;
  /** JSON incomplete-UI exclusion file (surface → reason). Limited evidence only. */
  incompleteUiExclude?: string;
  /** Fail when live-state fixtures or skipped candidates remain. */
  strict?: boolean;
  /** Variant crawl manifest output path. */
  out?: string;
  /** Max attempted actions per route. */
  maxActions?: number;
  /** Crawl viewport width. */
  width?: number;
  /** Crawl viewport height. */
  height?: number;
};

/**
 * Marker type for explicit environment variable references created by `env()`.
 * At runtime, these are resolved to actual values from process.env.
 */
export interface EnvRef {
  readonly __envRef: true;
  readonly name: string;
}

/** Regex for valid environment variable names: uppercase letters, digits, underscores. */
const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Create an explicit environment variable reference for use in config.
 * The variable name is validated at creation time and resolved at runtime.
 *
 * @example
 * ```ts
 * import { env, resolveEnvReferences } from 'styleproof';
 *
 * const config = {
 *   auth: {
 *     hudPassword: env('STYLEPROOF_HUD_PASSWORD'),
 *     apiToken: env('STYLEPROOF_API_TOKEN'),
 *   },
 * };
 * const resolved = resolveEnvReferences(config);
 * ```
 */
export function env(name: string): EnvRef {
  if (!ENV_VAR_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid env var name "${name}": must contain only uppercase letters, digits, and underscores, ` +
        `and start with a letter or underscore.`,
    );
  }
  return { __envRef: true, name };
}

/** Check if a value is an EnvRef marker object. */
function isEnvRef(value: unknown): value is EnvRef {
  return typeof value === 'object' && value !== null && (value as EnvRef).__envRef === true;
}

/** Extract env var name from ${VAR_NAME} syntax, or undefined if not a match. */
function parseEnvRefSyntax(value: string): string | undefined {
  const match = value.match(/^\$\{([^}]+)\}$/);
  return match ? match[1] : undefined;
}

/** Extract auth cross-reference from ${auth.X} syntax, or undefined if not a match. */
function parseAuthRefSyntax(value: string): string | undefined {
  const match = value.match(/^\$\{auth\.([^}]+)\}$/);
  return match ? match[1] : undefined;
}

/** Options for resolveEnvReferences. */
export interface ResolveEnvOptions {
  /** Collect resolved secret values into a Set for later redaction. */
  collectSecrets?: boolean;
}

/** Result of resolveEnvReferences when collectSecrets is true. */
export interface ResolveEnvResult<T> {
  resolved: T;
  secrets: Set<string>;
}

/**
 * Resolve all environment variable references in a config object.
 * Handles both ${VAR_NAME} string syntax and env() helper markers.
 * Also resolves ${auth.X} cross-references to auth block values.
 *
 * @throws Error if an env var is not set or has an invalid name
 */
export function resolveEnvReferences<T extends object>(
  config: T,
  options?: ResolveEnvOptions & { collectSecrets: true },
): ResolveEnvResult<T>;
export function resolveEnvReferences<T extends object>(config: T, options?: ResolveEnvOptions): T;
export function resolveEnvReferences<T extends object>(
  config: T,
  options?: ResolveEnvOptions,
): T | ResolveEnvResult<T> {
  const secrets = new Set<string>();
  const authBlock = (config as Record<string, unknown>).auth as Record<string, unknown> | undefined;

  // First pass: resolve auth block env vars
  const resolvedAuth: Record<string, string> = {};
  if (authBlock) {
    for (const [key, value] of Object.entries(authBlock)) {
      if (value === undefined) continue;
      resolvedAuth[key] = resolveEnvValue(value, key, secrets);
    }
  }

  // Second pass: resolve all values including ${auth.X} cross-references
  const resolved = deepResolve(config, resolvedAuth, secrets);

  if (options?.collectSecrets) {
    return { resolved, secrets };
  }
  return resolved;
}

/** Resolve an EnvRef to its value from process.env. */
function resolveEnvRefMarker(ref: EnvRef, secrets: Set<string>): string {
  const envValue = process.env[ref.name];
  if (envValue === undefined) {
    throw new Error(`Environment variable ${ref.name} is not set. Set it in your shell or CI secrets.`);
  }
  secrets.add(envValue);
  return envValue;
}

/** Resolve ${VAR_NAME} syntax to its value from process.env. */
function resolveEnvSyntax(envName: string, secrets: Set<string>): string {
  if (!ENV_VAR_NAME_PATTERN.test(envName)) {
    throw new Error(
      `Invalid env reference "\${${envName}}": env var name must contain only uppercase letters, ` +
        `digits, and underscores, and start with a letter or underscore.`,
    );
  }
  const envValue = process.env[envName];
  if (envValue === undefined) {
    throw new Error(`Environment variable ${envName} is not set. Set it in your shell or CI secrets.`);
  }
  secrets.add(envValue);
  return envValue;
}

/** Resolve a single env value (string with ${VAR} syntax or EnvRef). */
function resolveEnvValue(value: unknown, _key: string, secrets: Set<string>): string {
  if (isEnvRef(value)) return resolveEnvRefMarker(value, secrets);
  if (typeof value !== 'string') {
    throw new Error(`Expected string or env reference, got ${typeof value}`);
  }
  const envName = parseEnvRefSyntax(value);
  if (envName) return resolveEnvSyntax(envName, secrets);
  return value;
}

/** Resolve a string that may be ${auth.X}, ${VAR}, or plain text. */
function resolveStringValue(str: string, resolvedAuth: Record<string, string>, secrets: Set<string>): string {
  const authKey = parseAuthRefSyntax(str);
  if (authKey) {
    if (!(authKey in resolvedAuth)) {
      throw new Error(
        `Config reference \${auth.${authKey}} does not exist in the auth block. ` +
          `Available keys: ${Object.keys(resolvedAuth).join(', ') || '(none)'}`,
      );
    }
    return resolvedAuth[authKey];
  }
  const envName = parseEnvRefSyntax(str);
  if (envName) return resolveEnvSyntax(envName, secrets);
  return str;
}

/** Recursively resolve all env references in an object. */
function deepResolve<T>(obj: T, resolvedAuth: Record<string, string>, secrets: Set<string>): T {
  if (obj === null || obj === undefined) return obj;
  if (isEnvRef(obj)) return resolveEnvRefMarker(obj, secrets) as unknown as T;
  if (typeof obj === 'string') return resolveStringValue(obj, resolvedAuth, secrets) as unknown as T;
  if (Array.isArray(obj)) {
    return obj.map((item) => deepResolve(item, resolvedAuth, secrets)) as unknown as T;
  }
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = deepResolve(value, resolvedAuth, secrets);
    }
    return result as T;
  }
  return obj;
}

/**
 * Redact secret values from a string, replacing them with [REDACTED].
 * Use this to sanitize log output and error messages.
 */
export function redactSecrets(input: string, secrets: Set<string>): string {
  if (secrets.size === 0) return input;
  let result = input;
  for (const secret of secrets) {
    if (secret) {
      result = result.split(secret).join('[REDACTED]');
    }
  }
  return result;
}

/** Auth secret references — env variable or secret NAMES only, never plaintext passwords. */
export type AuthConfig = {
  /** HUD password env/secret name (e.g. '${STYLEPROOF_HUD_PASSWORD}'). Never plaintext. */
  hudPassword?: string | EnvRef;
  /** API token env/secret name. Never plaintext. */
  apiToken?: string | EnvRef;
};

/**
 * Map store configuration for git operations (token auth and timeouts).
 * Allows adopters to configure map-store behavior via styleproof.config.ts
 * instead of environment variables.
 */
export type MapStoreConfig = {
  /** Auth token for git operations. 'inherit' (default) uses GITHUB_TOKEN. */
  token?: 'inherit' | string;
  /** Git operation timeout in ms. Default 120_000 (120s). */
  gitTimeoutMs?: number;
  /** Retention period in days for prune operations. Must be positive when set. */
  pruneRetentionDays?: number;
  /** Budget in bytes for prune operations. Must be positive when set. */
  pruneBudgetBytes?: number;
};

/**
 * Ancestor baseline reuse configuration (opt-out, default enabled).
 * When enabled, StyleProof attempts to restore the nearest ancestor's bundle
 * when the exact base commit is missing from the map store.
 */
export type AncestorBaselineConfig = {
  /** Enable ancestor baseline reuse. Default true (opt-out to disable). */
  enabled?: boolean;
  /** Root directories to search for ancestor baselines. Default ['src']. */
  roots?: string[];
};

/**
 * Report store configuration for prune operations.
 * Allows adopters to configure report-store prune behavior via styleproof.config.ts
 * instead of CLI flags.
 */
export type ReportStoreConfig = {
  /** Retention period in days for prune operations. Must be positive when set. */
  pruneRetentionDays?: number;
  /** Budget in bytes for prune operations. Must be positive when set. */
  pruneBudgetBytes?: number;
};

/**
 * Coverage configuration for declaring expected surface keys via external manifest.
 * Allows adopters to generate manifest files from router config / sitemap and have
 * StyleProof validate coverage against them.
 */
export type CoverageConfig = {
  /** Path to JSON manifest of expected surface keys (resolved from the config directory). */
  manifest?: string;
  /** Fail if any expected surface is uncaptured. Default false. */
  strict?: boolean;
  /** Surfaces to exclude from coverage (key → reason). Reasons must be non-empty. */
  exclude?: Record<string, string>;
};

export type StyleProofConfig = {
  /** Review-gate failures block the Action unless explicitly false or set to 'advisory'. */
  blocking?: boolean | 'advisory';
  /** Require explicit reviewer approval for visual changes (Action input). */
  requireApproval?: boolean;
  /** Unacknowledged inventory removals block unless explicitly false. */
  gateInventoryRemovals?: boolean;
  /** Capture spec path (default e2e/styleproof.spec.ts). Resolved from the config directory. */
  spec?: string;
  /** Tracked files/dirs whose changes never mark a capture dirty. */
  dirtyAllow?: string[];
  /** Map store branch (default styleproof-maps). */
  cacheBranch?: string;
  /** Git remote for the map store (default origin). */
  remote?: string;
  /** Subdirs with their own surfaces (replaces dual-config pattern). */
  roots?: string[];
  affected?: AffectedConfig;
  /** Closed-world crawl / auth-boundary adoption block. */
  crawl?: CrawlConfig;
  /** Auth secret references (env/secret names only — never plaintext). */
  auth?: AuthConfig;
  /** Map store configuration (token auth, git timeouts). */
  mapStore?: MapStoreConfig;
  /** Ancestor baseline reuse configuration (opt-out, default enabled). */
  ancestorBaseline?: AncestorBaselineConfig;
  /** Report store configuration (prune retention and budget). */
  reportStore?: ReportStoreConfig;
  /** Suppress platform mismatch warning. Default true. */
  suppressPlatformWarning?: boolean;
  /** Coverage configuration for expected surface manifest. */
  coverage?: CoverageConfig;
};

/**
 * Type-safe config helper for `styleproof.config.ts`. Identity function that
 * provides IDE autocomplete and compile-time validation.
 *
 * @example
 * ```ts
 * // styleproof.config.ts
 * import { defineConfig } from 'styleproof';
 *
 * export default defineConfig({
 *   blocking: true,
 *   spec: 'e2e/styleproof.spec.ts',
 *   roots: ['hud'],
 * });
 * ```
 */
export function defineConfig(config: StyleProofConfig): StyleProofConfig {
  return config;
}

class StyleProofConfigError extends Error {}

let currentConfigFile = STYLEPROOF_CONFIG_JSON;

function fail(message: string): never {
  throw new StyleProofConfigError(`${currentConfigFile}: ${message}`);
}

function optionalString(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value) fail(`"${key}" must be a non-empty string`);
  return value;
}

function optionalStringArray(value: unknown, key: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v)) {
    fail(`"${key}" must be an array of non-empty strings`);
  }
  return value as string[];
}

function optionalBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') fail(`"${key}" must be a boolean`);
  return value;
}

function optionalBlockingValue(value: unknown, key: string): boolean | 'advisory' | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'advisory') return 'advisory';
  fail(`"${key}" must be a boolean or 'advisory'`);
}

function plainObject(value: unknown, key: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${key} must be a JSON object`);
  return value as Record<string, unknown>;
}

/** Read + parse JSON config; undefined when it does not exist. */
function readJsonConfigObject(cwd: string): Record<string, unknown> | undefined {
  let raw: string;
  const jsonPath = path.join(cwd, STYLEPROOF_CONFIG_JSON);
  try {
    raw = fs.readFileSync(jsonPath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    currentConfigFile = STYLEPROOF_CONFIG_JSON;
    fail(`could not read the file — ${e instanceof Error ? e.message : String(e)}`);
  }
  currentConfigFile = STYLEPROOF_CONFIG_JSON;
  try {
    return plainObject(JSON.parse(raw), 'the file');
  } catch (e) {
    if (e instanceof StyleProofConfigError) throw e;
    fail(`invalid JSON — ${e instanceof Error ? e.message : String(e)}`);
  }
}

function isMissingStyleProofPackage(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: string }).code) : '';
  return (
    (code === 'ERR_MODULE_NOT_FOUND' || message.includes('ERR_MODULE_NOT_FOUND')) &&
    (message.includes("Cannot find package 'styleproof'") || message.includes('Cannot find package "styleproof"'))
  );
}

function isUnloadableTypeScriptConfig(filename: string, error: unknown): boolean {
  if (!filename.endsWith('.ts')) return false;
  if (error instanceof StyleProofConfigError && (error as { code?: string }).code === 'STYLEPROOF_UNLOADABLE_TS') {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: string }).code) : '';
  return (
    code === 'ERR_UNKNOWN_FILE_EXTENSION' ||
    message.includes('Unknown file extension') ||
    message.includes('ERR_UNKNOWN_FILE_EXTENSION') ||
    // Node 22.18+ type-strips `.ts` by default (22.6+ with --experimental-strip-types).
    // styleproof-init's typed scaffold then `import { defineConfig } from 'styleproof'`.
    // Without a resolvable package (or without type stripping) that file cannot
    // be evaluated — fail closed; sibling JSON must not shadow a discovered `.ts`.
    isMissingStyleProofPackage(error)
  );
}

export function unloadableStyleProofConfigMessage(filePath: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return [
    `${filePath} could not be evaluated`,
    `  ${reason}`,
    `  Next: run on a Node that can evaluate TypeScript with the styleproof package resolvable, ` +
      `or replace ${STYLEPROOF_CONFIG_TS} with ${STYLEPROOF_CONFIG_MJS} / ${STYLEPROOF_CONFIG_JS}.`,
  ].join('\n');
}

function unloadableTypeScriptConfigError(filePath: string, error: unknown): StyleProofConfigError {
  const wrapped = new StyleProofConfigError(unloadableStyleProofConfigMessage(filePath, error));
  (wrapped as { code?: string }).code = 'STYLEPROOF_UNLOADABLE_TS';
  wrapped.cause = error instanceof Error ? error : undefined;
  return wrapped;
}

/** Load ESM config (.ts, .mjs, or .js) via dynamic import; undefined when it does not exist. */
async function loadEsmConfig(cwd: string): Promise<Record<string, unknown> | undefined> {
  const found = findEsmConfig(cwd);
  if (!found) return undefined;

  currentConfigFile = found.filename;
  try {
    const fileUrl = pathToFileURL(found.path).href;
    const mod = await import(fileUrl);
    const config = mod.default ?? mod;
    return plainObject(config, 'the default export');
  } catch (e) {
    if (e instanceof StyleProofConfigError) throw e;
    if (isUnloadableTypeScriptConfig(found.filename, e)) {
      throw unloadableTypeScriptConfigError(found.path, e);
    }
    fail(`could not load — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Check whether JSON config exists (for deprecation warning). */
function jsonConfigExists(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, STYLEPROOF_CONFIG_JSON));
}

/** Find the ESM config file (.ts, .mjs, or .js), returning the path and filename if found. */
function findEsmConfig(cwd: string): { path: string; filename: string } | undefined {
  for (const filename of [STYLEPROOF_CONFIG_TS, STYLEPROOF_CONFIG_MJS, STYLEPROOF_CONFIG_JS]) {
    const configPath = path.join(cwd, filename);
    if (fs.existsSync(configPath)) {
      return { path: configPath, filename };
    }
  }
  return undefined;
}

/** Emit deprecation warning for JSON config. */
function warnJsonDeprecation(): void {
  process.stderr.write(
    `styleproof: ${STYLEPROOF_CONFIG_JSON} is deprecated; migrate to ${STYLEPROOF_CONFIG_TS} for type-safe config.\n` +
      `  Create styleproof.config.ts with: import { defineConfig } from 'styleproof'; export default defineConfig({ ... });\n`,
  );
}

function parseSurfaces(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const surfaces = plainObject(value, '"affected.surfaces"');
  for (const [key, entry] of Object.entries(surfaces)) {
    if (typeof entry !== 'string' || !entry) fail(`"affected.surfaces.${key}" must be an entry module path`);
  }
  return surfaces as Record<string, string>;
}

function parseAffected(value: unknown): AffectedConfig | undefined {
  if (value === undefined) return undefined;
  const a = plainObject(value, '"affected"');
  return {
    graph: optionalString(a.graph, 'affected.graph'),
    base: optionalString(a.base, 'affected.base'),
    surfaces: parseSurfaces(a.surfaces),
  };
}

function optionalPositiveNumber(value: unknown, key: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail(`"${key}" must be a positive number`);
  }
  return value;
}

function parseCrawl(value: unknown): CrawlConfig | undefined {
  if (value === undefined) return undefined;
  const c = plainObject(value, '"crawl"');
  warnUnknownKeys(c, KNOWN_CRAWL_KEYS, '"crawl" ');
  return {
    baseUrl: optionalString(c.baseUrl, 'crawl.baseUrl'),
    routes: optionalStringArray(c.routes, 'crawl.routes'),
    setup: optionalString(c.setup, 'crawl.setup'),
    authBoundaryExclude: optionalString(c.authBoundaryExclude, 'crawl.authBoundaryExclude'),
    incompleteUiExclude: optionalString(c.incompleteUiExclude, 'crawl.incompleteUiExclude'),
    strict: optionalBoolean(c.strict, 'crawl.strict'),
    out: optionalString(c.out, 'crawl.out'),
    maxActions: optionalPositiveNumber(c.maxActions, 'crawl.maxActions'),
    width: optionalPositiveNumber(c.width, 'crawl.width'),
    height: optionalPositiveNumber(c.height, 'crawl.height'),
  };
}

function optionalEnvRef(value: unknown, key: string): string | EnvRef | undefined {
  if (value === undefined) return undefined;
  if (isEnvRef(value)) return value;
  if (typeof value !== 'string' || !value) fail(`"${key}" must be a non-empty string or env() reference`);
  return value;
}

function validateAuthValue(value: string | EnvRef | undefined, key: string): void {
  if (value === undefined) return;
  if (isEnvRef(value)) return;
  if (!value.includes('${') && !value.startsWith('$')) {
    fail(`"${key}" must reference an env/secret name (e.g. \${STYLEPROOF_HUD_PASSWORD}), never plaintext`);
  }
}

function parseAuth(value: unknown): AuthConfig | undefined {
  if (value === undefined) return undefined;
  const a = plainObject(value, '"auth"');
  warnUnknownKeys(a, KNOWN_AUTH_KEYS, '"auth" ');
  const hudPassword = optionalEnvRef(a.hudPassword, 'auth.hudPassword');
  const apiToken = optionalEnvRef(a.apiToken, 'auth.apiToken');
  validateAuthValue(hudPassword, 'auth.hudPassword');
  validateAuthValue(apiToken, 'auth.apiToken');
  const result: AuthConfig = {};
  if (hudPassword !== undefined) result.hudPassword = hudPassword;
  if (apiToken !== undefined) result.apiToken = apiToken;
  return result;
}

function parseMapStore(value: unknown): MapStoreConfig | undefined {
  if (value === undefined) return undefined;
  const m = plainObject(value, '"mapStore"');
  warnUnknownKeys(m, KNOWN_MAP_STORE_KEYS, '"mapStore" ');
  const token = optionalString(m.token, 'mapStore.token');
  const gitTimeoutMs = optionalPositiveNumber(m.gitTimeoutMs, 'mapStore.gitTimeoutMs');
  const pruneRetentionDays = optionalPositiveNumber(m.pruneRetentionDays, 'mapStore.pruneRetentionDays');
  const pruneBudgetBytes = optionalPositiveNumber(m.pruneBudgetBytes, 'mapStore.pruneBudgetBytes');
  const result: MapStoreConfig = {};
  if (token !== undefined) result.token = token;
  if (gitTimeoutMs !== undefined) result.gitTimeoutMs = gitTimeoutMs;
  if (pruneRetentionDays !== undefined) result.pruneRetentionDays = pruneRetentionDays;
  if (pruneBudgetBytes !== undefined) result.pruneBudgetBytes = pruneBudgetBytes;
  return result;
}

function parseAncestorBaseline(value: unknown): AncestorBaselineConfig | undefined {
  if (value === undefined) return undefined;
  const a = plainObject(value, '"ancestorBaseline"');
  warnUnknownKeys(a, KNOWN_ANCESTOR_BASELINE_KEYS, '"ancestorBaseline" ');
  const enabled = optionalBoolean(a.enabled, 'ancestorBaseline.enabled');
  const roots = optionalStringArray(a.roots, 'ancestorBaseline.roots');
  const result: AncestorBaselineConfig = {};
  if (enabled !== undefined) result.enabled = enabled;
  if (roots !== undefined) result.roots = roots;
  return result;
}

function parseReportStore(value: unknown): ReportStoreConfig | undefined {
  if (value === undefined) return undefined;
  const r = plainObject(value, '"reportStore"');
  warnUnknownKeys(r, KNOWN_REPORT_STORE_KEYS, '"reportStore" ');
  const pruneRetentionDays = optionalPositiveNumber(r.pruneRetentionDays, 'reportStore.pruneRetentionDays');
  const pruneBudgetBytes = optionalPositiveNumber(r.pruneBudgetBytes, 'reportStore.pruneBudgetBytes');
  const result: ReportStoreConfig = {};
  if (pruneRetentionDays !== undefined) result.pruneRetentionDays = pruneRetentionDays;
  if (pruneBudgetBytes !== undefined) result.pruneBudgetBytes = pruneBudgetBytes;
  return result;
}

function parseCoverageExclude(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const exclude = plainObject(value, '"coverage.exclude"');
  for (const [key, reason] of Object.entries(exclude)) {
    if (typeof reason !== 'string' || !reason) {
      fail(`"coverage.exclude.${key}" must be a non-empty reason string`);
    }
  }
  return exclude as Record<string, string>;
}

function parseCoverage(value: unknown): CoverageConfig | undefined {
  if (value === undefined) return undefined;
  const c = plainObject(value, '"coverage"');
  warnUnknownKeys(c, KNOWN_COVERAGE_KEYS, '"coverage" ');
  const manifest = optionalString(c.manifest, 'coverage.manifest');
  const strict = optionalBoolean(c.strict, 'coverage.strict');
  const exclude = parseCoverageExclude(c.exclude);
  const result: CoverageConfig = {};
  if (manifest !== undefined) result.manifest = manifest;
  if (strict !== undefined) result.strict = strict;
  if (exclude !== undefined) result.exclude = exclude;
  return result;
}

const KNOWN_KEYS = [
  'blocking',
  'requireApproval',
  'gateInventoryRemovals',
  'spec',
  'dirtyAllow',
  'cacheBranch',
  'remote',
  'roots',
  'affected',
  'crawl',
  'auth',
  'mapStore',
  'ancestorBaseline',
  'reportStore',
  'suppressPlatformWarning',
  'coverage',
];
const KNOWN_AFFECTED_KEYS = ['surfaces', 'graph', 'base'];
const KNOWN_AUTH_KEYS = ['hudPassword', 'apiToken'];
const KNOWN_MAP_STORE_KEYS = ['token', 'gitTimeoutMs', 'pruneRetentionDays', 'pruneBudgetBytes'];
const KNOWN_ANCESTOR_BASELINE_KEYS = ['enabled', 'roots'];
const KNOWN_REPORT_STORE_KEYS = ['pruneRetentionDays', 'pruneBudgetBytes'];
const KNOWN_CRAWL_KEYS = [
  'baseUrl',
  'routes',
  'setup',
  'authBoundaryExclude',
  'incompleteUiExclude',
  'strict',
  'out',
  'maxActions',
  'width',
  'height',
];
const KNOWN_COVERAGE_KEYS = ['manifest', 'strict', 'exclude'];

/** Unknown keys are a LOUD stderr warning, not an error: a typo'd `dirtyallow`
 *  silently reverting to defaults is exactly the failure this file's contract
 *  forbids, but hard-failing would brick every CLI in a repo whose config
 *  carries a key from a newer styleproof release during a version skew. */
function warnUnknownKeys(record: Record<string, unknown>, known: string[], prefix: string): void {
  const unknown = Object.keys(record).filter((k) => !known.includes(k));
  if (unknown.length === 0) return;
  process.stderr.write(
    `styleproof: ${currentConfigFile}: unknown ${prefix}key(s) ignored: ${unknown.join(', ')} ` +
      `(known: ${known.join(', ')}) — fix the spelling or remove them\n`,
  );
}

/** Parse and validate config record into typed StyleProofConfig. */
function parseConfigRecord(record: Record<string, unknown>): StyleProofConfig {
  warnUnknownKeys(record, KNOWN_KEYS, '');
  if (record.affected && typeof record.affected === 'object' && !Array.isArray(record.affected)) {
    warnUnknownKeys(record.affected as Record<string, unknown>, KNOWN_AFFECTED_KEYS, '"affected" ');
  }
  return {
    blocking: optionalBlockingValue(record.blocking, 'blocking'),
    requireApproval: optionalBoolean(record.requireApproval, 'requireApproval'),
    gateInventoryRemovals: optionalBoolean(record.gateInventoryRemovals, 'gateInventoryRemovals'),
    spec: optionalString(record.spec, 'spec'),
    dirtyAllow: optionalStringArray(record.dirtyAllow, 'dirtyAllow'),
    cacheBranch: optionalString(record.cacheBranch, 'cacheBranch'),
    remote: optionalString(record.remote, 'remote'),
    roots: optionalStringArray(record.roots, 'roots'),
    affected: parseAffected(record.affected),
    crawl: parseCrawl(record.crawl),
    auth: parseAuth(record.auth),
    mapStore: parseMapStore(record.mapStore),
    ancestorBaseline: parseAncestorBaseline(record.ancestorBaseline),
    reportStore: parseReportStore(record.reportStore),
    suppressPlatformWarning: optionalBoolean(record.suppressPlatformWarning, 'suppressPlatformWarning'),
    coverage: parseCoverage(record.coverage),
  };
}

export type StyleProofConfigLocation = {
  path: string;
  dir: string;
  filename: string;
};

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

export type ResolvedProjectSpec = {
  /** Absolute filesystem path of the spec. */
  spec: string;
  /** Spec path as declared in config / `--spec` / the built-in default. */
  specDeclared: string;
  configDir: string;
  configFile?: string;
  searched: string[];
};

export type ResolveProjectSpecOptions = {
  startDir?: string;
  /** Explicit `--spec`; resolved from `startDir`, not the config directory. */
  spec?: string;
  /** When true, a missing config file is an error that lists every path searched. */
  requireConfig?: boolean;
  /** When false, a missing spec file is still returned. Default true. */
  requireSpec?: boolean;
};

function isGitRoot(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

function candidatePathsAt(dir: string): string[] {
  return STYLEPROOF_CONFIG_FILENAMES.map((filename) => path.join(dir, filename));
}

function locationAt(dir: string): StyleProofConfigLocation | undefined {
  const esm = findEsmConfig(dir);
  if (esm) return { path: esm.path, dir, filename: esm.filename };
  if (jsonConfigExists(dir)) {
    return { path: path.join(dir, STYLEPROOF_CONFIG_JSON), dir, filename: STYLEPROOF_CONFIG_JSON };
  }
  return undefined;
}

/**
 * Walk from `startDir` toward the git root (or filesystem root) looking for
 * `styleproof.config.ts` / `.mjs` / `.js` / `.json`. The nearest directory that
 * has any of those files wins (ESM over JSON in that directory). Does not walk
 * past a `.git` boundary, so a parent checkout's config cannot leak in.
 */
export function discoverStyleProofConfig(startDir = process.cwd()): StyleProofConfigDiscovery {
  const searched: string[] = [];
  let dir = path.resolve(startDir);
  for (;;) {
    searched.push(...candidatePathsAt(dir));
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
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(configDir, filePath);
}

function resolveOptionalConfigPath(filePath: string | undefined, configDir: string): string | undefined {
  return filePath === undefined ? undefined : resolveStyleProofConfigPath(filePath, configDir);
}

/**
 * Resolve filesystem path fields in a loaded config from `configDir`.
 * Leaves non-file fields (`dirtyAllow`, `roots`, surface module ids) unchanged.
 */
export function resolveStyleProofConfigFilePaths(config: StyleProofConfig, configDir: string): StyleProofConfig {
  const crawl = config.crawl
    ? {
        ...config.crawl,
        setup: resolveOptionalConfigPath(config.crawl.setup, configDir),
        authBoundaryExclude: resolveOptionalConfigPath(config.crawl.authBoundaryExclude, configDir),
        incompleteUiExclude: resolveOptionalConfigPath(config.crawl.incompleteUiExclude, configDir),
        out: resolveOptionalConfigPath(config.crawl.out, configDir),
      }
    : undefined;
  const coverage = config.coverage
    ? { ...config.coverage, manifest: resolveOptionalConfigPath(config.coverage.manifest, configDir) }
    : undefined;
  const affected = config.affected
    ? { ...config.affected, graph: resolveOptionalConfigPath(config.affected.graph, configDir) }
    : undefined;
  return {
    ...config,
    spec: resolveOptionalConfigPath(config.spec, configDir),
    ...(crawl ? { crawl } : {}),
    ...(coverage ? { coverage } : {}),
    ...(affected ? { affected } : {}),
  };
}

export function missingStyleProofConfigMessage(searched: readonly string[]): string {
  return [
    'no styleproof.config.ts / .mjs / .js / .json found; searched:',
    ...searched.map((candidate) => `  ${candidate}`),
  ].join('\n');
}

export function missingStyleProofSpecMessage(options: {
  spec: string;
  specDeclared?: string;
  configFile?: string;
  searched?: readonly string[];
}): string {
  const lines = [`no StyleProof spec at ${options.spec}`];
  if (options.configFile && options.specDeclared) {
    lines.push(`  declared as "${options.specDeclared}" in ${options.configFile}`);
  } else if (options.configFile) {
    lines.push(`  declared in ${options.configFile}`);
  } else if (options.searched?.length) {
    lines.push('  no styleproof.config.ts / .mjs / .js / .json found; searched:');
    for (const candidate of options.searched) lines.push(`    ${candidate}`);
  }
  return lines.join('\n');
}

/** Evaluate a discovered `.ts` config in a child Node with type-stripping. */
function evaluateTypeScriptConfigSync(filePath: string): Record<string, unknown> {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      '--input-type=module',
      '-e',
      `import mod from ${JSON.stringify(pathToFileURL(filePath).href)};
       const config = mod?.default ?? mod;
       process.stdout.write(JSON.stringify(config));`,
    ],
    { encoding: 'utf8', cwd: path.dirname(filePath) },
  );
  if (result.status !== 0) {
    throw unloadableTypeScriptConfigError(
      filePath,
      new Error(
        (result.stderr || result.stdout || 'sync loader cannot evaluate TypeScript').trim() ||
          'sync loader cannot evaluate TypeScript; use loadStyleProofConfigAsync()',
      ),
    );
  }
  try {
    return plainObject(JSON.parse(result.stdout), 'the default export');
  } catch (error) {
    throw unloadableTypeScriptConfigError(filePath, error);
  }
}

function parseLoadedConfigSync(dir: string): StyleProofConfig {
  const esmConfig = findEsmConfig(dir);
  const hasJson = jsonConfigExists(dir);

  if (esmConfig?.filename.endsWith('.ts')) {
    return parseConfigRecord(evaluateTypeScriptConfigSync(esmConfig.path));
  }

  if (esmConfig) {
    process.stderr.write(
      `styleproof: ${esmConfig.filename} detected but sync loader called. ` +
        `Use loadStyleProofConfigAsync() to evaluate ${esmConfig.filename}.\n`,
    );
    if (hasJson) {
      const record = readJsonConfigObject(dir);
      if (!record) return {};
      return parseConfigRecord(record);
    }
    return {};
  }

  if (!hasJson) return {};

  warnJsonDeprecation();
  const record = readJsonConfigObject(dir);
  if (!record) return {};
  return parseConfigRecord(record);
}

async function parseLoadedConfigAsync(dir: string): Promise<StyleProofConfig> {
  const esmConfig = findEsmConfig(dir);
  const hasJson = jsonConfigExists(dir);

  if (esmConfig?.filename.endsWith('.ts')) {
    const record = await loadEsmConfig(dir);
    if (!record) {
      throw unloadableTypeScriptConfigError(esmConfig.path, new Error('TypeScript config could not be evaluated'));
    }
    return parseConfigRecord(record);
  }

  if (esmConfig) {
    const record = await loadEsmConfig(dir);
    if (record) return parseConfigRecord(record);
    throw unloadableTypeScriptConfigError(esmConfig.path, new Error('ESM config could not be evaluated'));
  }

  if (!hasJson) return {};

  warnJsonDeprecation();
  const record = readJsonConfigObject(dir);
  if (!record) return {};
  return parseConfigRecord(record);
}

/** Sync load plus the directory the file was found in (or `cwd` when none exists). */
export function loadStyleProofConfigWithLocation(cwd = process.cwd()): StyleProofConfigLoad {
  const startDir = path.resolve(cwd);
  const discovery = discoverStyleProofConfig(startDir);
  const configDir = discovery.location?.dir ?? startDir;
  const config = discovery.location ? parseLoadedConfigSync(configDir) : {};
  return {
    config,
    configDir,
    configFile: discovery.location?.filename,
    searched: discovery.searched,
  };
}

/** Async load plus the directory the file was found in (or `cwd` when none exists). */
export async function loadStyleProofConfigWithLocationAsync(cwd = process.cwd()): Promise<StyleProofConfigLoad> {
  const startDir = path.resolve(cwd);
  const discovery = discoverStyleProofConfig(startDir);
  const configDir = discovery.location?.dir ?? startDir;
  const config = discovery.location ? await parseLoadedConfigAsync(configDir) : {};
  return {
    config,
    configDir,
    configFile: discovery.location?.filename,
    searched: discovery.searched,
  };
}

/** Load and validate the repo's styleproof.config.json (sync). Missing file → `{}`;
 *  unreadable/malformed file or a wrongly-typed known key → {@link StyleProofConfigError};
 *  unknown keys → a loud stderr warning (never silently dropped).
 *
 *  Walks upward from `cwd` to the git root. When the discovered file is
 *  styleproof.config.ts, this evaluates it or fails closed — sibling JSON is
 *  never preferred for policy or spec. When styleproof.config.mjs/js exists,
 *  this emits a warning directing users to use loadStyleProofConfigAsync().
 *  When only JSON exists, a deprecation warning is emitted. */
export function loadStyleProofConfig(cwd = process.cwd()): StyleProofConfig {
  return loadStyleProofConfigWithLocation(cwd).config;
}

/** Async load and validate the repo's styleproof.config.ts/mjs/js (or legacy .json). Missing file → `{}`;
 *  unreadable/malformed file or a wrongly-typed known key → {@link StyleProofConfigError};
 *  unknown keys → a loud stderr warning (never silently dropped).
 *
 *  Walks upward from `cwd` to the git root. Precedence: ESM config (.ts/.mjs/.js) >
 *  JSON config. When only JSON exists, a deprecation warning is emitted. */
export async function loadStyleProofConfigAsync(cwd = process.cwd()): Promise<StyleProofConfig> {
  return (await loadStyleProofConfigWithLocationAsync(cwd)).config;
}

/**
 * Discover the governing config and resolve the capture spec to an absolute path
 * from the config directory (or from `startDir` when `--spec` is explicit).
 * Missing config (when required) or missing spec fails closed and lists the
 * paths that were searched.
 */
/** Prefer a cwd-relative spec when the resolved file sits under `cwd`; otherwise the absolute path. */
export function specPathForCwd(absoluteSpec: string, cwd: string): string {
  const rel = path.relative(path.resolve(cwd), path.resolve(absoluteSpec)).replaceAll('\\', '/');
  if (!rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) return path.resolve(absoluteSpec);
  return rel;
}

export function resolveProjectSpec(options: ResolveProjectSpecOptions = {}): ResolvedProjectSpec {
  const startDir = path.resolve(options.startDir ?? process.cwd());
  const loaded = loadStyleProofConfigWithLocation(startDir);
  if (options.requireConfig && !loaded.configFile) {
    throw new StyleProofConfigError(missingStyleProofConfigMessage(loaded.searched));
  }
  // DEFAULT applies only after a successful load. A discovered `.ts` that cannot
  // be evaluated throws above — it never reaches this fallback via `{}` or sibling JSON.
  const specDeclared = options.spec ?? loaded.config.spec ?? DEFAULT_STYLEPROOF_SPEC;
  const resolveFrom = options.spec !== undefined ? startDir : loaded.configDir;
  const spec = resolveStyleProofConfigPath(specDeclared, resolveFrom);
  const requireSpec = options.requireSpec !== false;
  if (requireSpec && !fs.existsSync(spec)) {
    throw new StyleProofConfigError(
      missingStyleProofSpecMessage({
        spec,
        specDeclared,
        configFile: loaded.configFile ? path.join(loaded.configDir, loaded.configFile) : undefined,
        searched: loaded.searched,
      }),
    );
  }
  return {
    spec,
    specDeclared,
    configDir: loaded.configDir,
    configFile: loaded.configFile,
    searched: loaded.searched,
  };
}
