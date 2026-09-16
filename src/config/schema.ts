/**
 * The `styleproof.config.*` shape and its key-by-key validators. A wrongly-typed
 * known key throws {@link StyleProofConfigError}: config the user wrote is never
 * silently dropped. Unknown keys warn loudly instead of failing so a config from
 * a newer release does not brick every CLI during a version skew.
 */

/** `styleproof-affected` inputs a consumer can pin once instead of per-invocation. */
export type AffectedConfig = {
  /** Capture key → surface entry module path (repo-relative, as in the graph). */
  surfaces?: Record<string, string>;
  /** Path to a dependency-cruiser JSON for the source tree. */
  graph?: string;
  /** Default git base ref for changed-file derivation (e.g. "origin/main"). */
  base?: string;
};

/** Pre-map / crawl adoption knobs: app origin, routes, JSON setup steps (env-interpolated — never
 *  secrets), auth-boundary / incomplete-UI exclusion files (key → reason), strict mode, variant
 *  manifest output path, and the crawl budget/viewport. */
export type CrawlConfig = {
  baseUrl?: string;
  routes?: string[];
  setup?: string;
  authBoundaryExclude?: string;
  incompleteUiExclude?: string;
  strict?: boolean;
  out?: string;
  maxActions?: number;
  width?: number;
  height?: number;
};

/** Map store git auth, timeouts, and prune defaults. */
export type MapStoreConfig = {
  /** Auth token for git operations. 'inherit' (default) uses GITHUB_TOKEN. */
  token?: 'inherit' | string;
  /** Git operation timeout in ms. Default 120_000. */
  gitTimeoutMs?: number;
  pruneRetentionDays?: number;
  pruneBudgetBytes?: number;
};

/** Ancestor baseline reuse (opt-out, default enabled); `roots` to search default to ['src']. */
export type AncestorBaselineConfig = { enabled?: boolean; roots?: string[] };

/** Report store prune defaults. */
export type ReportStoreConfig = { pruneRetentionDays?: number; pruneBudgetBytes?: number };

/** Expected surface keys via an external manifest. */
export type CoverageConfig = {
  /** Path to a JSON manifest of expected surface keys (resolved from the config directory). */
  manifest?: string;
  /** Fail if any expected surface is uncaptured. Default false. */
  strict?: boolean;
  /** Surfaces to exclude from coverage (key → reason). */
  exclude?: Record<string, string>;
};

/** Product-state comparability knobs. */
export type ProductStateConfig = {
  /** Same as `--require-state-identity`: every unproven pair is non-certifying. */
  requireIdentity?: boolean;
  /** Path to the legacy-pair declare file (`{"<surface>": "<why>"}`). */
  legacyPairs?: string;
  /** Path to the critical-states obligation file (`{"<surface>": {"owner", "reason"}}`). */
  critical?: string;
};

export type StyleProofConfig = {
  /** Review-gate failures block the Action unless explicitly false or 'advisory'. */
  blocking?: boolean | 'advisory';
  /** Require explicit reviewer approval for visual changes (Action input). */
  requireApproval?: boolean;
  /** Unacknowledged inventory removals block unless explicitly false. */
  gateInventoryRemovals?: boolean;
  /** Capture spec path (default e2e/styleproof.spec.ts), resolved from the config directory. */
  spec?: string;
  /** Tracked files/dirs whose changes never mark a capture dirty. */
  dirtyAllow?: string[];
  /** Map store branch (default styleproof-maps). */
  cacheBranch?: string;
  /** Git remote for the map store (default origin). */
  remote?: string;
  /** Subdirs with their own surfaces. */
  roots?: string[];
  affected?: AffectedConfig;
  crawl?: CrawlConfig;
  mapStore?: MapStoreConfig;
  ancestorBaseline?: AncestorBaselineConfig;
  reportStore?: ReportStoreConfig;
  /** Suppress the platform mismatch warning. Default true. */
  suppressPlatformWarning?: boolean;
  coverage?: CoverageConfig;
  productState?: ProductStateConfig;
};

export class StyleProofConfigError extends Error {}

export function configError(file: string, message: string): StyleProofConfigError {
  return new StyleProofConfigError(`${file}: ${message}`);
}

function fail(file: string, message: string): never {
  throw configError(file, message);
}

