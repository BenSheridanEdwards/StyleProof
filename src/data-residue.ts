// Data-residue guard — name the data-boundary requests that FAILED during capture.
// A surface whose data endpoint fails renders its FALLBACK branch, so the response-driven
// state is never captured and a restyle confined to it ships green. Only FAILED requests
// (network error / 4xx / 5xx) are residue: a live 2xx is legitimate in recording mode.

import { DATA_RESIDUE_LEDGER, readLedger } from './ack-ledger.js';
import { safeKey } from './change-groups.js';

/** One data-boundary request that FAILED during capture — an embedded fallback branch. */
export type DataResidueEntry = {
  /** `<surface>·<endpoint>` (endpoint = pathname, query stripped), escaped for Markdown. */
  key: string;
  surface: string;
  /** The failing endpoint's URL pathname (query stripped). */
  endpoint: string;
  /** A network error text (`net::ERR_CONNECTION_REFUSED`) or `HTTP 503`. */
  reason: string;
};

/** `key -> reason` — failing endpoints that are intentional/known and on the record. */
export type AcknowledgedResidue = Record<string, string>;

/** Read the acknowledged-residue ledger (`$STYLEPROOF_DATA_RESIDUE` or `styleproof.data-residue.json`). */
export function readResidueAckFile(): AcknowledgedResidue {
  return readLedger(DATA_RESIDUE_LEDGER);
}

export function residueKey(surface: string, endpoint: string): string {
  return `${safeKey(surface)}·${safeKey(endpoint)}`;
}

/** The endpoint pathname a URL resolves to, query stripped. Falls back to the raw URL. */
export function endpointOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Union a run's per-surface residue into one deduped, key-sorted set. */
export function unionResidue(perSurface: Array<{ dataResidue?: DataResidueEntry[] } | undefined>): DataResidueEntry[] {
  const byKey = new Map<string, DataResidueEntry>();
  for (const map of perSurface) {
    for (const entry of map?.dataResidue ?? []) if (!byKey.has(entry.key)) byKey.set(entry.key, entry);
  }
  return Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key));
}

export type ResidueAudit = {
  residue: DataResidueEntry[];
  /** Failing endpoints NOT acknowledged — the gate fails on a non-empty set. */
  unacknowledged: DataResidueEntry[];
  /** Acknowledged keys no longer failing — a rotted opt-out to prune. */
  staleAcknowledgements: string[];
};

/** The gate: residue is present-on-HEAD, so only the head maps are audited against the ledger. */
export function auditResidue(
  headMaps: Array<{ dataResidue?: DataResidueEntry[] } | undefined>,
  acknowledged: AcknowledgedResidue = {},
): ResidueAudit {
  const residue = unionResidue(headMaps);
  const residueKeys = new Set(residue.map((r) => r.key));
  return {
    residue,
    unacknowledged: residue.filter((r) => !(r.key in acknowledged)),
    staleAcknowledgements: Object.keys(acknowledged).filter((k) => !residueKeys.has(k)),
  };
}

/** Run-level entry: `armed` comes from the head coverage ledger's `dataResidue: 'gate'`; unarmed still surfaces, never blocks. */
export function auditRunResidue(
  headMaps: Array<{ dataResidue?: DataResidueEntry[] } | undefined>,
  acknowledged: AcknowledgedResidue,
  armed: boolean,
): ResidueAudit & { armed: boolean } {
  return { armed, ...auditResidue(headMaps, acknowledged) };
}
