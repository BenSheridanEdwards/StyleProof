/**
 * The consumer-owned `styleproof.config.json` at the repo root, loaded once and
 * shared by every CLI. This is the "config-only integration" surface: a consumer
 * declares its project facts HERE — the spec path, the tracked files its dev
 * tooling rewrites, the surface → entry-module map — and the generated hook and
 * workflow stay generic, needing no per-repo flag threading and no edits when a
 * new knob ships.
 *
 * Precedence everywhere: explicit flag > environment variable > this file >
 * built-in default. The Action and CLIs share this validator, so a malformed
 * gate-policy key cannot silently fall back to a weaker default.
 *
 * A missing file is an empty config. A file that exists but cannot be parsed or
 * carries a wrongly-typed known key is a LOUD error: config the user wrote must
 * never be silently dropped (a typo'd `dirtyAllow` that quietly stops applying
 * would resurrect exactly the dirty-capture problem it exists to solve).
 */
import fs from 'node:fs';
import path from 'node:path';
import { readRegularFileNoFollow } from './safe-filesystem.js';
import { parseRequiredStateComparisons, type RequiredStateComparison } from './required-state-comparisons.js';

const STYLEPROOF_CONFIG_FILE = 'styleproof.config.json';

/** `styleproof-affected` inputs a consumer can pin once instead of per-invocation. */
export type AffectedConfig = {
  /** Capture key → surface entry module path (repo-relative, as in the graph). */
  surfaces?: Record<string, string>;
  /** Path to a dependency-cruiser JSON for the source tree. */
  graph?: string;
  /** Default git base ref for changed-file derivation (e.g. "origin/main"). */
  base?: string;
};

/** Pre-map / crawl adoption knobs a consumer can pin once in styleproof.config.json. */
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

export type StyleProofConfig = {
  /** Review-gate failures block the Action unless explicitly false. */
  blocking?: boolean;
  /** Unacknowledged inventory removals block unless explicitly false. */
  gateInventoryRemovals?: boolean;
  /** Capture spec path (default e2e/styleproof.spec.ts). */
  spec?: string;
  /** Tracked files/dirs whose changes never mark a capture dirty. */
  dirtyAllow?: string[];
  /** Map store branch (default styleproof-maps). */
  cacheBranch?: string;
  /** Git remote for the map store (default origin). */
  remote?: string;
  affected?: AffectedConfig;
  /** Closed, consumer-owned state × surface comparisons required for certification. */
  requiredStateComparisons?: RequiredStateComparison[];
  /** Closed-world crawl / auth-boundary adoption block. */
  crawl?: CrawlConfig;
};

class StyleProofConfigError extends Error {}

