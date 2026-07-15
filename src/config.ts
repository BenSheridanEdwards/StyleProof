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

export const STYLEPROOF_CONFIG_FILE = 'styleproof.config.json';

/** `styleproof-affected` inputs a consumer can pin once instead of per-invocation. */
export type AffectedConfig = {
  /** Capture key → surface entry module path (repo-relative, as in the graph). */
  surfaces?: Record<string, string>;
  /** Path to a dependency-cruiser JSON for the source tree. */
  graph?: string;
  /** Default git base ref for changed-file derivation (e.g. "origin/main"). */
  base?: string;
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
};

export class StyleProofConfigError extends Error {}

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

/** Read + parse the file; undefined when it does not exist. */
function readConfigObject(cwd: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(cwd, STYLEPROOF_CONFIG_FILE), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    fail(`could not read the file — ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    return plainObject(JSON.parse(raw), 'the file');
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

/** Load and validate the repo's styleproof.config.json. Missing file → `{}`;
 *  unreadable/malformed file or a wrongly-typed known key → {@link StyleProofConfigError}. */
export function loadStyleProofConfig(cwd = process.cwd()): StyleProofConfig {
  const record = readConfigObject(cwd);
  if (!record) return {};
  return {
    blocking: optionalBoolean(record.blocking, 'blocking'),
    gateInventoryRemovals: optionalBoolean(record.gateInventoryRemovals, 'gateInventoryRemovals'),
    spec: optionalString(record.spec, 'spec'),
    dirtyAllow: optionalStringArray(record.dirtyAllow, 'dirtyAllow'),
    cacheBranch: optionalString(record.cacheBranch, 'cacheBranch'),
    remote: optionalString(record.remote, 'remote'),
    affected: parseAffected(record.affected),
  };
}
