/** Stale-safe opt-outs for changed ranges that capture cannot reach. */
import { createHash } from 'node:crypto';
import { readLedger, reconcileLedger, type LedgerSpec } from './ack-ledger.js';

const REACH_LEDGER: LedgerSpec = {
  label: 'reach acknowledgement',
  file: 'styleproof.reach.json',
  env: 'STYLEPROOF_REACH',
};

export type AcknowledgedReach = Record<string, string>;

/** Hash exact changed-range text, including whitespace; callers supply repository-relative files. */
export function reachKey(file: string, changedRange: string): string {
  if (
    !file ||
    file.startsWith('/') ||
    file.includes('\\') ||
    file.split('/').some((part) => !part || part === '..' || part === '.')
  )
    throw new Error('reach file must be a repository-relative path');
  return `${file}·${createHash('sha256').update(changedRange).digest('hex')}`;
}

/** Missing default ledger is optional; explicitly requested files and malformed entries fail closed. */
export function readReachAckFile(explicitPath?: string, env: NodeJS.ProcessEnv = process.env): AcknowledgedReach {
  return readLedger(
    REACH_LEDGER,
    explicitPath,
    (_spec, raw, key, source) => {
      if (!/^.+·[a-f0-9]{64}$/.test(key)) throw new Error(`${source}: invalid reach range key`);
      const file = key.slice(0, key.lastIndexOf('·'));
      reachKey(file, '');
      if (typeof raw !== 'string' || !raw.trim()) throw new Error(`${source}: reach reason must be non-empty`);
      return raw.trim();
    },
    env,
  );
}

/** Audit only unreached changed ranges. Stale opt-outs fail even when no current gap remains. */
export function auditReach(unreachedKeys: readonly string[], acknowledged: AcknowledgedReach = {}) {
  const result = reconcileLedger([...new Set(unreachedKeys)], acknowledged);
  return {
    ...result,
    staleAcknowledgements: result.stale,
    passed: result.unacknowledged.length === 0 && result.stale.length === 0,
  };
}
