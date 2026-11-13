import fs from 'node:fs';
import path from 'node:path';
import { readInventories, readResidue } from '../capture.js';
import type { ComparabilitySummary } from '../diff.js';
import type { LiveTextAudit } from '../live-text.js';
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
import { codeValue, escapeInlineMarkdown } from '../code-span.js';
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
function inventoryLine(
  inv: ReturnType<typeof auditRunInventory>,
  captured: boolean,
  elevatedNavigableChromeAdds = 0,
): string {
  if (!captured)
    return '- **Inventory** — ⚠ not checked (no captured map carried an inventory — set `inventory: true` in the capture spec to arm the navigable-removal gate)';
  const { added, removed } = inv.delta;
  const addedGateNote =
    elevatedNavigableChromeAdds > 0 ? 'Global chrome navigable additions also gate via #766' : "additions don't gate";
  const addedClause = added.length
    ? `; ${added.length} navigable affordance(s) added: ${keyList(added)} (${addedGateNote})`
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
  entries
    .map(
      (e) => `${escapeInlineMarkdown(e.surface)} called ${codeValue(e.endpoint)} (${escapeInlineMarkdown(e.reason)})`,
    )
    .join('; ');

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

/** A certification line that still needs a reviewer's eyes (not an all-green ✓). */
function isCertificationIssue(line: string): boolean {
  // Keep warnings/failures; drop pure-success ticks so an all-green block stays hidden.
  if (/✗|⚠|⛔/.test(line)) return true;
  // Inventory additions are informational (they never gate) but still worth naming.
  if (/Inventory/.test(line) && /added/.test(line)) return true;
  if (/✓/.test(line) && !/⚠|✗|⛔/.test(line)) return false;
  return true;
}

/** Coverage / determinism / inventory / residue / confidence.
 *  Empty when the bundle carries no certification metadata, OR when every gate is ✓
 *  (green certification is hidden — only failures/warnings surface). */
export function certificationLines(
  beforeDir: string,
  afterDir: string,
  confidence: { ledger: ConfidenceLedgerFile | null; summary: ConfidenceSummary },
  elevatedNavigableChromeAdds = 0,
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
  const lines = [
    coverageLine(coverage, explicitExclusionCount(headLedger)),
    determinismLine(
      auditDeterminism(withCaptureDeterminism(beforeDir, baseLedger), withCaptureDeterminism(afterDir, headLedger)),
    ),
    inventoryLine(inv, hasCapturedInventory(beforeInventories, afterInventories), elevatedNavigableChromeAdds),
    // Only with residue or an armed gate, so an ordinary bundle keeps its short block.
    ...(hasResidue ? [dataResidueLine(res)] : []),
    confidenceLine(confidence.ledger, confidence.summary, sidecarPresent),
  ];
  const issues = lines.filter(isCertificationIssue);
  if (issues.length === 0) return [];
  return ['**Certification**', ...issues, ''];
}

export function liveTextFreezeLines(audit: LiveTextAudit): string[] {
  if (!audit.freeze || audit.violations.length === 0) return [];
  const samples = audit.violations
    .slice(0, 5)
    .map((item) =>
      !item.before && !item.after
        ? `- \`${safeKey(item.surface)}\`: freeze declared but captured text was missing — cannot verify ages are pinned`
        : `- \`${safeKey(item.surface)}\`: ${codeValue(String(item.before))} → ${codeValue(String(item.after))}`,
    );
  return [
    '',
    // The headline says the compare cannot be certified; this names the drift and the fix once.
    '⚠ **To fix:** fixture timestamps so ages use the frozen clock, or declare `liveText` without `freeze` so age-only drift stays advisory.',
    '',
    ...samples,
    '',
  ];
}

export function criticalObligationLines(
  audit: CriticalObligationAudit | undefined,
  declared: DeclaredCriticalObligations | undefined,
): string[] {
  if (!audit?.armed) return [];
  if (audit.failing.length + audit.unresolved.length + audit.contradictory.length === 0) {
    // All-green critical obligations stay hidden with the rest of the green certification.
    return [];
  }
  const describe = (key: string): string => {
    const meta = declared?.[key];
    return meta
      ? `${escapeInlineMarkdown(key)} (${escapeInlineMarkdown(meta.owner)}: ${escapeInlineMarkdown(meta.reason)})`
      : escapeInlineMarkdown(key);
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

/**
 * Plain-language product-state warning for the above-the-fold verdict.
 * Empty when identity is proven (comparable) or not required — never shown as a peer restyle card.
 */
export function productStateWarningLines(comparison: ComparabilitySummary, legacyPairs?: LegacyPairAudit): string[] {
  // Product-state status is machine output (report.json `comparability`, the CLI); the report
  // only says so when it stops certification, in plain words.
  const undeclared = legacyPairs?.armed ? legacyPairs.undeclared.length : 0;
  if (!comparison.blocksCertification && undeclared === 0) return [];
  const { incomparable, requiredUnproven, globalRequiredUnproven, unproven } = comparison.counts;
  const declare =
    'Declare `productState {id, revision}` on both sides, or record it in `styleproof.product-state.json`.';
  const lines = [
    incomparable
      ? `${incomparable} paired capture(s) declare a different product state on base and head, so their differences are not compared.`
      : '',
    requiredUnproven + globalRequiredUnproven || undeclared
      ? `${requiredUnproven + globalRequiredUnproven || undeclared || unproven} paired capture(s) are not proven to show the same product state on both sides. ${declare}`
      : '',
  ].filter(Boolean);
  return [
    `⛔ **This compare cannot certify:** ${lines.join(' ') || `${unproven} paired capture(s) are not proven to show the same product state on both sides. ${declare}`}`,
    '',
  ];
}

/** Fold Evidence (certification issues, receipts) under a collapsed <details> by default. */
export function evidenceSection(body: string[]): string[] {
  const lines = body.filter((l, i, arr) => !(l === '' && (i === 0 || arr[i - 1] === '')));
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) return [];
  return ['', '<details>', '<summary>Evidence (warnings & failures)</summary>', '', ...lines, '', '</details>'];
}
