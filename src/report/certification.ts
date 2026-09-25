import fs from 'node:fs';
import path from 'node:path';
import { readInventories, readResidue } from '../capture.js';
import type { ComparabilitySummary } from '../diff.js';
import type { BaselineProvenance } from '../map-store.js';
import { liveTextFreezeError, type LiveTextAudit } from '../live-text.js';
import type { LegacyPairAudit } from '../legacy-pairs.js';
import type { CriticalObligationAudit, DeclaredCriticalObligations } from '../critical-obligations.js';
import { auditCoverage, auditDeterminism, type CoverageLedger, type CoverageVerdict } from '../coverage.js';
import { auditRunInventory, hasCapturedInventory, readAckFile } from '../inventory.js';
import { auditRunResidue, readResidueAckFile } from '../data-residue.js';
import {
  bundleSurfaceKeys,
  CONFIDENCE_LEDGER,
  readCoverageLedgerLenient,
  withCaptureDeterminism,
  type ConfidenceLedgerFile,
  type ConfidenceSummary,
} from '../confidence-ledger.js';
import { safeKey } from '../change-groups.js';
import { escapeMarkdownFailureReason } from './markdown.js';

/** The certification block a reviewer reads FIRST: the source-of-truth gates, one line each. */

// Truncated, escaped, comma-joined key list: neither removals nor additions can
// inject Markdown into the privileged PR-comment summary.
function keyList(items: { key: string }[]): string {
  const keys = items.map((i) => safeKey(i.key));
  return `${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', …' : ''}`;
}

function coverageLine(cov: CoverageVerdict, exclusionCount: number): string {
  if (cov.basis === 'complete' && exclusionCount > 0) {
    const captured = Math.max(0, (cov.registrySize ?? 0) - exclusionCount);
    return `- **Coverage** — ✓ complete (${captured} of ${cov.registrySize} registered surface(s) captured; ${exclusionCount} explicitly excluded)`;
  }
  if (cov.basis === 'complete')
    return `- **Coverage** — ✓ complete (all ${cov.registrySize} registered surface(s) captured)`;
  if (cov.basis === 'incomplete')
    return `- **Coverage** — ✗ INCOMPLETE (${cov.uncovered.length} registered surface(s) not captured: ${cov.uncovered.map(safeKey).join(', ')})`;
  return '- **Coverage** — ⚠ not asserted (no `expected` registry; certifies only the captured surfaces)';
}

function explicitExclusionCount(ledger: CoverageLedger | null): number {
  if (ledger?.expected == null) return 0;
  const expected = new Set(ledger.expected);
  return new Set(Object.keys(ledger.exclude).filter((key) => expected.has(key))).size;
}

function determinismLine(det: ReturnType<typeof auditDeterminism>): string {
  if (det.status === 'proven') return `- **Determinism** — ✓ proven (base ${det.base}, head ${det.head})`;
  if (det.status === 'unproven')
    return `- **Determinism** — ✗ NOT proven (base ${det.base}, head ${det.head}) — a clean diff could be two nondeterministic reads`;
  return '- **Determinism** — ⚠ unknown (a capture predates the determinism ledger)';
}

// `captured` = did any map carry an inventory; without it the audit never ran, so
// say ⚠ not checked rather than a ✓ for a check that never happened (#478).
// Additions never gate but are echoed so the report never contradicts the diff.
function inventoryLine(inv: ReturnType<typeof auditRunInventory>, captured: boolean): string {
  if (!captured)
    return '- **Inventory** — ⚠ not checked (no captured map carried an inventory — set `inventory: true` in the capture spec to arm the navigable-removal gate)';
  const { added, removed } = inv.delta;
  const addedClause = added.length
    ? `; ${added.length} navigable affordance(s) added: ${keyList(added)} (additions don't gate)`
    : '';
  if (inv.unexplained.length > 0)
    return `- **Inventory** — ⚠ ${inv.unexplained.length} navigable affordance(s) removed, unacknowledged: ${keyList(inv.unexplained)}${addedClause}`;
  if (removed.length > 0) return `- **Inventory** — ✓ ${removed.length} removal(s), all acknowledged${addedClause}`;
  return `- **Inventory** — ✓${addedClause ? addedClause.slice(1) : ' navigable set unchanged'}`;
}

// Lenient: the report is advisory, so a missing or malformed ack file reads as no acks.
function lenient<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

const describeFailedDataRequests = (entries: { surface: string; endpoint: string; reason: string }[]): string =>
  entries.map((e) => `${e.surface} called \`${e.endpoint}\` (${e.reason})`).join('; ');

