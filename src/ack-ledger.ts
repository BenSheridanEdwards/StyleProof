// Acknowledgement ledgers — the one reader behind every `styleproof.<gate>.json`
// file (`{ "<key>": <value> }`): inventory removals, data residue, legacy
// product-state pairs, and critical state obligations. A ledger arms its gate when
// it is requested (flag or env) or its default file exists in cwd. A requested but
// missing or malformed ledger throws: a broken file must never silently
// un-acknowledge a real gap.

import fs from 'node:fs';
import path from 'node:path';

export type LedgerSpec = {
  /** Human label for the file in error messages. */
  label: string;
  /** Default file name, resolved from cwd. */
  file: string;
  /** Environment variable that overrides the path. An empty value explicitly unarms it. */
  env: string;
  /** When set, keys must be safe single path segments (surface or capture keys). */
  keyLabel?: string;
};

export const INVENTORY_LEDGER: LedgerSpec = {
  label: 'inventory acknowledgement',
  file: 'styleproof.inventory.json',
  env: 'STYLEPROOF_INVENTORY',
};
export const DATA_RESIDUE_LEDGER: LedgerSpec = {
  label: 'data-residue acknowledgement',
  file: 'styleproof.data-residue.json',
  env: 'STYLEPROOF_DATA_RESIDUE',
};
export const LEGACY_PAIRS_LEDGER: LedgerSpec = {
  label: 'legacy product-state declare',
  file: 'styleproof.product-state.json',
  env: 'STYLEPROOF_PRODUCT_STATE',
  keyLabel: 'legacy product-state pair',
};
export const CRITICAL_STATES_LEDGER: LedgerSpec = {
  label: 'critical-states obligation',
  file: 'styleproof.critical-states.json',
  env: 'STYLEPROOF_CRITICAL_STATES',
  keyLabel: 'critical state obligation',
};

function envPath(spec: LedgerSpec, env: NodeJS.ProcessEnv): string | undefined {
  return Object.hasOwn(env, spec.env) && env[spec.env] ? env[spec.env] : undefined;
}

/** Flag > env (an empty env value explicitly unarms a discovered config path) > config. */
export function resolveLedgerPath(
  spec: LedgerSpec,
  flagPath: string | undefined,
  configPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (flagPath !== undefined) return flagPath;
  if (Object.hasOwn(env, spec.env)) return envPath(spec, env);
  return configPath;
}

/** True when the gate is armed: a path was requested, or the default file exists in cwd. */
export function ledgerArmed(spec: LedgerSpec, explicitPath?: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(explicitPath || envPath(spec, env)) || fs.existsSync(path.resolve(spec.file));
}

/** Assert a ledger key is a plain, non-empty, single path segment. */
function assertSafeLedgerKey(keyLabel: string, key: string): void {
  if (key.length === 0 || key !== key.trim()) {
    throw new Error(`${keyLabel} key must be a non-empty surface or capture key`);
  }
  if (key.includes('\0') || /[\\/]/.test(key) || key.includes('..') || key === '.' || path.isAbsolute(key)) {
    throw new Error(`${keyLabel} key is not a safe single path segment`);
  }
}

/** The default value parser: a non-empty reason string. */
export function reasonString(spec: LedgerSpec, raw: unknown, key: string, source: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(`${source}: "${key}" must be a non-empty reason string`);
  }
  return raw.trim();
}

export type LedgerValueParser<T> = (spec: LedgerSpec, raw: unknown, key: string, source: string) => T;

/**
 * Read a ledger as `{ key: value }`. `{}` when nothing was requested and the default
 * file is absent; throws when a requested file is missing, unreadable, or malformed.
 */
export function readLedger<T = string>(
  spec: LedgerSpec,
  explicitPath?: string,
  parseValue: LedgerValueParser<T> = reasonString as LedgerValueParser<T>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, T> {
  const requested = explicitPath || envPath(spec, env);
  const filePath = path.resolve(requested ?? spec.file);
  if (!fs.existsSync(filePath)) {
    if (requested)
      throw new Error(`${filePath} is not readable — the ${spec.label} file is required when the gate is requested`);
    return {};
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    throw new Error(`${filePath} is not valid JSON — ${(e as Error).message}`, { cause: e });
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${filePath} must be a JSON object of {"<surface>": ...}`);
  }
  const ledger: Record<string, T> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (spec.keyLabel) assertSafeLedgerKey(spec.keyLabel, key);
    ledger[key] = parseValue(spec, value, key, filePath);
  }
  return ledger;
}

/** Split observed keys into acknowledged / unacknowledged, and name ledger entries that match nothing. */
export function reconcileLedger<T>(
  observed: readonly string[],
  ledger: Record<string, T>,
  matches: (ledgerKey: string, observedKey: string) => boolean = (a, b) => a === b,
): { acknowledged: string[]; unacknowledged: string[]; stale: string[] } {
  const ledgerKeys = Object.keys(ledger);
  const used = new Set<string>();
  const acknowledged: string[] = [];
  const unacknowledged: string[] = [];
  for (const key of observed) {
    const hit = ledgerKeys.find((ledgerKey) => matches(ledgerKey, key));
    if (hit === undefined) unacknowledged.push(key);
    else {
      acknowledged.push(key);
      used.add(hit);
    }
  }
  return { acknowledged, unacknowledged, stale: ledgerKeys.filter((key) => !used.has(key)) };
}
