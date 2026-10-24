#!/usr/bin/env node
// Diff two computed-style map captures and apply every certification gate.
// Per surface: DOM changes, computed-style changes (incl. pseudo elements), and
// :hover/:focus/:active deltas. Custom properties (--*) are inputs, not outcomes.
// Exit 0 = identical (certified only when source-bound; an unbound run is a labelled
// diagnostic), 1 = reviewable differences or non-certifying evidence,
// 2 = usage/capture error, 3 = only NEW surfaces with no baseline.
//
// Reading order: read the evidence (bin/diff/read.mjs), audit the declared ledgers,
// print each block (bin/diff/print-*.mjs), apply the gate table, write the --json
// receipt, print the summary, then write the audit trail (bin/diff/audit-trail.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { summarizeComparability } from '../dist/diff.js';
import { assessCertificationEvidence, classifyStyleProofVerdict } from '../dist/verdict.js';
import { collectStructureElevation, elevateReviewable } from '../dist/structure-elevation.js';
import { assessComparisonTruth, rawFindingsExplainedByLiveText } from '../dist/change-groups.js';
import { honestBaselineCompareAttribution } from '../dist/map-store.js';
import { applyLegacyPairReceipts, auditLegacyPairs } from '../dist/legacy-pairs.js';
import { applyCriticalObligationReceipts, auditCriticalObligations } from '../dist/critical-obligations.js';
import { AUDIT_FILE_NAME, createAudit } from '../dist/audit.js';
import { defineCli, errorMessage, fail, number } from './cli.mjs';
import { compareFlags, resolveCompareInputs, withCaptureDirs } from './compare.mjs';
import { readCompareEvidence } from './diff/read.mjs';
import { printSection } from './diff/output.mjs';
import {
  printBaselineNotes,
  printChangeGroups,
  printComparability,
  printOneSidedSurfaces,
} from './diff/print-changes.mjs';
import {
  printCoverageVerdict,
  printDeterminismVerdict,
  printInventoryAudit,
  printLiveText,
  printPixelGate,
  printResidueAudit,
  printStructureElevation,
  printUncomparedWarnings,
} from './diff/print-gates.mjs';
import { baselineSource, exitReason, trustReasons } from './diff/audit-trail.mjs';

const NAME = 'styleproof-diff';
const cli = defineCli({
  name: NAME,
  alias: 'compare',
  usage: [`${NAME} [baseRef] [options]`, `${NAME} <beforeDir> <afterDir> [options]`],
  positionals: true,
  flags: {
    ...compareFlags(),
    max: { value: 'n', help: 'max lines printed per surface before truncating', default: 40 },
    json: { value: 'file', help: 'also write the full structured diff to <file>' },
    'allow-unasserted': {
      help: 'diagnostic mode: permit unasserted completeness / unknown determinism without exit 1 (JSON marks certifiesFully=false)',
    },
    pixels: {
      help: 'arm the pixel gate: also compare the captured screenshots (rest and :hover/:focus/:active layers) and attribute every changed region to the elements under it; any region, or a layer captured on one side only, exits 1',
    },
    'audit-json': {
      value: 'file',
      help: `write the durable audit trail to <file> (default: alongside --json or ${AUDIT_FILE_NAME} in cwd)`,
    },
  },
  notes: [
    'exit: 0 identical — certified only when source-bound (--expected-before-sha and',
    '      --expected-after-sha); without them 0 is an UNVERIFIED DIAGNOSTIC, not',
    '      certification (--json certifiesFully: false), so the local and',
    '      design-vs-build two-directory forms keep working. 1 differences found OR',
    '      non-certifying evidence',
    '      (unasserted completeness, unknown/unproven determinism, incomplete registry,',
    '      inventory/residue failures, removed surfaces), 2 usage/capture error,',
    '      3 only NEW surfaces (present only on the head side, no baseline to diff',
    '      against); a REMOVED surface (present only on the base side) exits 1',
  ],
});

const { opts, args } = cli.parse();
const MAX = number(NAME, 'max', opts.max);
const jsonOut = opts.json ?? null;
const allowUnasserted = Boolean(opts['allow-unasserted']);
const pixels = Boolean(opts.pixels);
const migration = Boolean(opts.migration);
const inputs = resolveCompareInputs(NAME, {
  opts,
  args,
  purpose: 'comparison',
  usage: `usage: ${NAME} [baseRef] [--max N] [--json <file>]`,
});
const { requireStateIdentity, expectedBeforeSha, expectedAfterSha } = inputs;