// A failed data request captured the fallback UI, so the real data state is unproven.
function dataResidueLine(res: ReturnType<typeof auditRunResidue>): string {
  const { residue, unacknowledged, staleAcknowledgements, armed } = res;
  const meaning = 'this page called an API that failed, so the screenshot is the fallback UI, not the real data';
  if (armed && (unacknowledged.length > 0 || staleAcknowledgements.length > 0)) {
    const fail = unacknowledged.length
      ? `${describeFailedDataRequests(unacknowledged)}. Fixture the API, or declare why the fallback is the intended capture.`
      : '';
    const stale = staleAcknowledgements.length
      ? ` ${staleAcknowledgements.length} declared failure(s) no longer happen; remove them from styleproof.data-residue.json.`
      : '';
    return `- **Failed data request**: ✗ ${meaning}. ${fail}${stale}`;
  }
  if (unacknowledged.length > 0)
    return `- **Failed data request**: ⚠ ${meaning}. ${describeFailedDataRequests(unacknowledged)} (recorded, not gating: dataResidue warn opt-out)`;
  if (residue.length > 0)
    return `- **Failed data request**: ✓ ${residue.length} failed API call(s), all declared as intended fallbacks`;
  return `- **Failed data request**: ✓ no API failed during capture`;
}

// The completeness badge (#399): counts only, always separate from the visual verdict.
function confidenceLine(
  ledger: ConfidenceLedgerFile | null,
  summary: ConfidenceSummary,
  sidecarPresent: boolean,
): string {
  const { counts, completeness } = summary;
  if (completeness === 'unknown') {
    const reason = sidecarPresent
      ? 'confidence sidecar is missing or malformed; not blocking retroactively'
      : 'capture predates the confidence ledger; not blocking retroactively';
    return `- **Confidence** — ⚠ unknown (${reason})`;
  }
  const statuses = ['excluded-with-reason', 'inaccessible', 'unknown', 'unproven-determinism'] as const;
  const parts = [
    `${counts.captured} captured`,
    ...statuses.filter((status) => counts[status]).map((status) => `${counts[status]} ${status}`),
  ].join(', ');
  if (completeness === 'complete') return `- **Confidence** — ✓ complete (${parts})`;
  if (completeness === 'unasserted')
    return `- **Confidence** — ⚠ unasserted (no \`expected\` registry — certifies only the ${counts.captured} captured surface(s), not that they are all of them)`;
  const inaccessible = (ledger?.entries ?? []).filter((e) => e.status === 'inaccessible');
  const named = inaccessible.length ? `; inaccessible: ${keyList(inaccessible.map((e) => ({ key: e.surface })))}` : '';
  const details = inaccessible
    .slice(0, 8)
    .map(
      (e) =>
        `  - \`${safeKey(e.surface)}\`: ${escapeMarkdownFailureReason(e.reason ?? 'blocked continuation reason unavailable')}`,
    );
  if (inaccessible.some((e) => e.producer === 'incomplete-ui')) {
    details.push(
      '  - **Next:** fixture the blocked state to increase the certified area, or exclude the surface with a non-empty reason when it is intentionally outside scope.',
    );
  }
  return `- **Confidence** — ⚠ limited (${parts})${named}${details.length ? `\n${details.join('\n')}` : ''}`;
}

/** Coverage / determinism / inventory / residue / confidence. Empty when the bundle
 *  carries no certification metadata at all (an old capture). */
export function certificationLines(
  beforeDir: string,
  afterDir: string,
  confidence: { ledger: ConfidenceLedgerFile | null; summary: ConfidenceSummary },
): string[] {
  const baseLedger = readCoverageLedgerLenient(beforeDir);
  const headLedger = readCoverageLedgerLenient(afterDir);
  const beforeInventories = readInventories(beforeDir);
  const afterInventories = readInventories(afterDir);
  const inv = auditRunInventory(beforeInventories, afterInventories, lenient(readAckFile, {}));
  const res = auditRunResidue(
    readResidue(afterDir),
    lenient(readResidueAckFile, {}),
    headLedger?.dataResidue === 'gate',
  );
  const sidecarPresent = fs.existsSync(path.join(afterDir, CONFIDENCE_LEDGER));
  const hasConfidence = baseLedger !== null || headLedger !== null || confidence.ledger !== null || sidecarPresent;
  const hasInvChange = inv.delta.removed.length > 0 || inv.delta.added.length > 0;
  const hasResidue = res.residue.length > 0 || res.armed;
  if (!hasConfidence && !hasInvChange && !hasResidue) return [];
  const coverage = auditCoverage(bundleSurfaceKeys(afterDir, headLedger?.expected ?? null), headLedger);
  return [
    '**Certification**',
    coverageLine(coverage, explicitExclusionCount(headLedger)),
    determinismLine(
      auditDeterminism(withCaptureDeterminism(beforeDir, baseLedger), withCaptureDeterminism(afterDir, headLedger)),
    ),
    inventoryLine(inv, hasCapturedInventory(beforeInventories, afterInventories)),
    // Only with residue or an armed gate, so an ordinary bundle keeps its 3-line block.
    ...(hasResidue ? [dataResidueLine(res)] : []),
    confidenceLine(confidence.ledger, confidence.summary, sidecarPresent),
    '',
  ];
}

