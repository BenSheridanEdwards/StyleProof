// Legacy product-state pair inventory — declare known undeclared pairs, or fail closed.
//
// Product-state comparability already has two truths: an explicit `productState`
// {id, revision} makes a pair comparable, and `--require-state-identity` makes
// every unproven pair globally required. This module is the inventory/residue
// twin for the remaining case: a large set of undeclared legacy pairs.
//
// Adopters declare known-legacy capture keys in `styleproof.product-state.json`
// (`{"<surface>": "<why>"}`; override the path with `STYLEPROOF_PRODUCT_STATE`
// or `--legacy-pairs`). When that ledger is armed, an unproven pair that is not
// on the record fails closed. A declared pair stays advisory and cannot
// certify. Stale declarations fail like inventory acknowledgements so the
// ledger cannot rot.
//
// `--require-state-identity` remains stricter: it still fails every unproven
// pair, declared or not. The only certifying path is matching `productState`.

import fs from 'node:fs';
import path from 'node:path';
import { surfaceBase } from './surface-keys.js';

/** `key -> reason` — undeclared-legacy pairs that are known and on the record. */
export type DeclaredLegacyPairs = Record<string, string>;

/** Acknowledgement file, parallel to `styleproof.inventory.json`. */
export const LEGACY_PAIRS_ACK_FILE = 'styleproof.product-state.json';

export type LegacyPairReceipt = {
  surface: string;
  status: string;
  required: boolean;
};

export type LegacyPairAudit = {
  /** True when a declare file was requested or found. */
  armed: boolean;
  /** Unproven, non-required paired captures (legacy pairs). */
  legacyPairs: string[];
  /** Legacy pairs that match a declaration (advisory, not certifying). */
  declared: string[];
  /** Legacy pairs with no declaration — fail closed when armed. */
  undeclared: string[];
  /** Declarations that no longer match an unproven pair. */
  staleAcknowledgements: string[];
};

function assertSafePairKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0 || key !== key.trim()) {
    throw new Error('legacy product-state pair key must be a non-empty surface or capture key');
  }
  if (key.includes('\0') || /[\\/]/.test(key) || key.includes('..') || key === '.' || path.isAbsolute(key)) {
    throw new Error('legacy product-state pair key is not a safe single path segment');
  }
}

function parseDeclaredLegacyPairs(raw: unknown, source: string): DeclaredLegacyPairs {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${source} must be a JSON object of {"<surface>": "<why>"}`);
  }
  const declared: DeclaredLegacyPairs = {};
  for (const [key, reason] of Object.entries(raw as Record<string, unknown>)) {
    assertSafePairKey(key);
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new Error(`${source}: "${key}" must be a non-empty reason string`);
    }
    declared[key] = reason.trim();
  }
  return declared;
}

/** Resolve the declare-file path (flag/env/default). */
export function resolveLegacyPairsAckPath(explicitPath?: string): string {
  return path.resolve(explicitPath ?? process.env.STYLEPROOF_PRODUCT_STATE ?? LEGACY_PAIRS_ACK_FILE);
}

/**
 * True when the declare gate is armed: an explicit path or env was given, or
 * the default `styleproof.product-state.json` exists in cwd.
 */
export function legacyPairsGateArmed(explicitPath?: string): boolean {
  if (explicitPath || process.env.STYLEPROOF_PRODUCT_STATE) return true;
  return fs.existsSync(path.resolve(LEGACY_PAIRS_ACK_FILE));
}

/**
 * Read the declare file. `{}` when the default path is absent; THROWS when an
 * explicit path/env is set but the file is missing or malformed — a broken
 * ledger cannot silently un-declare unknown pairs.
 */
export function readLegacyPairsAckFile(explicitPath?: string): DeclaredLegacyPairs {
  const requested = explicitPath ?? process.env.STYLEPROOF_PRODUCT_STATE;
  const filePath = path.resolve(requested ?? LEGACY_PAIRS_ACK_FILE);
  if (!fs.existsSync(filePath)) {
    if (requested) {
      throw new Error(
        `${filePath} is not readable — the legacy product-state declare file is required when the gate is requested`,
      );
    }
    return {};
  }
  try {
    return parseDeclaredLegacyPairs(JSON.parse(fs.readFileSync(filePath, 'utf8')), filePath);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith(filePath)) throw e;
    if (e instanceof Error && e.message.includes('legacy product-state pair')) throw e;
    throw new Error(`${filePath} is not valid JSON — ${(e as Error).message}`, { cause: e });
  }
}

/** A declaration matches an exact capture key or its widthless surface base. */
export function declarationMatches(declaredKey: string, surface: string): boolean {
  return declaredKey === surface || declaredKey === surfaceBase(surface);
}

function matchingDeclaration(surface: string, declared: DeclaredLegacyPairs): string | undefined {
  if (surface in declared) return surface;
  const base = surfaceBase(surface);
  if (base in declared) return base;
  return undefined;
}

function isLegacyPair(receipt: LegacyPairReceipt): boolean {
  return receipt.status === 'unproven' && receipt.required === false;
}

/**
 * Audit unproven legacy pairs against the declare ledger. When `armed`,
 * `undeclared` is the fail-closed set. Declared pairs stay advisory.
 */
export function auditLegacyPairs(
  receipts: LegacyPairReceipt[],
  declared: DeclaredLegacyPairs = {},
  armed = false,
): LegacyPairAudit {
  const legacyPairs = receipts.filter(isLegacyPair).map((receipt) => receipt.surface);
  const declaredSurfaces = legacyPairs.filter((surface) => matchingDeclaration(surface, declared) !== undefined);
  const undeclared = legacyPairs.filter((surface) => matchingDeclaration(surface, declared) === undefined);
  const matchedKeys = new Set(
    legacyPairs
      .map((surface) => matchingDeclaration(surface, declared))
      .filter((key): key is string => key !== undefined),
  );
  return {
    armed,
    legacyPairs,
    declared: declaredSurfaces,
    undeclared,
    staleAcknowledgements: Object.keys(declared).filter((key) => !matchedKeys.has(key)),
  };
}

/**
 * Mark undeclared legacy receipts required so existing comparability
 * aggregation fails closed without a parallel verdict.
 */
export function applyLegacyPairReceipts<T extends LegacyPairReceipt>(
  receipts: T[],
  audit?: LegacyPairAudit | null,
): T[] {
  if (!audit?.armed || audit.undeclared.length === 0) return receipts;
  const undeclared = new Set(audit.undeclared);
  return receipts.map((receipt) => (undeclared.has(receipt.surface) ? { ...receipt, required: true } : receipt));
}