// ── read everything while the (possibly restored) dirs still exist ─────────────
const read = withCaptureDirs(NAME, inputs, () => {
  const evidence = readCompareEvidence(NAME, inputs, { migration, pixels });
  // #766 navigable Global chrome + visible paired-surface add/remove, read from the maps before cleanup.
  const elevation = collectStructureElevation({
    beforeDir: inputs.beforeDir,
    afterDir: inputs.afterDir,
    migration,
    surfacePaths: evidence.surfacePaths,
    surfaceKeyOf: evidence.surfaceKeyOf,
  });
  return { ...evidence, elevation };
});
const {
  result,
  inventoryAudit,
  residueAudit,
  coverageVerdict,
  determinismVerdict,
  confidenceSummary,
  liveTextAudit,
  surfacePaths,
  surfaceKeyOf,
  baselineProvenance,
  baseMapCount,
  elevation,
  sourceBinding,
  evidenceBinding,
} = read;
const {
  surfaces,
  counts,
  compared,
  volatile,
  headOnlyVolatile,
  baseOnlyVolatile,
  documentRootVolatile,
  statesUncertified,
  baselineFailures,
  undeclaredOnBase,
} = result;
const pixelSurfaces = result.pixels ?? [];

// ── declared ledgers: legacy pairs and critical obligations ────────────────────
let { comparability } = result;
const legacyPairAudit = auditLegacyPairs(comparability, inputs.legacyPairDeclarations, inputs.legacyPairsArmed);
comparability = applyLegacyPairReceipts(comparability, legacyPairAudit);
const legacyPairFails = legacyPairAudit.armed
  ? legacyPairAudit.undeclared.length + legacyPairAudit.staleAcknowledgements.length
  : 0;
const declaredLegacyPairs = legacyPairAudit.armed && legacyPairAudit.declared.length > 0;
const criticalAudit = auditCriticalObligations(
  comparability,
  inputs.criticalObligations,
  Object.keys(read.coverageExclusions),
  inputs.criticalStatesArmed,
);
comparability = applyCriticalObligationReceipts(comparability, criticalAudit);
// Unbound diagnostic compares list undeclared legacy pairs as advisory, like declared ones; gates keep `comparability`.
const displayComparability =
  sourceBinding.status === 'bound'
    ? comparability
    : applyCriticalObligationReceipts(result.comparability, criticalAudit);
const criticalFails = criticalAudit.armed ? criticalAudit.unresolved.length + criticalAudit.contradictory.length : 0;

// Canonical comparison truth: raw certification counts vs reviewable (cleaned) findings.
const truth = assessComparisonTruth(surfaces, counts, comparability, {
  requireStateIdentity,
  ...(liveTextAudit ? { liveText: liveTextAudit } : {}),
});
// Elevated structure (collected above) counts as reviewable and exits 1.
const elevatedNavigableChromeAdds = elevation.chrome.count;
const elevatedVisibleStructure = elevation.visible.count;
const { reviewableCounts: gateReviewableCounts, hasReviewableEvidence: gateHasReviewableEvidence } = elevateReviewable(
  truth,
  elevation,
);
const comparison = summarizeComparability(comparability, requireStateIdentity);
const explainedMissingBaselineSurfaceKeys = surfaces
  .filter((s) => s.classification === 'baseline-repair-debt')
  .map((s) => s.surface)
  .sort((a, b) => a.localeCompare(b));
const partialBaseline = baselineFailures.length > 0;
const baselineAttribution = honestBaselineCompareAttribution({ baseCaptureFailed: false, receipts: baselineFailures });

// ── human output ───────────────────────────────────────────────────────────────
printBaselineNotes({ baselineFailures, baselineAttribution, undeclaredOnBase });
printComparability({
  comparison,
  legacyPairAudit,
  declaredLegacyPairs,
  criticalAudit,
  criticalObligations: inputs.criticalObligations,
});
printOneSidedSurfaces(surfaces, baselineFailures);
printChangeGroups({ surfaces, displayComparability, requireStateIdentity, surfacePaths, surfaceKeyOf, max: MAX });

