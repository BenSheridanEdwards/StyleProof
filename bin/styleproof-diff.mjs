#!/usr/bin/env node
// Diff two computed-style map captures and apply every certification gate.
// Per surface: DOM changes, computed-style changes (incl. pseudo elements), and
// :hover/:focus/:active deltas. Custom properties (--*) are inputs, not outcomes.
// Exit 0 = identical (certified only when source-bound; an unbound run is a labelled
// diagnostic), 1 = reviewable differences or non-certifying evidence,
// 2 = usage/capture error, 3 = only NEW surfaces with no baseline.
import fs from 'node:fs';
import path from 'node:path';
import { auditLiveTextDirs, diffStyleMapDirs, findingLabel, summarizeComparability } from '../dist/diff.js';
import { liveTextFreezeError } from '../dist/live-text.js';
import { assessCertificationEvidence, classifyStyleProofVerdict } from '../dist/verdict.js';
import {
  assessComparisonTruth,
  classifyChrome,
  cleanFindingsForDisplay,
  countCapturedSurfaceBases,
  derivedLonghandCount,
  formatSurfaceList,
  groupByPath,
  groupBySignature,
  groupTitle,
  rawFindingsExplainedByLiveText,
  summarizeProps,
} from '../dist/change-groups.js';
import { honestBaselineCompareAttribution, readBaselineProvenance } from '../dist/map-store.js';
import {
  captureKeysIn,
  mergeSurfaceKeyLookup,
  readInventories,
  readResidue,
  surfaceElementPaths,
} from '../dist/capture.js';
import { auditRunInventory, hasCapturedInventory, readAckFile } from '../dist/inventory.js';
import { auditRunResidue, readResidueAckFile } from '../dist/data-residue.js';
import { applyLegacyPairReceipts, auditLegacyPairs } from '../dist/legacy-pairs.js';
import { applyCriticalObligationReceipts, auditCriticalObligations } from '../dist/critical-obligations.js';
import { COVERAGE_LEDGER, auditCoverage, auditDeterminism } from '../dist/coverage.js';
import { readConfidenceLedger, summarizeConfidence } from '../dist/confidence-ledger.js';
import { AUDIT_FILE_NAME, createAudit } from '../dist/audit.js';
import { defineCli, errorMessage, fail, number } from './cli.mjs';
import { compareFlags, resolveCompareInputs, withCaptureDirs } from './compare.mjs';

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

const print = (...lines) => lines.forEach((line) => console.log(line));
/** A titled block: the title opens a paragraph, its lines follow. */
const printSection = (title, lines = []) => print(`\n${title}`, ...lines);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ── read everything while the (possibly restored) dirs still exist ─────────────

/** `key -> reason` ledgers fail loud (exit 2) so a broken file can't silently un-acknowledge a real gap. */
function readLedgerOrExit(read) {
  try {
    return read();
  } catch (error) {
    return fail(NAME, errorMessage(error));
  }
}

function readCoverageLedger(dir) {
  const file = path.join(dir, COVERAGE_LEDGER);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Reading a corrupt ledger as "no registry" would silently disarm the coverage, determinism, and residue gates.
    return fail(
      NAME,
      `corrupt coverage ledger: ${file} — recapture the bundle; refusing to compare with disarmed gates.`,
    );
  }
}

const surfaceKeysIn = (dir) => [...new Set(captureKeysIn(dir).map((key) => key.replace(/@\d+$/, '')))];

function readInventoryAudit(dirA, dirB) {
  const baseInv = readInventories(dirA);
  const headInv = readInventories(dirB);
  if (!hasCapturedInventory(baseInv, headInv)) return null;
  const allowed = readLedgerOrExit(readAckFile);
  return { allowed, ...auditRunInventory(baseInv, headInv, allowed) };
}

function readResidueAudit(dirB, headLedger) {
  const armed = headLedger?.dataResidue === 'gate';
  const headResidue = readResidue(dirB);
  if (!armed && !headResidue.some((m) => m.dataResidue?.length)) return null;
  const acknowledged = readLedgerOrExit(readResidueAckFile);
  return { acknowledged, hasLedger: headLedger != null, ...auditRunResidue(headResidue, acknowledged, armed) };
}