export function liveTextFreezeLines(audit: LiveTextAudit): string[] {
  if (!audit.freeze || audit.violations.length === 0) return [];
  const samples = audit.violations
    .slice(0, 5)
    .map((item) =>
      !item.before && !item.after
        ? `- \`${safeKey(item.surface)}\`: freeze declared but captured text was missing — cannot verify ages are pinned`
        : `- \`${safeKey(item.surface)}\`: \`${item.before}\` → \`${item.after}\``,
    );
  return [
    '',
    '⚠ **Live/age freeze violated** — fail closed (`CERTIFICATION_FAILED`). A freeze was declared but captured age/clock text still drifted. This is not a stylesheet regression and cannot be approved as one. Fixture timestamps so ages use the frozen clock, or declare `liveText` without `freeze` so age-only drift stays advisory.',
    '',
    ...samples,
    '',
    `_${liveTextFreezeError(audit)}_`,
    '',
  ];
}

/** Hex-filtered commit label: the sidecar is plain JSON on disk, so never trust its spelling. */
const safeShaLabel = (sha: string | undefined): string =>
  (sha ?? '').replace(/[^0-9a-f]/gi, '').slice(0, 12) || 'unknown';

/** Where the baseline maps came from (#367): '' without a provenance sidecar. */
export function baselineProvenanceLine(p: BaselineProvenance | null): string {
  if (!p) return '';
  const requested = safeShaLabel(p.requestedSha);
  if (p.baseline === 'ancestor-reuse')
    return `**Baseline** — ♻ restored from nearest ancestor \`${safeShaLabel(p.restoredSha)}\` of base \`${requested}\` (${p.changedPathCount ?? 0} path(s) changed between them, none capture-relevant)`;
  if (p.baseline === 'exact-restore') return `**Baseline** — ✓ restored from the exact base commit \`${requested}\``;
  return `**Baseline** — ✓ captured fresh at base commit \`${requested}\``;
}

export function criticalObligationLines(
  audit: CriticalObligationAudit | undefined,
  declared: DeclaredCriticalObligations | undefined,
): string[] {
  if (!audit?.armed) return [];
  if (audit.failing.length + audit.unresolved.length + audit.contradictory.length === 0) {
    return [
      `**Critical state obligations** — ✓ ${audit.certified.length} declared obligation(s) certifying on comparable paired evidence.`,
      '',
    ];
  }
  const describe = (key: string): string => {
    const meta = declared?.[key];
    return meta ? `${key} (${meta.owner}: ${meta.reason})` : key;
  };
  return [
    `⛔ **Critical state obligations** — declared obligations must certify and cannot silently expire.`,
    '',
    ...audit.failing.map((key) => `- ${describe(key)} — non-certifying pair (unproven or incomparable).`),
    ...audit.unresolved.map(
      (key) =>
        `- ${describe(key)} — unresolved: no paired surface evidence (lost capture, removed surface, or unknown ID).`,
    ),
    ...audit.contradictory.map((key) => `- ${describe(key)} — contradictory: declared critical and coverage-excluded.`),
    '',
  ];
}

/** One product-state comparison line (the caller adds the blank line after it). */
export function comparabilityLine(comparison: ComparabilitySummary, legacyPairs?: LegacyPairAudit): string {
  const counts = comparison.counts;
  if (comparison.status === 'comparable')
    return `**Product-state comparison** — ✓ comparable on ${counts.comparable} paired capture(s) using explicit consumer-owned identity.`;
  if (comparison.status === 'not-required')
    return '**Product-state comparison** — not required; there are no paired capture obligations.';
  if (legacyPairs?.armed && legacyPairs.undeclared.length > 0)
    return `⛔ **Product-state comparison** — ${legacyPairs.undeclared.length} undeclared legacy pair(s). Declare each as productState {id, revision} or record it in styleproof.product-state.json; unknown pairs cannot certify.`;
  if (legacyPairs?.armed && legacyPairs.declared.length > 0 && !comparison.blocksCertification)
    return `⚠️ **Product-state comparison** — ${legacyPairs.declared.length} declared legacy pair(s) on the record. This is advisory, not certification that both captures reached the same product state.`;
  if (!comparison.blocksCertification)
    return `⚠️ **Product-state comparison** — unproven on ${counts.unproven} undeclared legacy pair(s). Legacy compatibility preserves the existing visual-review path, but this is not proof that both captures reached the same product state.`;
  const reasons = [
    counts.incomparable ? `${counts.incomparable} incomparable` : '',
    counts.requiredUnproven ? `${counts.requiredUnproven} required-unproven` : '',
    counts.globalRequiredUnproven ? `${counts.globalRequiredUnproven} globally required-unproven` : '',
  ].filter(Boolean);
  return `⛔ **Product-state comparison** — ${comparison.status}; ${reasons.join(', ')} paired capture(s). Raw detector evidence is diagnostic only, is not approval evidence, and cannot certify this comparison.`;
}