// ── gates ──────────────────────────────────────────────────────────────────────
const invRemovals = printInventoryAudit(inventoryAudit);
printStructureElevation(elevation);
const residueFails = printResidueAudit(residueAudit);
const coverageFails = printCoverageVerdict(coverageVerdict, allowUnasserted);
const determinismFails = printDeterminismVerdict(determinismVerdict, allowUnasserted);
const inaccessible = confidenceSummary?.counts.inaccessible ?? 0;
if (inaccessible > 0) {
  printSection(
    `✗ incomplete UI confidence: ${inaccessible} inaccessible blocked-continuation surface(s) — certification fails closed`,
  );
}

// Pixel gate (opt-in --pixels): every changed region is attributed to the elements under it;
// a layer captured on one side only cannot be certified and blocks too.
const pixelRegions = pixelSurfaces.reduce((n, s) => n + s.regionCount, 0);
const pixelUncompared = pixelSurfaces.reduce((n, s) => n + s.uncompared.length, 0);
if (pixels) printPixelGate({ surfaces: pixelSurfaces, regions: pixelRegions, uncompared: pixelUncompared });
// Armed with no paired capture compares nothing: fail closed rather than pass vacuously.
const pixelBlocks = pixelRegions > 0 || pixelUncompared > 0 || (pixels && !pixelSurfaces.length);

const liveTextFreezeViolated = Boolean(liveTextAudit?.freeze && liveTextAudit.violations.length);
printLiveText(liveTextAudit, liveTextFreezeViolated);

// ── verdict ────────────────────────────────────────────────────────────────────
const reviewableTotal = gateReviewableCounts.dom + gateReviewableCounts.style + gateReviewableCounts.state;
// Zero the raw tally only when declared live text explains EVERY raw delta; any
// other stripped delta (a cleaned :hover width, an offset) keeps failing closed.
const declaredAgeOnly =
  Boolean(liveTextAudit?.declared) &&
  liveTextAudit.livePaths.length > 0 &&
  !liveTextFreezeViolated &&
  reviewableTotal === 0 &&
  !gateHasReviewableEvidence &&
  rawFindingsExplainedByLiveText(
    surfaces.filter((s) => !s.missing),
    liveTextAudit,
  );
const total = declaredAgeOnly ? 0 : counts.dom + counts.style + counts.state;
const newSurfaces = surfaces.filter((s) => s.missing === 'before').length;
const removedSurfaces = surfaces.filter((s) => s.missing === 'after').length;
const greenfieldNewSurfaces = surfaces.filter((s) => s.classification === 'genuinely-new').length;
// True first-adoption: bare before dir, only greenfield head surfaces. Keep exit 3 —
// do not let unasserted/unknown swallow it. Filtered pairs still have base maps.
const firstAdoptionBareBase =
  baseMapCount === 0 &&
  greenfieldNewSurfaces > 0 &&
  [removedSurfaces, total, invRemovals, residueFails, legacyPairFails, criticalFails].every((n) => n === 0);
const coverageBlocks = coverageFails && !(firstAdoptionBareBase && coverageVerdict?.basis === 'unasserted');
const determinismBlocks = determinismFails && !(firstAdoptionBareBase && determinismVerdict?.status === 'unknown');
const reportConsistency = truth.rawOnlyNoReviewable
  ? { ok: false, reason: 'raw_only_no_reviewable' }
  : { ok: true, reason: 'aligned' };
// The evidence receipt both the certification check and the trust verdict read.
const evidence = {
  sourceBinding,
  coverage: coverageVerdict,
  determinism: determinismVerdict,
  confidence: confidenceSummary,
  comparison,
  reportConsistency,
  statesUncertified,
  partialBaseline,
  explainedMissingBaselineSurfaces: explainedMissingBaselineSurfaceKeys,
  liveTextFreeze: { violated: liveTextFreezeViolated },
  volatility: { headOnly: headOnlyVolatile, baseOnly: baseOnlyVolatile, documentRoot: documentRootVolatile },
};
const certificationEvidence = assessCertificationEvidence({ ...evidence, criticalStates: criticalAudit });

