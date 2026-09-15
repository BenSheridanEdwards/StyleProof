// Critical state obligations — declare state/surface IDs that must certify, or fail closed.
//
// Comparability has three postures today: an explicit `productState {id, revision}`
// pair certifies, `--require-state-identity` makes every unproven pair globally
// required, and the legacy-pairs ledger keeps known-legacy pairs advisory. This
// module is the inverse of the legacy ledger: instead of tolerating known debt,
// a consumer marks the obligations that MUST produce certifying evidence.
//
// Adopters declare critical capture/surface keys in `styleproof.critical-states.json`
// (`{"<surface>": {"owner": "...", "reason": "..."}}`; override the path with
// `STYLEPROOF_CRITICAL_STATES` or `--critical-states`, or set
// `productState.critical` in `styleproof.config.ts`). When the file is armed:
//
//   - a declared ID whose paired evidence is unproven or incomparable blocks,
//   - a declared ID with no paired evidence (removed surface, lost capture, or an
//     unknown ID) blocks — obligations can never silently expire,
//   - a declared ID that is also coverage-excluded is contradictory and blocks,
//   - comparable pairs still certify — criticality tightens, never downgrades.
//
// No scores, no tiers, no denominators: a declaration is binary must-certify.

import fs from 'node:fs';
import path from 'node:path';
import { surfaceBase } from './surface-keys.js';

/** Bounded owner/reason metadata for one critical obligation. */
export type CriticalObligation = { owner: string; reason: string };

/** `key -> {owner, reason}` — state/surface IDs that must produce certifying evidence. */
export type DeclaredCriticalObligations = Record<string, CriticalObligation>;

/** Obligation file, parallel to `styleproof.product-state.json`. */
export const CRITICAL_STATES_FILE = 'styleproof.critical-states.json';

/** Owner/reason are reviewer-facing metadata; bound them like declared recipe labels. */
const MAX_METADATA_LENGTH = 160;

export type CriticalObligationReceipt = {
  surface: string;
  status: string;
  required: boolean;
};

export type CriticalObligationAudit = {
  /** True when an obligation file was requested or found. */
  armed: boolean;
  /** Every declared obligation ID, sorted for stable output. */
  obligations: string[];
  /** Declared IDs whose paired evidence is comparable — the certifying path. */
  certified: string[];
  /** Declared IDs whose paired evidence is unproven or incomparable — blocks. */
  failing: string[];
  /** Declared IDs matching no paired surface evidence — lost capture, removed
   *  surface, or an unknown ID. Blocks; obligations cannot silently expire. */
  unresolved: string[];
  /** Declared IDs that are also coverage-excluded — contradictory policy. Blocks. */
  contradictory: string[];
};

function assertSafeObligationKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0 || key !== key.trim()) {
    throw new Error('critical state obligation key must be a non-empty surface or capture key');
  }
  if (key.includes('\0') || /[\\/]/.test(key) || key.includes('..') || key === '.' || path.isAbsolute(key)) {
    throw new Error('critical state obligation key is not a safe single path segment');
  }
}

function assertMetadata(value: unknown, field: string, key: string, source: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${source}: "${key}" requires a non-empty ${field} string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_METADATA_LENGTH || /[\r\n\0]/.test(trimmed)) {
    throw new Error(`${source}: "${key}" ${field} must be a single line of at most ${MAX_METADATA_LENGTH} characters`);
  }
  return trimmed;
}

function parseDeclaredCriticalObligations(raw: unknown, source: string): DeclaredCriticalObligations {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${source} must be a JSON object of {"<surface>": {"owner": "...", "reason": "..."}}`);
  }
  const declared: DeclaredCriticalObligations = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    assertSafeObligationKey(key);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${source}: "${key}" must be {"owner": "...", "reason": "..."}`);
    }
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record);
    if (fields.length !== 2 || !fields.includes('owner') || !fields.includes('reason')) {
      throw new Error(`${source}: "${key}" allows exactly owner and reason`);
    }
    declared[key] = {
      owner: assertMetadata(record.owner, 'owner', key, source),
      reason: assertMetadata(record.reason, 'reason', key, source),
    };
  }
  return declared;
}

function envCriticalStatesPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!Object.hasOwn(env, 'STYLEPROOF_CRITICAL_STATES')) return undefined;
  const fromEnv = env.STYLEPROOF_CRITICAL_STATES ?? '';
  return fromEnv === '' ? undefined : fromEnv;
}

/**
 * Flag > `$STYLEPROOF_CRITICAL_STATES` > config `productState.critical`.
 * An empty env value is an explicit unarm so a discovered config obligation
 * file is not inherited by synthetic contract fixtures.
 */
export function resolveConfiguredCriticalStatesPath(
  flagPath: string | undefined,
  configPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (flagPath !== undefined) return flagPath;
  if (Object.hasOwn(env, 'STYLEPROOF_CRITICAL_STATES')) return envCriticalStatesPath(env);
  return configPath;
}

/**
 * True when the obligation gate is armed: an explicit path or env was given, or
 * the default `styleproof.critical-states.json` exists in cwd.
 */
export function criticalStatesGateArmed(explicitPath?: string): boolean {
  if (explicitPath || envCriticalStatesPath()) return true;
  return fs.existsSync(path.resolve(CRITICAL_STATES_FILE));
}

/**
 * Read the obligation file. `{}` when the default path is absent; THROWS when an
 * explicit path/env is set but the file is missing or malformed — a broken
 * obligation ledger cannot silently un-mark critical states.
 */
export function readCriticalStatesFile(explicitPath?: string): DeclaredCriticalObligations {
  const requested = explicitPath || envCriticalStatesPath();
  const filePath = path.resolve(requested ?? CRITICAL_STATES_FILE);
  if (!fs.existsSync(filePath)) {
    if (requested) {
      throw new Error(
        `${filePath} is not readable — the critical-states obligation file is required when the gate is requested`,
      );
    }
    return {};
  }
  try {
    return parseDeclaredCriticalObligations(JSON.parse(fs.readFileSync(filePath, 'utf8')), filePath);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith(filePath)) throw e;
    if (e instanceof Error && e.message.includes('critical state obligation')) throw e;
    throw new Error(`${filePath} is not valid JSON — ${(e as Error).message}`, { cause: e });
  }
}

/** A declaration matches an exact capture key or its widthless surface base. */
export function obligationMatches(declaredKey: string, surface: string): boolean {
  return declaredKey === surface || declaredKey === surfaceBase(surface);
}

/**
 * Audit paired comparability receipts against the declared obligations.
 * `excludedKeys` is the coverage ledger's opt-out set — a declared obligation
 * that is also excluded is contradictory policy and fails closed.
 */
export function auditCriticalObligations(
  receipts: CriticalObligationReceipt[],
  declared: DeclaredCriticalObligations = {},
  excludedKeys: Iterable<string> = [],
  armed = false,
): CriticalObligationAudit {
  const excluded = new Set(excludedKeys);
  const obligations = Object.keys(declared).sort();
  const resolved = new Set<string>();
  const failing = new Set<string>();
  for (const receipt of receipts) {
    for (const key of obligations) {
      if (!obligationMatches(key, receipt.surface)) continue;
      resolved.add(key);
      if (receipt.status !== 'comparable') failing.add(key);
    }
  }
  const contradictory = new Set(obligations.filter((key) => excluded.has(key) || excluded.has(surfaceBase(key))));
  return {
    armed,
    obligations,
    certified: obligations.filter((key) => resolved.has(key) && !failing.has(key) && !contradictory.has(key)),
    failing: [...failing].sort(),
    unresolved: obligations.filter((key) => !resolved.has(key) && !contradictory.has(key)),
    contradictory: [...contradictory].sort(),
  };
}

/**
 * Mark failing critical receipts required so existing comparability
 * aggregation fails closed without a parallel verdict. Unresolved and
 * contradictory obligations have no receipt to mark — the caller counts them.
 */
export function applyCriticalObligationReceipts<T extends CriticalObligationReceipt>(
  receipts: T[],
  audit?: CriticalObligationAudit | null,
): T[] {
  if (!audit?.armed || audit.failing.length === 0) return receipts;
  const failing = new Set(audit.failing);
  return receipts.map((receipt) =>
    [...failing].some((key) => obligationMatches(key, receipt.surface)) ? { ...receipt, required: true } : receipt,
  );
}