const read = withCaptureDirs(NAME, inputs, () => {
  const { beforeDir: dirA, afterDir: dirB } = inputs;
  const headLedger = readCoverageLedger(dirB);
  return {
    result: diffStyleMapDirs(dirA, dirB, { includeStructure: migration, pixels }),
    inventoryAudit: readInventoryAudit(dirA, dirB),
    residueAudit: readResidueAudit(dirB, headLedger),
    coverageExclusions: headLedger?.exclude ?? {},
    coverageVerdict: auditCoverage(surfaceKeysIn(dirB), headLedger),
    determinismVerdict: auditDeterminism(readCoverageLedger(dirA), headLedger),
    confidenceSummary: summarizeConfidence(readConfidenceLedger(dirB)),
    liveTextAudit: auditLiveTextDirs(dirA, dirB),
    surfacePaths: surfaceElementPaths(dirA, dirB),
    surfaceKeyOf: mergeSurfaceKeyLookup(dirA, dirB),
    baselineProvenance: readBaselineProvenance(dirA),
    baseMapCount: captureKeysIn(dirA).length,
  };
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
  sourceBinding,
  evidenceBinding,
} = read;
const { surfaces, counts, compared, volatile, headOnlyVolatile, statesUncertified, baselineFailures } = result;
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
const criticalFails = criticalAudit.armed ? criticalAudit.unresolved.length + criticalAudit.contradictory.length : 0;

// Canonical comparison truth: raw certification counts vs reviewable (cleaned) findings.
const truth = assessComparisonTruth(surfaces, counts, comparability, {
  requireStateIdentity,
  ...(liveTextAudit ? { liveText: liveTextAudit } : {}),
});
const comparison = summarizeComparability(comparability, requireStateIdentity);
const explainedMissingBaselineSurfaceKeys = surfaces
  .filter((s) => s.classification === 'baseline-repair-debt')
  .map((s) => s.surface)
  .sort((a, b) => a.localeCompare(b));
const partialBaseline = baselineFailures.length > 0;
const baselineAttribution = honestBaselineCompareAttribution({ baseCaptureFailed: false, receipts: baselineFailures });

// ── human output ───────────────────────────────────────────────────────────────
if (partialBaseline) {
  printSection(`⚠ ${baselineFailures.length} baseline capture failure(s): ${baselineAttribution.summary}`, [
    '  Failure details remain in the local capture manifest and are not echoed from untrusted artifacts.',
  ]);
}

function comparabilityHeadline() {
  const c = comparison.counts;
  if (comparison.status === 'comparable')
    return `✓ product-state identity comparable on ${c.comparable} paired capture(s)`;
  if (comparison.status === 'not-required')
    return 'ℹ product-state comparison not required — no paired capture obligation';
  if (!comparison.blocksCertification) {
    return declaredLegacyPairs
      ? `⚠ product-state identity unproven on ${legacyPairAudit.declared.length} declared legacy pair(s) — ` +
          'on the record, advisory, not certified. Stamp productState {id, revision} to certify.'
      : `⚠ product-state identity unproven on ${c.unproven} legacy paired capture(s) — ` +
          'legacy compatibility mode keeps the existing verdict, but this is not proof of same product state. ' +
          'Pass --require-state-identity to make it non-certifying, or declare known pairs in styleproof.product-state.json.';
  }
  const reasons = [
    [c.incomparable, 'explicit mismatch(es)'],
    [c.requiredUnproven, 'required-unproven pair(s)'],
    [c.globalRequiredUnproven, 'globally-required legacy pair(s)'],
    [legacyPairAudit.armed ? legacyPairAudit.undeclared.length : 0, 'undeclared legacy pair(s)'],
  ]
    .filter(([n]) => n)
    .map(([n, what]) => `${n} ${what}`);
  return `✗ product-state identity ${comparison.status.toUpperCase()} — ${reasons.join(', ')}. Raw style deltas remain diagnostic only; they are not approval evidence.`;
}

function obligationLines() {
  const lines = [];
  if (legacyPairAudit.armed) {
    for (const key of legacyPairAudit.undeclared)
      lines.push(
        `undeclared legacy pair: ${key} — stamp productState {id, revision}, or record it in styleproof.product-state.json {"<surface>":"<why>"}.`,
      );
    for (const key of legacyPairAudit.staleAcknowledgements)
      lines.push(`stale legacy-pair declaration: ${key} — prune it from styleproof.product-state.json`);
  }
  if (criticalAudit.armed) {
    const meta = (key) => {
      const record = inputs.criticalObligations[key];
      return `owner ${record?.owner ?? 'unknown'}: ${record?.reason ?? 'no reason recorded'}`;
    };
    for (const key of criticalAudit.failing)
      lines.push(
        `critical obligation ${key} is not certifying — ${meta(key)}. Stamp matching productState {id, revision} to certify.`,
      );
    for (const key of criticalAudit.unresolved)
      lines.push(
        `unresolved critical obligation ${key} — no paired surface evidence (lost capture, removed surface, or unknown ID). ${meta(key)}.`,
      );
    for (const key of criticalAudit.contradictory)
      lines.push(
        `contradictory critical obligation ${key} — declared critical and coverage-excluded. A state cannot both certify and opt out.`,
      );
  }
  return lines.map((line) => `  ✗ ${line}`);
}
printSection(comparabilityHeadline(), obligationLines());

// One finding's lines: a heading, then its summarised property deltas. `inventory` =
// one-sided added path: head-side values with no baseline, never before → after restyles.
function findingLines(f, inventory = false) {
  if (f.kind === 'dom') return [];
  const rows = summarizeProps(f.props);
  if (!rows.length) return [];
  const head =
    f.kind === 'state'
      ? `  [:${f.state}] ${findingLabel(f.path, f.cls)}${f.sub !== f.path ? ` ⇒ ${f.sub}` : ''}`
      : `  ${findingLabel(f.path, f.cls)}${f.pseudo || ''}`;
  const note = inventory ? '  (head-side inventory — no baseline)' : '';
  return [
    head + note,
    ...rows.map((p) => (inventory ? `    ${p.prop}: ${p.after}` : `    ${p.prop}: ${p.before} → ${p.after}`)),
  ];
}

function elementLines(findings) {
  const lines = [];
  for (const group of groupByPath(findings)) {
    const dom = group.find((f) => f.kind === 'dom');
    if (dom) {
      lines.push(
        dom.change === 'retagged'
          ? `  DOM retagged: ${dom.path} ${dom.detail ?? ''}`
          : `  DOM ${dom.change}: ${findingLabel(dom.path, dom.cls)}`,
      );
    }
    for (const f of group) lines.push(...findingLines(f, dom?.change === 'added'));
  }
  return lines;
}

// One-sided surfaces keep their own line. A baseline-capture failure is repair debt,
// not first adoption; only an unexplained after-only surface is NEW.
const ONE_SIDED = {
  removed: (s) => `${s}: ✗ REMOVED surface — captured only in the before set; the head no longer renders it`,
  'baseline-repair-debt': (s, sha) =>
    `${s}: ✗ baseline repair debt — captured only in the after set because ${s} failed${sha ? ` at ${sha}` : ''}; not a base recapture failure — repair that surface on the named SHA`,
  'genuinely-new': (s) =>
    `${s}: new surface — captured only in the after set, no baseline to compare; review before baselining`,
};
for (const sd of surfaces) {
  if (sd.missing) printSection(ONE_SIDED[sd.classification](sd.surface, baselineFailures[0]?.sha));
}

// Group the changed surfaces the way the report does, so an identical change across
// N surfaces prints once (with the count). Carry the raw findings to report the fold.
const nonCertifying = (receipt) =>
  receipt?.status === 'incomparable' || (receipt?.status === 'unproven' && (receipt.required || requireStateIdentity));
const preparedForGrouping = surfaces
  .filter((sd) => !sd.missing && !nonCertifying(comparability.find((entry) => entry.surface === sd.surface)))
  .map((sd) => ({ surface: sd.surface, findings: cleanFindingsForDisplay(sd.findings), raw: sd.findings }))
  .filter((p) => p.findings.length > 0);

function printGroup(cg) {
  const lines = elementLines(cg.findings);
  const derived = derivedLonghandCount(cg.rep.raw) - derivedLonghandCount(cg.findings);
  const foldNote = derived > 0 ? ` (+${plural(derived, 'derived longhand')})` : '';
  const others = cg.surfaces.length - 1;
  const scope =
    others > 0
      ? `${cg.rep.surface} (+${plural(others, 'more surface')}: ${formatSurfaceList(cg.surfaces)})`
      : cg.rep.surface;
  printSection(`${scope}: ${groupTitle(cg.findings)}${foldNote}`, lines.slice(0, MAX));
  if (lines.length > MAX) console.log(`  ... and ${lines.length - MAX} more lines (re-run with --max ${lines.length})`);
}

// Shared-chrome tier: a change that rode the frame every view draws gets one banner.
const { chrome, rest } = classifyChrome(groupBySignature(preparedForGrouping), surfacePaths, surfaceKeyOf);
if (chrome.length) {
  const bases = countCapturedSurfaceBases([...surfacePaths.keys()], surfaceKeyOf);
  printSection(
    `🧱 Global chrome change(s) — across all ${bases} captured surface base(s): ${chrome.length} change(s) rode the shared frame every view draws (a persistent nav, header, or footer).`,
  );
}
for (const cg of [...chrome, ...rest]) printGroup(cg);

// ── gates ──────────────────────────────────────────────────────────────────────
function printInventoryAudit(audit) {
  if (!audit) return 0;
  const { delta, unexplained, staleAllowances, allowed } = audit;
  if (!delta.added.length && !delta.removed.length && !staleAllowances.length) {
    printSection('📐 Inventory: navigable set unchanged across captured surfaces');
    return 0;
  }
  printSection('📐 Inventory (navigable affordances — route links, tabs, menu items, nav buttons):', [
    ...delta.removed.map((it) =>
      allowed[it.key]
        ? `  removed: ${it.key} ("${it.label}") — acknowledged: ${allowed[it.key]}`
        : `  ✗ REMOVED, unacknowledged: ${it.key} ("${it.label}")`,
    ),
    ...delta.added.map((it) => `  + added: ${it.key} ("${it.label}")`),
    ...staleAllowances.map(
      (k) => `  ✗ stale allowRemoved (key is not actually removed): ${k} — prune it from styleproof.inventory.json`,
    ),
    ...(unexplained.length
      ? [
          `  → ${unexplained.length} unacknowledged removal(s): restore the affordance, or record the decision in styleproof.inventory.json {"<key>":"<why>"}.`,
        ]
      : []),
  ]);
  // A stale allowance blocks like a stale residue acknowledgement: it pre-acknowledges the next removal.
  return unexplained.length + staleAllowances.length;
}

const RESIDUE_NEXT = {
  armed:
    '  → {n} unacknowledged failing endpoint(s): fixture each (page.route / liveStates), acknowledge intentional ones in styleproof.data-residue.json {"<key>":"<why>"}, or opt down with `dataResidue: "warn"` in the capture spec.',
  warn: '  → recorded and warned (dataResidue: "warn" — the opt-out). Remove it to restore the default gate that BLOCKS on these.',
  noLedger:
    '  → recorded and warned — the head bundle carries no coverage ledger (ad-hoc or pre-3.10 capture), so the residue gate cannot arm. A spec-driven capture records the ledger and gates by default.',
};

function residueLine(r, ack, armed) {
  if (ack !== undefined) return `  ${r.surface} · ${r.endpoint} (${r.reason}) — acknowledged: ${ack}`;
  return `  ${armed ? '✗ ' : '⚠ '}${r.surface} · ${r.endpoint} (${r.reason})${armed ? ', unacknowledged' : ''}`;
}

function printResidueAudit(audit) {
  if (!audit) return 0;
  const { residue, unacknowledged, staleAcknowledgements, armed, hasLedger, acknowledged } = audit;
  if (!residue.length && !staleAcknowledgements.length) {
    printSection('Failed data request: no API failed during capture');
    return 0;
  }
  const next = RESIDUE_NEXT[armed ? 'armed' : hasLedger ? 'warn' : 'noLedger'];
  printSection('Failed data request (an API failed during capture, so the screenshot is the fallback UI):', [
    ...residue.map((r) => residueLine(r, acknowledged[r.key], armed)),
    ...staleAcknowledgements.map((k) => `  ⚠ stale acknowledgement (endpoint no longer failing/present): ${k}`),
    ...(unacknowledged.length ? [next.replace('{n}', String(unacknowledged.length))] : []),
  ]);
  return armed ? unacknowledged.length + staleAcknowledgements.length : 0;
}

/** Coverage and determinism share one shape: proven / unknown (diagnostic escape) / failed. Returns "blocks". */
function printVerdict(status, { ok, unknown, okLine, unknownDiagnostic, unknownRefuse, failedLines }) {
  if (status === ok) {
    console.log(okLine);
    return false;
  }
  if (status === unknown) {
    console.log(allowUnasserted ? unknownDiagnostic : unknownRefuse);
    return !allowUnasserted;
  }
  console.log(failedLines);
  return true;
}

function printCoverageVerdict(v) {
  const stale = (v.staleExclusions ?? [])
    .map((k) => `\n  ⚠ stale exclude (not in the registry): ${k} — prune it from the spec`)
    .join('');
  const uncovered = v.uncovered ?? [];
  return printVerdict(v.basis, {
    ok: 'complete',
    unknown: 'unasserted',
    okLine: `\n✓ coverage complete — all ${v.registrySize} registered surface(s) captured or explicitly excluded${stale}`,
    unknownDiagnostic:
      '\n⚠ completeness NOT asserted — diagnostic mode (--allow-unasserted): comparing captured surfaces only.\n' +
      '  This run does NOT certify fully. Declare `expected` for certifying captures.',
    unknownRefuse:
      '\n✗ completeness NOT asserted — refusing certification. A filtered, crawl, or registry-less\n' +
      '  capture cannot share exit 0 with a complete asserted capture. Declare `expected`, or pass\n' +
      '  --allow-unasserted for an explicit diagnostic comparison (certifiesFully: false).',
    failedLines:
      `\n✗ coverage INCOMPLETE — ${uncovered.length} registered surface(s) not captured (of ${v.registrySize}):` +
      uncovered.map((k) => `\n  ✗ missing: ${k}`).join('') +
      "\n  → capture each (or move it to `exclude` with a reason). A green can't certify what was never captured.",
  });
}

function printDeterminismVerdict(v) {
  return printVerdict(v.status, {
    ok: 'proven',
    unknown: 'unknown',
    okLine: `\n✓ determinism proven — base ${v.base}, head ${v.head}`,
    unknownDiagnostic:
      '\n⚠ determinism basis unknown — diagnostic mode (--allow-unasserted): comparing as-is.\n' +
      '  This run does NOT certify fully. Spec-driven captures self-check and record the basis.',
    unknownRefuse:
      '\n✗ determinism basis unknown — refusing certification. A side carries no proven determinism\n' +
      '  ledger (filtered map, ad-hoc capture, or pre-ledger bundle). Spec-driven styleproof-map\n' +
      '  self-checks and records it; pass --allow-unasserted only for explicit diagnostic compares.',
    failedLines:
      `\n✗ determinism NOT proven — base ${v.base}, head ${v.head}. An unproven capture can drift, so a clean\n` +
      '  diff might be two matching NONDETERMINISTIC reads. Enable selfCheck (default) or replay a recorded HAR.',
  });
}

const invRemovals = printInventoryAudit(inventoryAudit);
const residueFails = printResidueAudit(residueAudit);
const coverageFails = printCoverageVerdict(coverageVerdict);
const determinismFails = printDeterminismVerdict(determinismVerdict);
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
function pixelLayerLines(surface, layer) {
  if (layer.status !== 'compared') {
    return [
      `  ${surface} [${layer.layer}]: ✗ screenshot ${layer.status.replace('-', ' on the ')} side — layer uncertified`,
    ];
  }
  const lines = layer.comparison.regions.map((region) => {
    const [x, y, w, h] = region.rect;
    const who = region.elements.length
      ? region.elements.map((e) => findingLabel(e.path, e.cls)).join(', ')
      : 'no captured element under the region';
    return `  ${surface} [${layer.layer}]: ${w}×${h} at ${x},${y} (${region.changedPixels} px) — ${who}`;
  });
  const mismatch = layer.comparison.sizeMismatch;
  if (mismatch) {
    lines.push(
      `    screenshot size ${mismatch.before[0]}×${mismatch.before[1]} → ${mismatch.after[0]}×${mismatch.after[1]}`,
    );
  }
  return lines;
}
if (pixels) {
  const flagged = pixelSurfaces.filter((s) => s.regionCount > 0 || s.uncompared.length > 0);
  if (!flagged.length) {
    printSection(
      `🖼 pixel gate: 0 changed region(s) across ${pixelSurfaces.length} paired capture(s), every screenshot layer compared`,
    );
  } else {
    printSection(
      `🖼 pixel gate: ${pixelRegions} changed region(s) in ${flagged.filter((s) => s.regionCount > 0).length} surface(s)`,
      flagged.flatMap((s) => s.layers.flatMap((layer) => pixelLayerLines(s.surface, layer))),
    );
  }
}
const pixelBlocks = pixelRegions > 0 || pixelUncompared > 0;

const liveTextFreezeViolated = Boolean(liveTextAudit?.freeze && liveTextAudit.violations.length);
if (liveTextFreezeViolated) {
  console.error(liveTextFreezeError(liveTextAudit));
} else if (liveTextAudit?.declared && liveTextAudit.livePaths.length) {
  printSection(
    `⏱ live/age/clock text: ${liveTextAudit.livePaths.length} declared live-text change(s) kept advisory — not a stylesheet regression`,
  );
}

// ── verdict ────────────────────────────────────────────────────────────────────
const reviewableTotal = truth.reviewableCounts.dom + truth.reviewableCounts.style + truth.reviewableCounts.state;
// Zero the raw tally only when declared live text explains EVERY raw delta; any
// other stripped delta (a cleaned :hover width, an offset) keeps failing closed.
const declaredAgeOnly =
  Boolean(liveTextAudit?.declared) &&
  liveTextAudit.livePaths.length > 0 &&
  !liveTextFreezeViolated &&
  reviewableTotal === 0 &&
  !truth.hasReviewableEvidence &&
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
  volatility: { headOnly: headOnlyVolatile },
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
    blocks: pixelBlocks,
    note: ` + pixel gate: ${pixelRegions} changed region(s)${pixelUncompared ? `, ${pixelUncompared} uncertified layer(s)` : ''}`,
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
          reviewableCounts: truth.reviewableCounts,
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
          // Subtrees excluded because a side auto-detected them as volatile at capture settle.
          volatileExcluded: volatile,
          // Subtrees volatile on the head but compared on the base: excluded, so they block certification.
          volatility: { headOnly: headOnlyVolatile },
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

if (volatile > 0) {
  printSection(
    `⚠ ${volatile} auto-detected volatile subtree(s) excluded from the comparison (still mutating at capture\n` +
      '  settle) — changes inside them are NOT certified. Fixture the region, or `ignore` it deliberately.',
  );
}
if (headOnlyVolatile.length > 0) {
  printSection(
    `✗ ${headOnlyVolatile.length} subtree(s) newly volatile on head — still mutating at capture settle on the head but\n` +
      '  settled and compared on the base, so they were excluded and whatever changed inside them is NOT certified:',
    [
      ...headOnlyVolatile.slice(0, MAX).map((v) => `  ✗ ${v.surface}: ${v.path}`),
      ...(headOnlyVolatile.length > MAX ? [`  ... and ${headOnlyVolatile.length - MAX} more`] : []),
      '  → stop the head-side churn (a timer, stream, or animation the PR added), fixture it, or `ignore` the region on both sides.',
    ],
  );
}
if (statesUncertified > 0) {
  printSection(
    `⚠ forced-state layer uncertified on ${statesUncertified} surface(s): at least one capture skipped or did not support it, so\n` +
      '  :hover/:focus/:active differences there were not fully compared.',
  );
}
if (truth.rawOnlyNoReviewable) {
  printSection(
    '⚠ report consistency: raw certification delta(s) have no reviewable rendering — the visual ' +
      'report would show nothing for a gating change. Failing closed as a certification inconsistency ' +
      '(not STYLE_REVIEW_REQUIRED, not a base recapture failure). Re-run with styleproof-report --include-layout-noise to inspect.',
  );
}

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
const check = (name, result, detail) => ({ check: name, result, detail });
/** One trust check per evidence class, keyed by the verdict's own status (`other` = failed). */
const TRUST_CHECKS = {
  coverage: {
    complete: (v) => check('coverage', 'complete', `${v.registrySize}/${v.registrySize} expected captured`),
    unasserted: () => check('coverage', 'unknown', 'completeness not asserted'),
    other: (v) => check('coverage', 'failed', `${v?.uncovered?.length ?? 0} uncaptured`),
  },
  determinism: {
    proven: () => check('determinism', 'proven', 'self-check passed'),
    unknown: () => check('determinism', 'unknown', 'determinism basis unknown'),
    other: () => check('determinism', 'failed', 'determinism unproven'),
  },
};
const trustCheck = (name, status, verdict) => (TRUST_CHECKS[name][status] ?? TRUST_CHECKS[name].other)(verdict);
const BASELINE_SOURCES = new Set(['exact-restore', 'ancestor-reuse', 'captured']);

function trustReasons() {
  const reasons = [
    sourceBinding.status === 'bound'
      ? check('source-binding', 'bound', 'both SHAs matched')
      : check('source-binding', 'failed', 'source SHAs not verified'),
    trustCheck('coverage', coverageVerdict?.basis, coverageVerdict),
    trustCheck('determinism', determinismVerdict?.status, determinismVerdict),
    check('data-residue', residueFails ? 'failed' : 'clean', `${residueFails} unacknowledged`),
    check(
      'inventory',
      invRemovals ? 'failed' : 'clean',
      invRemovals ? `${invRemovals} unacknowledged removal(s)` : '0 removals',
    ),
  ];
  if (total > 0 || greenfieldNewSurfaces > 0) {
    reasons.push(check('reviewable-changes', 'found', `${total} style, ${greenfieldNewSurfaces} new surface(s)`));
  }
  if (partialBaseline) reasons.push(check('baseline-surface-capture', 'failed', baselineAttribution.summary));
  if (headOnlyVolatile.length > 0) {
    reasons.push(check('volatility', 'failed', `${headOnlyVolatile.length} subtree(s) newly volatile on head`));
  }
  return reasons;
}

function baselineSource() {
  if (BASELINE_SOURCES.has(baselineProvenance?.baseline)) return baselineProvenance.baseline;
  return !baselineProvenance && baseMapCount > 0 ? 'captured' : 'none';
}

const auditPath = opts['audit-json'] ?? (jsonOut ? path.join(path.dirname(jsonOut), AUDIT_FILE_NAME) : AUDIT_FILE_NAME);
try {
  const verdict = classifyStyleProofVerdict(
    {
      ...evidence,
      legacyPairs: legacyPairAudit,
      criticalStates: criticalAudit,
      reviewableCounts: truth.reviewableCounts,
      surfaces,
      inventory: inventoryReceipt,
      dataResidue: residueAudit && {
        blocking: residueFails,
        unacknowledged: residueAudit.unacknowledged.map((r) => r.key),
      },
    },
    { gateInventoryRemovals: true, baseCaptureFailed: false, changed: exitCode === 1 || exitCode === 3 },
  );
  const exitReason = {
    // Exit 0 is certification only when certifiesFully; say which diagnostic it is otherwise.
    0: certifiesFully
      ? 'certified — no reviewable changes'
      : sourceBinding.status !== 'bound'
        ? 'not certified: unbound — no reviewable changes, but trusted source SHAs were not supplied'
        : 'not certified: diagnostic or advisory — no reviewable changes',
    1: clean ? 'non-certifying evidence' : 'reviewable differences found',
    3: 'new surfaces only — review before baselining',
  };
  const observedBaseSha = expectedBeforeSha || sourceBinding.before?.observed || null;
  const audit = createAudit({
    runId: process.env.GITHUB_RUN_ID
      ? `github-run-${process.env.GITHUB_RUN_ID}-attempt-${process.env.GITHUB_RUN_ATTEMPT || '1'}`
      : `local-${Date.now()}`,
    headSha: expectedAfterSha || sourceBinding.after?.observed || '',
    baseSha: observedBaseSha,
    comparison: {
      baselineSource: baselineSource(),
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
      reasons: trustReasons(),
      exitCode,
      exitReason: exitReason[exitCode] || 'unknown',
    },
  });
  fs.writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`);
} catch (error) {
  console.error(`${NAME}: could not write audit trail to ${auditPath}: ${errorMessage(error)}`);
}

process.exit(exitCode);