// Every gate in one table: `blocks` drives the exit code and the clean line, `note`
// the summary suffix. Adding a gate means adding one row.
function legacyNote() {
  if (legacyPairFails) return ` + ${legacyPairFails} undeclared or stale legacy product-state pair(s)`;
  return declaredLegacyPairs
    ? ` + ${legacyPairAudit.declared.length} declared legacy pair(s) (advisory, not certified)`
    : '';
}
function criticalNote() {
  if (criticalFails) return ` + ${criticalFails} unresolved or contradictory critical obligation(s)`;
  const failing = criticalAudit.armed ? criticalAudit.failing.length : 0;
  return failing ? ` + ${failing} non-certifying critical obligation(s)` : '';
}
function coverageNote() {
  if (!coverageBlocks) return '';
  if (coverageVerdict?.basis === 'unasserted') return ' + completeness unasserted';
  return ` + ${coverageVerdict.uncovered.length} uncaptured registered surface(s)`;
}
const GATES = [
  { blocks: total > 0 },
  { blocks: partialBaseline },
  { blocks: comparison.blocksCertification },
  { blocks: removedSurfaces > 0, note: ` + ${removedSurfaces} REMOVED surface(s)` },
  { blocks: invRemovals > 0, note: ` + ${invRemovals} inventory gate failure(s) (unacknowledged or stale)` },
  {
    blocks: elevatedNavigableChromeAdds > 0,
    note: ` + ${elevatedNavigableChromeAdds} Global chrome navigable addition(s) (reviewable, #766)`,
  },
  {
    blocks: elevatedVisibleStructure > 0,
    note: ` + ${elevatedVisibleStructure} visible element addition(s)/removal(s) (reviewable)`,
  },
  { blocks: residueFails > 0, note: ` + ${residueFails} data-residue gate failure(s) (unacknowledged or stale)` },
  { blocks: legacyPairFails > 0, note: legacyNote(), alwaysNote: true },
  { blocks: criticalFails > 0, note: criticalNote(), alwaysNote: true },
  { blocks: inaccessible > 0, note: ` + ${inaccessible} inaccessible incomplete-UI surface(s)` },
  { blocks: coverageBlocks, note: coverageNote() },
  {
    blocks: determinismBlocks,
    note: determinismVerdict?.status === 'unknown' ? ' + determinism unknown' : ' + determinism unproven',
  },
  { blocks: !certificationEvidence.interactionStatesComplete },
  {
    blocks: headOnlyVolatile.length > 0,
    note: ` + ${headOnlyVolatile.length} subtree(s) newly volatile on head (excluded, not certified)`,
  },
  {
    blocks: baseOnlyVolatile.length > 0,
    note: ` + ${baseOnlyVolatile.length} subtree(s) volatile on the base only (excluded, review required)`,
  },
  {
    blocks: documentRootVolatile.length > 0,
    note: ` + ${documentRootVolatile.length} document root(s) volatile on head (page excluded, not certified)`,
  },
  {
    blocks: pixelBlocks,
    note: pixelSurfaces.length
      ? ` + pixel gate: ${pixelRegions} changed region(s)${pixelUncompared ? `, ${pixelUncompared} uncertified layer(s)` : ''}`
      : ' + pixel gate: nothing compared',
  },
];
// Backstop: the shared verdict's blockers (src/verdict.ts) also drive the exit, so
// a blocker the rows above miss can never exit 0. Only the documented escapes are
// neutralised: an unbound run stays a labelled diagnostic (exit 0, certifiesFully
// false — the local and design-vs-build two-directory forms carry no trusted SHAs),
// and --allow-unasserted / first adoption relax only what coverageBlocks and
// determinismBlocks already relax.
const exitEvidence = assessCertificationEvidence({
  ...evidence,
  sourceBinding: { status: 'bound' },
  coverage: coverageBlocks ? coverageVerdict : { basis: 'complete' },
  determinism: determinismBlocks ? determinismVerdict : { status: 'proven' },
  legacyPairs: legacyPairAudit,
  criticalStates: criticalAudit,
});
GATES.push({
  blocks: !exitEvidence.certifies,
  note: GATES.some((gate) => gate.blocks) ? '' : ' + non-certifying evidence',
});
const clean = !GATES.some((gate) => gate.blocks);
const notes =
  (greenfieldNewSurfaces > 0 ? ` (+${greenfieldNewSurfaces} new surface(s) with no baseline)` : '') +
  GATES.map((gate) => (gate.blocks || gate.alwaysNote ? (gate.note ?? '') : '')).join('');
