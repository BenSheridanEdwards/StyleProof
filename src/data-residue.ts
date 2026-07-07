// Data-residue guard — name the data-boundary requests that FAILED during capture.
//
// The certification diff proves "did surface X change?" but is structurally blind to
// a whole class of high-stakes miss: a surface requests a data endpoint that nothing
// controls — no fixture routes it, so it falls through and FAILS (network error, or a
// 4xx/5xx) — and the view silently renders its FALLBACK branch. Capture after capture
// embeds that fallback state; the response-driven state its real data would produce is
// never captured, so a restyle confined to that state ships green. StyleProof's
// request tracker watched the request fail every time and said nothing.
//
// This module records, per surface, any request matching the data boundary (the
// `replayUrl` glob) that failed or errored. The residue travels on the StyleMap (like
// `inventory`), so the diff/report can surface it; a stderr warning names it at capture
// time; and the gate (on by default, opted down via `dataResidue: 'warn'`) blocks an
// unacknowledged failing endpoint — mirroring the `exclude`/inventory-ack discipline.
//
// Observing that a data request failed needs NO app knowledge — it's the same move as
// the unreadable-stylesheet residue: convert silent blindness into a name. Declaring
// the app's data STATES stays app-owned (see issue #202); this only observes failures.
//
// Deliberately OUT OF SCOPE (unsound or noisy):
//   - Flagging endpoints that responded 2xx but weren't fixtured. In recording mode
//     every live response is legitimately recorded, so a blanket "uncontrolled" flag
//     would fire on every healthy record run. A sound record-fulfilled-vs-network
//     discriminator (if Playwright exposes one) could be a follow-up; we do not ship a
//     heuristic version. Only FAILED requests (network error / 4xx / 5xx) are residue.
//   - Synthesising payloads or surfaces for un-exercised response variants (app
//     knowledge; issue #202's territory).

import fs from 'node:fs';
import path from 'node:path';
import { safeKey } from './change-groups.js';

/** One data-boundary request that FAILED during capture — an embedded fallback branch. */
export type DataResidueEntry = {
  /**
   * Stable identity across captures: `<surface>·<endpoint>` where `endpoint` is the
   * request URL's `pathname` (query stripped so `?all=1` vs `?all=2` don't fork the
   * key). Escaped so it can't inject Markdown into the report/PR-comment summary.
   */
  key: string;
  /** The captured surface key this failure was observed on. */
  surface: string;
  /** The failing endpoint's URL pathname (query stripped). */
  endpoint: string;
  /** Why it failed: a network error text (`net::ERR_CONNECTION_REFUSED`) or `HTTP 503`. */
  reason: string;
};

/** `key -> reason` — failing endpoints that are intentional/known and on the record. */
export type AcknowledgedResidue = Record<string, string>;

/** Acknowledgement file, parallel to the inventory guard's `styleproof.inventory.json`. */
export const DATA_RESIDUE_ACK_FILE = 'styleproof.data-residue.json';

/**
 * Read the acknowledged-residue file (`$STYLEPROOF_DATA_RESIDUE` or
 * `styleproof.data-residue.json`). `{}` when absent; THROWS on malformed JSON — the
 * caller picks the policy (the CI gate fails loud so a broken ack file can't silently
 * un-acknowledge a real failure; the advisory report degrades to `{}`). Mirrors
 * `readAckFile` in the inventory guard exactly.
 */
export function readResidueAckFile(): AcknowledgedResidue {
  const p = path.resolve(process.env.STYLEPROOF_DATA_RESIDUE ?? DATA_RESIDUE_ACK_FILE);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as AcknowledgedResidue;
  } catch (e) {
    throw new Error(`${p} is not valid JSON — ${(e as Error).message}`, { cause: e });
  }
}

/** Build a residue key from a surface and an endpoint URL. Query stripped, escaped. */
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

// ── pure union / audit / reconciliation ─────────────────────────────────────────

/**
 * Union the per-surface `map.dataResidue` of a whole run into one deduped set, keyed by
 * `key` (surface·endpoint), so the same failure seen across widths / a self-check re-run
 * is ONE entry, not a spray. Sorted for a stable rendering order.
 */
export function unionResidue(perSurface: Array<{ dataResidue?: DataResidueEntry[] } | undefined>): DataResidueEntry[] {
  const byKey = new Map<string, DataResidueEntry>();
  for (const map of perSurface) {
    for (const entry of map?.dataResidue ?? []) if (!byKey.has(entry.key)) byKey.set(entry.key, entry);
  }
  return Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key));
}

export type ResidueAudit = {
  /** Every failing endpoint observed across the run (union, deduped). */
  residue: DataResidueEntry[];
  /** Failing endpoints NOT acknowledged in the ledger — the gate fails on a non-empty set. */
  unacknowledged: DataResidueEntry[];
  /** Acknowledged keys no longer present in the residue (the endpoint is fixtured/gone) —
   *  a rotted opt-out, so the ledger can't quietly rot (mirrors the `exclude` guard). */
  staleAcknowledgements: string[];
};

/**
 * The gate. A failing endpoint whose key isn't in `acknowledged` (key -> reason) is
 * unacknowledged — the caller fails on a non-empty result. An `acknowledged` key that
 * isn't actually failing is stale, returned separately so the ledger can't rot. Unlike
 * the inventory guard (a base-vs-head REMOVAL), residue is present-on-HEAD: the head
 * capture's failing endpoints are audited directly, so only the head maps matter.
 */
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

/**
 * Run-level entry point for a gate/report: audit the HEAD bundle's residue against the
 * acknowledgement ledger, carrying whether the guard was ARMED to gate. `armed` comes
 * from the head coverage ledger's `dataResidue: 'gate'` (the default; only an explicit
 * `'warn'` — or an older bundle with no field — is unarmed). When not armed, the caller
 * still surfaces residue (warn is the explicit opt-out) but must not block.
 */
export function auditRunResidue(
  headMaps: Array<{ dataResidue?: DataResidueEntry[] } | undefined>,
  acknowledged: AcknowledgedResidue,
  armed: boolean,
): ResidueAudit & { armed: boolean } {
  return { armed, ...auditResidue(headMaps, acknowledged) };
}
