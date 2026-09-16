// Critical state obligations — declare state/surface IDs that must certify, or fail closed.
//
// The inverse of the legacy-pairs ledger: `styleproof.critical-states.json`
// (`{"<surface>": {"owner": "...", "reason": "..."}}`) names obligations that MUST
// produce certifying evidence. When armed, a declared ID whose paired evidence is
// unproven or incomparable blocks, one with no paired evidence blocks (obligations
// never silently expire), and one that is also coverage-excluded is contradictory.

import { CRITICAL_STATES_LEDGER, type LedgerSpec, ledgerArmed, readLedger, resolveLedgerPath } from './ack-ledger.js';
import { surfaceBase } from './surface-keys.js';

export type CriticalObligation = { owner: string; reason: string };
export type DeclaredCriticalObligations = Record<string, CriticalObligation>;

export const CRITICAL_STATES_FILE = CRITICAL_STATES_LEDGER.file;

const MAX_METADATA_LENGTH = 160;

export type CriticalObligationReceipt = { surface: string; status: string; required: boolean };

export type CriticalObligationAudit = {
  armed: boolean;
  /** Every declared obligation ID, sorted. */
  obligations: string[];
  /** Declared IDs whose paired evidence is comparable. */
  certified: string[];
  /** Declared IDs whose paired evidence is unproven or incomparable — blocks. */
  failing: string[];
  /** Declared IDs matching no paired surface evidence — blocks. */
  unresolved: string[];
  /** Declared IDs that are also coverage-excluded — blocks. */
  contradictory: string[];
};

function metadata(value: unknown, field: string, key: string, source: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${source}: "${key}" requires a non-empty ${field} string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_METADATA_LENGTH || /[\r\n\0]/.test(trimmed)) {
    throw new Error(`${source}: "${key}" ${field} must be a single line of at most ${MAX_METADATA_LENGTH} characters`);
  }
  return trimmed;
}

function parseObligation(_spec: LedgerSpec, value: unknown, key: string, source: string): CriticalObligation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${source}: "${key}" must be {"owner": "...", "reason": "..."}`);
  }
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record);
  if (fields.length !== 2 || !fields.includes('owner') || !fields.includes('reason')) {
    throw new Error(`${source}: "${key}" allows exactly owner and reason`);
  }
  return {
    owner: metadata(record.owner, 'owner', key, source),
    reason: metadata(record.reason, 'reason', key, source),
  };
}

/** Flag > `$STYLEPROOF_CRITICAL_STATES` (empty unarms) > config `productState.critical`. */
export function resolveConfiguredCriticalStatesPath(
  flagPath: string | undefined,
  configPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return resolveLedgerPath(CRITICAL_STATES_LEDGER, flagPath, configPath, env);
}

export function criticalStatesGateArmed(explicitPath?: string): boolean {
  return ledgerArmed(CRITICAL_STATES_LEDGER, explicitPath);
}

export function readCriticalStatesFile(explicitPath?: string): DeclaredCriticalObligations {
  return readLedger(CRITICAL_STATES_LEDGER, explicitPath, parseObligation);
}

/** A declaration matches an exact capture key or its widthless surface base. */
export function obligationMatches(declaredKey: string, surface: string): boolean {
  return declaredKey === surface || declaredKey === surfaceBase(surface);
}

/** Audit paired comparability receipts against the declared obligations. */
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

/** Mark failing critical receipts required so comparability aggregation fails closed. */
export function applyCriticalObligationReceipts<T extends CriticalObligationReceipt>(
  receipts: T[],
  audit?: CriticalObligationAudit | null,
): T[] {
  if (!audit?.armed || audit.failing.length === 0) return receipts;
  return receipts.map((receipt) =>
    audit.failing.some((key) => obligationMatches(key, receipt.surface)) ? { ...receipt, required: true } : receipt,
  );
}