// True only when the run would exit 0 as a full certification (not diagnostic).
const certifiesFully =
  certificationEvidence.certifies && clean && !allowUnasserted && !declaredLegacyPairs && greenfieldNewSurfaces === 0;

// `null` when no capture carried inventory; `unacknowledged` is the gating set.
const INVENTORY_NOTE =
  'no captured map carried an inventory — set `inventory: true` in the capture spec to arm the navigable-removal gate';
const inventoryReceipt = inventoryAudit && {
  removed: inventoryAudit.delta.removed.map((i) => i.key),
  added: inventoryAudit.delta.added.map((i) => i.key),
  unacknowledged: inventoryAudit.unexplained.map((i) => i.key),
  staleAcknowledgements: inventoryAudit.staleAllowances,
};

if (jsonOut) {
  // A write failure is a usage/setup error (exit 2), never the exit-1 CI reads as a real diff.
  try {
    fs.writeFileSync(
      jsonOut,
      JSON.stringify(
        {
          counts,
          ...(migration ? { migration: true } : {}),
          sourceBinding,
          evidenceBinding,
          // Reviewable tallies after cleanFindings (what the durable report shows).
          reviewableCounts: gateReviewableCounts,
          ...(elevatedNavigableChromeAdds ? { elevatedNavigableChromeAdds } : {}),
          ...(elevatedVisibleStructure ? { elevatedVisibleStructure } : {}),
          comparison,
          comparability,
          reportConsistency: truth.rawOnlyNoReviewable
            ? {
                ...reportConsistency,
                detail:
                  'certification differ found computed-style deltas that the visual report strips as derived/reflow longhands — no reviewable crops; fail closed as CERTIFICATION_FAILED, never STYLE_REVIEW_REQUIRED',
              }
            : reportConsistency,
          surfaces,
          compared,
          baselineFailures,
          ...(baselineProvenance ? { baselineProvenance } : {}),
          explainedMissingBaselineSurfaces: explainedMissingBaselineSurfaceKeys,
          partialBaseline,
          // Additive, only when present: base failures the base commit never declared.
          ...(undeclaredOnBase.length ? { undeclaredOnBase } : {}),
          // Subtrees excluded because a side auto-detected them as volatile at capture settle.
          volatileExcluded: volatile,
          // Subtrees volatile on the head but compared on the base: excluded, so they block certification.
          // Subtrees volatile on the base but settled on the head: excluded, so they need review (approvable).
          // html/body volatile on the head: the page was excluded, so it blocks certification.
          volatility: { headOnly: headOnlyVolatile, baseOnly: baseOnlyVolatile, documentRoot: documentRootVolatile },
          // Surfaces whose forced-state layer was skipped or unsupported on either side.
          statesUncertified,
          coverage: coverageVerdict,
          determinism: determinismVerdict,
          confidence: confidenceSummary,
          pixels: pixels
            ? {
                armed: true,
                regions: pixelRegions,
                uncomparedLayers: pixelUncompared,
                blocking: pixelBlocks,
                surfaces: pixelSurfaces,
              }
            : null,
          certifiesFully,
          diagnostic: allowUnasserted,
          liveTextFreeze: { violated: liveTextFreezeViolated },
          inventory: inventoryReceipt,
          ...(inventoryAudit ? {} : { inventoryNote: INVENTORY_NOTE }),
          legacyPairs: { ...legacyPairAudit, blocking: legacyPairFails },
          criticalStates: { ...criticalAudit, blocking: criticalFails },
          dataResidue: residueAudit && {
            armed: residueAudit.armed,
            failing: residueAudit.residue.map((r) => r.key),
            unacknowledged: residueAudit.unacknowledged.map((r) => r.key),
            staleAcknowledgements: residueAudit.staleAcknowledgements,
            blocking: residueFails,
          },
        },
        null,
        2,
      ),
    );
  } catch (error) {
    fail(NAME, `could not write --json ${jsonOut}: ${errorMessage(error)}`);
  }
}

printUncomparedWarnings({
  volatile,
  headOnlyVolatile,
  documentRootVolatile,
  baseOnlyVolatile,
  statesUncertified,
  rawOnlyNoReviewable: truth.rawOnlyNoReviewable,
  max: MAX,
});

