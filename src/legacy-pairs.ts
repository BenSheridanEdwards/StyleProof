// Legacy product-state pair ledger — declare known undeclared pairs, or fail closed.
//
// An explicit `productState {id, revision}` makes a pair comparable; the ledger
// (`styleproof.product-state.json`, `{"<surface>": "<why>"}`) records the remaining
// unproven pairs. When armed, an unproven pair that is not on the record fails
// closed; a declared pair stays advisory and never certifies; a stale declaration
// fails like a stale inventory acknowledgement.

import { LEGACY_PAIRS_LEDGER, ledgerArmed, readLedger, reconcileLedger, resolveLedgerPath } from './ack-ledger.js';
import { surfaceBase } from './surface-keys.js';

export type DeclaredLegacyPairs = Record<string, string>;

export const LEGACY_PAIRS_ACK_FILE = LEGACY_PAIRS_LEDGER.file;

export type LegacyPairReceipt = { surface: string; status: string; required: boolean };

export type LegacyPairAudit = {
  armed: boolean;
  /** Unproven, non-required paired captures. */
  legacyPairs: string[];
  /** Legacy pairs matching a declaration (advisory, not certifying). */
  declared: string[];
  /** Legacy pairs with no declaration — fail closed when armed. */
  undeclared: string[];
  /** Declarations that no longer match an unproven pair. */
  staleAcknowledgements: string[];
};

/** Flag > `$STYLEPROOF_PRODUCT_STATE` (empty unarms) > config `productState.legacyPairs`. */
export function resolveConfiguredLegacyPairsPath(
  flagPath: string | undefined,
  configPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return resolveLedgerPath(LEGACY_PAIRS_LEDGER, flagPath, configPath, env);
}

export function legacyPairsGateArmed(explicitPath?: string): boolean {
  return ledgerArmed(LEGACY_PAIRS_LEDGER, explicitPath);
}

export function readLegacyPairsAckFile(explicitPath?: string): DeclaredLegacyPairs {
  return readLedger(LEGACY_PAIRS_LEDGER, explicitPath);
}

/** A declaration matches an exact capture key or its widthless surface base. */
export function declarationMatches(declaredKey: string, surface: string): boolean {
  return declaredKey === surface || declaredKey === surfaceBase(surface);
}

export function auditLegacyPairs(
  receipts: LegacyPairReceipt[],
  declared: DeclaredLegacyPairs = {},
  armed = false,
): LegacyPairAudit {
  const legacyPairs = receipts.filter((r) => r.status === 'unproven' && !r.required).map((r) => r.surface);
  const { acknowledged, unacknowledged, stale } = reconcileLedger(legacyPairs, declared, declarationMatches);
  return { armed, legacyPairs, declared: acknowledged, undeclared: unacknowledged, staleAcknowledgements: stale };
}

/** Mark undeclared legacy receipts required so comparability aggregation fails closed. */
export function applyLegacyPairReceipts<T extends LegacyPairReceipt>(
  receipts: T[],
  audit?: LegacyPairAudit | null,
): T[] {
  if (!audit?.armed || audit.undeclared.length === 0) return receipts;
  const undeclared = new Set(audit.undeclared);
  return receipts.map((receipt) => (undeclared.has(receipt.surface) ? { ...receipt, required: true } : receipt));
}