export function plainObject(value: unknown, label: string, file: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(file, `${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

/** Validates one defined value under its dotted key; returns the normalized value or throws. */
type Validator = (value: unknown, key: string, file: string) => unknown;
type Fields = Record<string, Validator>;

const string: Validator = (v, key, file) =>
  typeof v === 'string' && v ? v : fail(file, `"${key}" must be a non-empty string`);
const boolean: Validator = (v, key, file) => (typeof v === 'boolean' ? v : fail(file, `"${key}" must be a boolean`));
const stringArray: Validator = (v, key, file) =>
  Array.isArray(v) && v.every((s) => typeof s === 'string' && s)
    ? v
    : fail(file, `"${key}" must be an array of non-empty strings`);
const positiveNumber: Validator = (v, key, file) =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fail(file, `"${key}" must be a positive number`);
const blocking: Validator = (v, key, file) =>
  typeof v === 'boolean' || v === 'advisory' ? v : fail(file, `"${key}" must be a boolean or 'advisory'`);

/** `{ "<key>": "<non-empty string>" }` map; `what` names the expected value in the error. */
const stringMap =
  (what: string): Validator =>
  (v, key, file) => {
    const map = plainObject(v, `"${key}"`, file);
    for (const [entry, value] of Object.entries(map)) {
      if (typeof value !== 'string' || !value) fail(file, `"${key}.${entry}" must be ${what}`);
    }
    return map;
  };

function warnUnknownKeys(record: Record<string, unknown>, known: string[], prefix: string, file: string): void {
  const unknown = Object.keys(record).filter((k) => !known.includes(k));
  if (unknown.length === 0) return;
  process.stderr.write(
    `styleproof: ${file}: unknown ${prefix}key(s) ignored: ${unknown.join(', ')} ` +
      `(known: ${known.join(', ')}) — fix the spelling or remove them\n`,
  );
}

/** Validate each declared field; `dense` keeps absent fields as `undefined` keys. */
function parseFields(record: Record<string, unknown>, fields: Fields, prefix: string, file: string, dense: boolean) {
  const out: Record<string, unknown> = {};
  for (const [name, validate] of Object.entries(fields)) {
    const value = record[name];
    if (value !== undefined) out[name] = validate(value, `${prefix}${name}`, file);
    else if (dense) out[name] = undefined;
  }
  return out;
}

const block =
  (fields: Fields, dense = false): Validator =>
  (v, key, file) => {
    const record = plainObject(v, `"${key}"`, file);
    warnUnknownKeys(record, Object.keys(fields), `"${key}" `, file);
    return parseFields(record, fields, `${key}.`, file, dense);
  };

const SCHEMA: Fields = {
  blocking,
  requireApproval: boolean,
  gateInventoryRemovals: boolean,
  spec: string,
  dirtyAllow: stringArray,
  cacheBranch: string,
  remote: string,
  roots: stringArray,
  affected: block({ surfaces: stringMap('an entry module path'), graph: string, base: string }, true),
  crawl: block(
    {
      baseUrl: string,
      routes: stringArray,
      setup: string,
      authBoundaryExclude: string,
      incompleteUiExclude: string,
      strict: boolean,
      out: string,
      maxActions: positiveNumber,
      width: positiveNumber,
      height: positiveNumber,
    },
    true,
  ),
  mapStore: block({
    token: string,
    gitTimeoutMs: positiveNumber,
    pruneRetentionDays: positiveNumber,
    pruneBudgetBytes: positiveNumber,
  }),
  ancestorBaseline: block({ enabled: boolean, roots: stringArray }),
  reportStore: block({ pruneRetentionDays: positiveNumber, pruneBudgetBytes: positiveNumber }),
  suppressPlatformWarning: boolean,
  coverage: block({ manifest: string, strict: boolean, exclude: stringMap('a non-empty reason string') }),
  productState: block({ requireIdentity: boolean, legacyPairs: string, critical: string }),
};

/** Validate a raw config record (from JSON or a module's default export) into a typed config. */
export function parseConfigRecord(record: Record<string, unknown>, file: string): StyleProofConfig {
  warnUnknownKeys(record, Object.keys(SCHEMA), '', file);
  return parseFields(record, SCHEMA, '', file, true) as StyleProofConfig;
}