const repairDebtOnly = partialBaseline && greenfieldNewSurfaces === 0;
function summaryLine() {
  if (!clean) {
    return comparison.blocksCertification
      ? `✗ non-certifying product-state comparison; raw diagnostic detector totals: ${counts.dom} DOM, ${counts.style} computed-style, ${counts.state} state-delta difference(s)${notes}`
      : `✗ ${counts.dom} DOM change(s), ${counts.style} computed-style difference(s), ${counts.state} state-delta difference(s) across ${surfaces.length} surfaces${notes}`;
  }
  let diagnostic = `${greenfieldNewSurfaces} new surface(s) captured with no baseline to compare — review before baselining`;
  if (newSurfaces === 0)
    diagnostic = `0 reviewable computed-style changes across ${compared} paired capture(s); content/structure not evaluated`;
  else if (repairDebtOnly)
    diagnostic = `${newSurfaces} surface(s) on head have no base map because a named baseline surface capture failed — not a base recapture failure`;
  if (sourceBinding.status !== 'bound') {
    return `⚠ UNVERIFIED DIAGNOSTIC (not certified: unbound): ${diagnostic}; trusted source SHAs were not supplied, so this result is not certification`;
  }
  if (newSurfaces > 0) return `ℹ ${diagnostic}${repairDebtOnly ? ' (see callout above)' : ''}`;
  return declaredLegacyPairs
    ? `⚠ declared legacy product-state pair(s) — ${diagnostic}; advisory, not certified`
    : `✓ ${diagnostic}`;
}
printSection(summaryLine());

const exitCode = !clean || liveTextFreezeViolated ? 1 : greenfieldNewSurfaces > 0 ? 3 : 0;

// ── durable audit trail ────────────────────────────────────────────────────────
const auditPath = opts['audit-json'] ?? (jsonOut ? path.join(path.dirname(jsonOut), AUDIT_FILE_NAME) : AUDIT_FILE_NAME);
try {
  const verdict = classifyStyleProofVerdict(
    {
      ...evidence,
      legacyPairs: legacyPairAudit,
      criticalStates: criticalAudit,
      reviewableCounts: gateReviewableCounts,
      ...(elevatedNavigableChromeAdds ? { elevatedNavigableChromeAdds } : {}),
      ...(elevatedVisibleStructure ? { elevatedVisibleStructure } : {}),
      surfaces,
      inventory: inventoryReceipt,
      dataResidue: residueAudit && {
        blocking: residueFails,
        unacknowledged: residueAudit.unacknowledged.map((r) => r.key),
      },
    },
    { gateInventoryRemovals: true, baseCaptureFailed: false, changed: exitCode === 1 || exitCode === 3 },
  );
  const observedBaseSha = expectedBeforeSha || sourceBinding.before?.observed || null;
  const audit = createAudit({
    runId: process.env.GITHUB_RUN_ID
      ? `github-run-${process.env.GITHUB_RUN_ID}-attempt-${process.env.GITHUB_RUN_ATTEMPT || '1'}`
      : `local-${Date.now()}`,
    headSha: expectedAfterSha || sourceBinding.after?.observed || '',
    baseSha: observedBaseSha,
    comparison: {
      baselineSource: baselineSource(baselineProvenance, baseMapCount),
      baselineSha: baselineProvenance?.restoredSha || observedBaseSha,
      surfacesCompared: compared,
      surfacesNew: greenfieldNewSurfaces,
      surfacesRemoved: removedSurfaces,
      changesFound: total,
      contentChanges: 0,
    },
    trustDecision: {
      finalState: verdict.state,
      gateMode: migration ? 'migration' : 'certify',
      reasons: trustReasons({
        sourceBinding,
        coverageVerdict,
        determinismVerdict,
        residueFails,
        invRemovals,
        total,
        greenfieldNewSurfaces,
        partialBaseline,
        baselineAttribution,
        headOnlyVolatile,
        documentRootVolatile,
        baseOnlyVolatile,
      }),
      exitCode,
      exitReason: exitReason(exitCode, { certifiesFully, bound: sourceBinding.status === 'bound', clean }),
    },
  });
  fs.writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`);
} catch (error) {
  console.error(`${NAME}: could not write audit trail to ${auditPath}: ${errorMessage(error)}`);
}

process.exit(exitCode);