function fail(message: string): never {
  throw new StyleProofConfigError(`${STYLEPROOF_CONFIG_FILE}: ${message}`);
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

function plainObject(value: unknown, key: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${key} must be a JSON object`);
  return value as Record<string, unknown>;
}

/** Reject duplicate object keys before JSON.parse can erase checked-in policy. */
function assertNoDuplicateJsonKeys(raw: string): void {
  let at = 0;
  const space = () => {
    while (/\s/u.test(raw[at] ?? '')) at++;
  };
  const stringValue = (): string => {
    const start = at++;
    while (at < raw.length) {
      if (raw[at] === '\\') {
        at += 2;
        continue;
      }
      if (raw[at++] === '"') return JSON.parse(raw.slice(start, at)) as string;
    }
    throw new SyntaxError('unterminated string');
  };
  const value = (): void => {
    space();
    if (raw[at] === '{') return object();
    if (raw[at] === '[') return array();
    if (raw[at] === '"') {
      stringValue();
      return;
    }
    while (at < raw.length && !/[\s,}\]]/u.test(raw[at]!)) at++;
  };
  const object = (): void => {
    at++;
    const keys = new Set<string>();
    space();
    if (raw[at] === '}') {
      at++;
      return;
    }
    while (at < raw.length) {
      space();
      const key = stringValue();
      if (keys.has(key)) throw new StyleProofConfigError(`${STYLEPROOF_CONFIG_FILE}: duplicate object key`);
      keys.add(key);
      space();
      if (raw[at++] !== ':') throw new SyntaxError('expected colon');
      value();
      space();
      if (raw[at] === '}') {
        at++;
        return;
      }
      if (raw[at++] !== ',') throw new SyntaxError('expected comma');
    }
  };
  const array = (): void => {
    at++;
    space();
    if (raw[at] === ']') {
      at++;
      return;
    }
    while (at < raw.length) {
      value();
      space();
      if (raw[at] === ']') {
        at++;
        return;
      }
      if (raw[at++] !== ',') throw new SyntaxError('expected comma');
    }
  };
  value();
}

/** Read + parse the file; undefined when it does not exist. */
function readConfigObject(cwd: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readRegularFileNoFollow(path.join(cwd, STYLEPROOF_CONFIG_FILE)).toString('utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    fail(`could not read the file — ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const parsed = JSON.parse(raw);
    assertNoDuplicateJsonKeys(raw);
    return plainObject(parsed, 'the file');
  } catch (e) {
    if (e instanceof StyleProofConfigError) throw e;
    fail(`invalid JSON — ${e instanceof Error ? e.message : String(e)}`);
  }
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

const KNOWN_KEYS = [
  'blocking',
  'gateInventoryRemovals',
  'spec',
  'dirtyAllow',
  'cacheBranch',
  'remote',
  'affected',
  'requiredStateComparisons',
  'crawl',
];
const KNOWN_AFFECTED_KEYS = ['surfaces', 'graph', 'base'];
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

function normalizedConfigKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    let diagonal = previous[0];
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const above = previous[rightIndex];
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

function isLikelyRequiredStateComparisonsTypo(key: string): boolean {
  return editDistance(normalizedConfigKey(key), 'requiredstatecomparisons') <= 4;
}

/** Unknown keys are a LOUD stderr warning, not an error: a typo'd `dirtyallow`
 *  silently reverting to defaults is exactly the failure this file's contract
 *  forbids, but hard-failing would brick every CLI in a repo whose config
 *  carries a key from a newer styleproof release during a version skew. */
function warnUnknownKeys(record: Record<string, unknown>, known: string[], prefix: string): void {
  const unknown = Object.keys(record).filter((k) => !known.includes(k));
  if (unknown.length === 0) return;
  if (prefix === '' && unknown.some(isLikelyRequiredStateComparisonsTypo)) {
    fail('unknown certification-policy key; fix the spelling before certification');
  }
  process.stderr.write(
    `styleproof: ${STYLEPROOF_CONFIG_FILE}: unknown ${prefix}key(s) ignored: ${unknown.join(', ')} ` +
      `(known: ${known.join(', ')}) — fix the spelling or remove them\n`,
  );
}

function nearestConfigRoot(start: string): string | undefined {
  let current = path.resolve(start);
  try {
    if (!fs.statSync(current).isDirectory()) current = path.dirname(current);
  } catch {
    current = path.dirname(current);
  }
  while (true) {
    if (fs.existsSync(path.join(current, STYLEPROOF_CONFIG_FILE))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Resolve checked-in policy from capture ownership, failing on cross-project ambiguity. */
export function resolveStyleProofConfigRoot(captureDirs: readonly string[], fallbackRoot = process.cwd()): string {
  const roots = [...new Set(captureDirs.map(nearestConfigRoot).filter((root): root is string => Boolean(root)))];
  if (roots.length > 1) {
    fail(`capture directories resolve to different ${STYLEPROOF_CONFIG_FILE} files`);
  }
  return roots[0] ?? path.resolve(fallbackRoot);
}

export function loadRequiredStateComparisonsForCaptureDirs(
  captureDirs: readonly string[],
  fallbackRoot = process.cwd(),
): RequiredStateComparison[] {
  return loadStyleProofConfig(resolveStyleProofConfigRoot(captureDirs, fallbackRoot)).requiredStateComparisons ?? [];
}

/** Load and validate the repo's styleproof.config.json. Missing file → `{}`;
 *  unreadable/malformed file or a wrongly-typed known key → {@link StyleProofConfigError};
 *  unknown keys → a loud stderr warning (never silently dropped). */
export function loadStyleProofConfig(cwd = process.cwd()): StyleProofConfig {
  const record = readConfigObject(cwd);
  if (!record) return {};
  warnUnknownKeys(record, KNOWN_KEYS, '');
  if (record.affected && typeof record.affected === 'object' && !Array.isArray(record.affected)) {
    warnUnknownKeys(record.affected as Record<string, unknown>, KNOWN_AFFECTED_KEYS, '"affected" ');
  }
  return {
    blocking: optionalBoolean(record.blocking, 'blocking'),
    gateInventoryRemovals: optionalBoolean(record.gateInventoryRemovals, 'gateInventoryRemovals'),
    spec: optionalString(record.spec, 'spec'),
    dirtyAllow: optionalStringArray(record.dirtyAllow, 'dirtyAllow'),
    cacheBranch: optionalString(record.cacheBranch, 'cacheBranch'),
    remote: optionalString(record.remote, 'remote'),
    affected: parseAffected(record.affected),
    requiredStateComparisons:
      record.requiredStateComparisons === undefined
        ? undefined
        : parseRequiredStateComparisons(record.requiredStateComparisons),
    crawl: parseCrawl(record.crawl),
  };
}
