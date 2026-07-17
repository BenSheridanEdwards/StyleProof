#!/usr/bin/env node
/**
 * Diff two computed-style map captures (see styleproof).
 *
 *   styleproof-diff [baseRef] [--max N] [--json <file>]
 *   styleproof-diff <beforeDir> <afterDir> [--max N] [--json <file>]
 *
 * Reports, per surface:
 *   - DOM changes (elements added/removed/retagged) — a CSS-only refactor
 *     must produce none; class attributes are deliberately NOT compared.
 *   - Style changes: any computed longhand that resolved differently,
 *     including ::before/::after/::marker/::placeholder.
 *   - State changes: anything :hover/:focus/:active used to change but no
 *     longer does (or now changes differently) — the classic dropped
 *     `hover:` variant a screenshot can never catch.
 *
 * No-arg and single base argument usage restore base/head maps from the StyleProof
 * map store branch by commit SHA. To compare already-restored/captured maps,
 * pass explicit before/after directories.
 *
 * Custom properties (--*) are ignored: they are inputs, not outcomes (see
 * README). Exit code 0 = identical, 1 = reviewable differences, 2 = usage/capture
 * error, 3 = only NEW surfaces (present only on the head side, no baseline to diff
 * against). A REMOVED surface (present only on the base side) is a change: exit 1.
 */
import fs from 'node:fs';
import path from 'node:path';
import { diffStyleMapDirs, findingLabel } from '../dist/diff.js';
// The shared grouping brain (leaf — no Playwright-adjacent imports) that already
// dedupes the report: group identical change-sets across surfaces and fold derived
// longhands. Used for the HUMAN output only; --json stays the raw machine contract.
import {
  cleanFindings,
  groupBySignature,
  groupByPath,
  groupTitle,
  summarizeProps,
  derivedLonghandCount,
  formatSurfaceList,
  classifyChrome,
  countCapturedSurfaceBases,
} from '../dist/change-groups.js';
import {
  DEFAULT_MAP_STORE_BRANCH,
  DEFAULT_REMOTE,
  assertCompatibleMapDirs,
  cleanupCachedCaptureDirs,
  manifestlessError,
  manifestlessSide,
  readMapManifest,
  resolveCachedCaptureDirs,
  surfaceMissingMatchesBaselineFailure,
  explainedMissingBaselineSurfaces,
} from '../dist/map-store.js';
import {
  cachedMapsUnavailableMessage,
  isHelpArg,
  missingManualCaptureMessage,
  showHelpAndExit,
  unknownFlagMessage,
} from '../dist/cli-errors.js';
import { readInventories, readResidue, surfaceElementPaths, mergeSurfaceKeyLookup } from '../dist/capture.js';
import { auditRunInventory, readAckFile } from '../dist/inventory.js';
import { auditRunResidue, readResidueAckFile } from '../dist/data-residue.js';
import { auditCoverage, auditDeterminism, COVERAGE_LEDGER } from '../dist/coverage.js';
import { isMapFile } from '../dist/map-store.js';

const COMMAND = path.basename(process.argv[1] ?? 'styleproof-diff').replace(/\.mjs$/, '');

// ── inventory guard (opt-in) ────────────────────────────────────────────────────
// Surfaces the navigable-inventory audit through the CLI. When captures carry
// `inventory` (from captureStyleMap({ inventory: true })), an affordance base
// offered and head no longer does BLOCKS unless acknowledged. Inert when no map
// carries inventory, so every existing capture behaves exactly as before.

// `key -> reason` acknowledged removals. Optional file; absent → none. Malformed
// JSON fails loud (exit 2) rather than silently un-acknowledging a real removal.
function loadAllowRemoved() {
  try {
    return readAckFile();
  } catch (e) {
    console.error(`${COMMAND}: ${e.message}`);
    process.exit(2);
  }
}

// Read both sides' inventory and audit removals. MUST run before any cached-map
// cleanup deletes the restored dirs. Returns null when no capture carries inventory.
function readInventoryAudit(dirA, dirB) {
  const baseInv = readInventories(dirA);
  const headInv = readInventories(dirB);
  if (![...baseInv, ...headInv].some((m) => m.inventory?.length)) return null;
  const allowed = loadAllowRemoved();
  return { allowed, ...auditRunInventory(baseInv, headInv, allowed) };
}

// Print the Inventory section from a prior audit; return the count of UNACKNOWLEDGED
// removals (which block). No-op/0 when there was nothing with inventory to audit.
function printInventoryAudit(audit) {
  if (!audit) return 0;
  const { delta, unexplained, staleAllowances, allowed } = audit;
  if (!delta.added.length && !delta.removed.length && !staleAllowances.length) {
    console.log('\n📐 Inventory: navigable set unchanged across captured surfaces');
    return 0;
  }
  console.log('\n📐 Inventory (navigable affordances — route links, tabs, menu items, nav buttons):');
  for (const it of delta.removed) {
    const why = allowed[it.key];
    console.log(
      why
        ? `  removed: ${it.key} ("${it.label}") — acknowledged: ${why}`
        : `  ✗ REMOVED, unacknowledged: ${it.key} ("${it.label}")`,
    );
  }
  for (const it of delta.added) console.log(`  + added: ${it.key} ("${it.label}")`);
  for (const k of staleAllowances)
    console.log(`  ✗ stale allowRemoved (key is not actually removed): ${k} — prune it from styleproof.inventory.json`);
  if (unexplained.length)
    console.log(
      `  → ${unexplained.length} unacknowledged removal(s): restore the affordance, or record the decision in styleproof.inventory.json {"<key>":"<why>"}.`,
    );
  // A stale allowance BLOCKS like a stale residue acknowledgement: left in place it
  // pre-acknowledges the NEXT removal of that key, so the ledger must not rot.
  return unexplained.length + staleAllowances.length;
}

// ── data-residue guard (gate by default) ─────────────────────────────────────────
// A data-boundary request (matching `replayUrl`) that FAILED during capture means the
// captured state embedded that endpoint's fallback branch — its response-driven states
// are unproven (issue #205). Residue is recorded + warned at capture time; here the diff
// SURFACES it, and — unless the head bundle opted down to `dataResidue: 'warn'` — an
// unacknowledged failing endpoint BLOCKS (exit 1). Acknowledge intentional ones in
// styleproof.data-residue.json. (Bundles captured before this field existed read as warn.)

// `key -> reason` acknowledged failing endpoints. Malformed JSON fails loud (exit 2),
// like the inventory ack file, so a broken file can't silently un-acknowledge a failure.
function loadAcknowledgedResidue() {
  try {
    return readResidueAckFile();
  } catch (e) {
    console.error(`${COMMAND}: ${e.message}`);
    process.exit(2);
  }
}

// Audit the HEAD bundle's residue against the ack ledger, carrying whether the head
// ledger armed the gate. Returns null when no captured map carried residue AND the
// gate wasn't armed — so a clean healthy run prints/gates nothing (byte-identical).
function readResidueAudit(dirB, armed, hasLedger) {
  const headResidue = readResidue(dirB);
  if (!armed && !headResidue.some((m) => m.dataResidue?.length)) return null;
  const acknowledged = loadAcknowledgedResidue();
  return { acknowledged, hasLedger, ...auditRunResidue(headResidue, acknowledged, armed) };
}

// Print the Data-residue section; return the count of UNACKNOWLEDGED failing endpoints
// that BLOCK (only when the gate is armed). No-op/0 when there was nothing to audit.
/** One line per residue entry: acknowledged entries show their reason; the rest are
 *  marked ✗ (armed — will block) or ⚠ (warn mode). */
function residueLine(r, ackReason, armed) {
  if (ackReason !== undefined) return `  ${r.surface} · ${r.endpoint} (${r.reason}) — acknowledged: ${ackReason}`;
  return `  ${armed ? '✗ ' : '⚠ '}${r.surface} · ${r.endpoint} (${r.reason})${armed ? ', unacknowledged' : ''}`;
}

/** The action footer: the gate (default) names the remedy; warn mode is the opt-out.
 *  A bundle with NO ledger at all is named as such — not misattributed to the opt-out. */
function residueFooter(armed, unacknowledgedCount, hasLedger) {
  if (!unacknowledgedCount) return null;
  if (armed)
    return `  → ${unacknowledgedCount} unacknowledged failing endpoint(s): fixture each (page.route / liveStates), acknowledge intentional ones in styleproof.data-residue.json {"<key>":"<why>"}, or opt down with \`dataResidue: "warn"\` in the capture spec.`;
  if (!hasLedger)
    return '  → recorded and warned — the head bundle carries no coverage ledger (ad-hoc or pre-3.10 capture), so the residue gate cannot arm. A spec-driven capture records the ledger and gates by default.';
  return '  → recorded and warned (dataResidue: "warn" — the opt-out). Remove it to restore the default gate that BLOCKS on these.';
}

function printResidueAudit(audit) {
  if (!audit) return 0;
  const { residue, unacknowledged, staleAcknowledgements, armed, hasLedger } = audit;
  if (!residue.length && !staleAcknowledgements.length) {
    console.log('\n🩹 Data residue: no failing data-boundary request during capture');
    return 0;
  }
  console.log('\n🩹 Data residue (data-boundary requests that FAILED during capture — fallback branch captured):');
  for (const r of residue) console.log(residueLine(r, audit.acknowledged[r.key], armed));
  for (const k of staleAcknowledgements)
    console.log(`  ⚠ stale acknowledgement (endpoint no longer failing/present): ${k}`);
  const footer = residueFooter(armed, unacknowledged.length, hasLedger);
  if (footer) console.log(footer);
  // Only an ARMED gate blocks; warn-mode surfaces without gating. A stale acknowledgement
  // always blocks when armed, so the ledger can't rot (mirrors the `exclude` guard).
  return armed ? unacknowledged.length + staleAcknowledgements.length : 0;
}

// ── coverage provenance (the completeness basis of a green) ──────────────────────
// The head bundle carries a coverage ledger (the declared registry). The gate audits
// the ACTUALLY-captured surfaces against it, so "clean" states its basis — complete vs
// the registry, or explicitly "not asserted" — instead of silently implying completeness.

// Surface keys captured in a dir (file `<key>@<width>.json[.gz]` → `<key>`, deduped).
function capturedSurfaceKeys(dir) {
  return [
    ...new Set(
      fs
        .readdirSync(dir)
        .filter(isMapFile)
        .map((f) => f.replace(/@\d+\.json(\.gz)?$/, '')),
    ),
  ];
}

function readLedger(dir) {
  const p = path.join(dir, COVERAGE_LEDGER);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    // A ledger that EXISTS but cannot be parsed is tampering or truncation, and
    // reading it as "no registry" would silently disarm the coverage,
    // determinism, AND residue gates at once. Fail loud instead.
    console.error(
      `${COMMAND}: corrupt coverage ledger: ${p} — recapture the bundle; refusing to compare with disarmed gates.`,
    );
    process.exit(2);
  }
}

// Print the completeness verdict; return true if it BLOCKS (a registered surface is missing).
function printCoverageVerdict(v) {
  if (v.basis === 'complete') {
    console.log(`\n✓ coverage complete — all ${v.registrySize} registered surface(s) captured or explicitly excluded`);
    for (const k of v.staleExclusions ?? [])
      console.log(`  ⚠ stale exclude (not in the registry): ${k} — prune it from the spec`);
    return false;
  }
  if (v.basis === 'unasserted') {
    console.log(
      '\n⚠ completeness NOT asserted — the spec declared no `expected` registry, so this certifies only the\n' +
        '  surfaces that were captured, not that they are all of them. Declare `expected` to certify completeness.',
    );
    return false;
  }
  console.log(
    `\n✗ coverage INCOMPLETE — ${v.uncovered.length} registered surface(s) not captured (of ${v.registrySize}):`,
  );
  for (const k of v.uncovered) console.log(`  ✗ missing: ${k}`);
  console.log(
    "  → capture each (or move it to `exclude` with a reason). A green can't certify what was never captured.",
  );
  return true;
}

// Print the determinism verdict; return true if it BLOCKS (a side's capture was unproven).
function printDeterminismVerdict(v) {
  if (v.status === 'proven') {
    console.log(`\n✓ determinism proven — base ${v.base}, head ${v.head}`);
    return false;
  }
  if (v.status === 'unknown') {
    // No ledger at all = an ad-hoc `styleproof-capture` output (which doesn't
    // self-check) or a pre-3.10 bundle; a spec capture records the basis.
    console.log(
      '\n⚠ determinism basis unknown — a side carries no determinism ledger (an ad-hoc styleproof-capture\n' +
        '  output, or a capture from before the ledger existed). A spec-driven capture (styleproof-map)\n' +
        '  self-checks and records it; ad-hoc captures are compared as-is.',
    );
    return false;
  }
  console.log(
    `\n✗ determinism NOT proven — base ${v.base}, head ${v.head}. An unproven capture can drift, so a clean\n` +
      '  diff might be two matching NONDETERMINISTIC reads. Enable selfCheck (default) or replay a recorded HAR.',
  );
  return true;
}

const HELP = `${COMMAND} — certify a CSS refactor by diffing two computed-style map captures

usage: ${COMMAND} [baseRef] [options]
       ${COMMAND} <beforeDir> <afterDir> [options]

options:
  --spec <path>     StyleProof spec used to select compatible cached maps
                   (default: e2e/styleproof.spec.ts)
  --cache-branch <b>
                   map store branch for default cached-map mode
                   (default: ${DEFAULT_MAP_STORE_BRANCH})
  --remote <name>   git remote for the map store (default: ${DEFAULT_REMOTE})
  --max <n>        max lines printed per surface before truncating (default: 40)
  --json <file>    also write the full structured diff to <file>
  -h, --help       show this help

exit: 0 identical (certified), 1 differences found, 2 usage/capture error,
      3 only NEW surfaces (present only on the head side, no baseline to diff
      against); a REMOVED surface (present only on the base side) exits 1
`;

const argv = process.argv.slice(2);
const args = [];
let MAX = 40;
let jsonOut = null;
let spec = 'e2e/styleproof.spec.ts';
let cacheBranch = process.env.STYLEPROOF_CACHE_BRANCH ?? DEFAULT_MAP_STORE_BRANCH;
let remote = process.env.STYLEPROOF_REMOTE ?? DEFAULT_REMOTE;
for (let i = 0; i < argv.length; i++) {
  if (isHelpArg(argv[i])) showHelpAndExit(HELP);
  else if (argv[i] === '--max') MAX = Number(argv[++i]);
  else if (argv[i].startsWith('--max=')) MAX = Number(argv[i].slice(6));
  else if (argv[i] === '--json') jsonOut = argv[++i];
  else if (argv[i].startsWith('--json=')) jsonOut = argv[i].slice(7);
  else if (argv[i] === '--spec') spec = argv[++i];
  else if (argv[i].startsWith('--spec=')) spec = argv[i].slice(7);
  else if (argv[i] === '--cache-branch') cacheBranch = argv[++i];
  else if (argv[i].startsWith('--cache-branch=')) cacheBranch = argv[i].slice(15);
  else if (argv[i] === '--remote') remote = argv[++i];
  else if (argv[i].startsWith('--remote=')) remote = argv[i].slice(9);
  else if (argv[i].startsWith('--')) {
    console.error(unknownFlagMessage(COMMAND, argv[i]));
    process.exit(2);
  } else args.push(argv[i]);
}

let dirA;
let dirB;
let cacheCapture = null;
if (args.length <= 1) {
  if (!Number.isFinite(MAX)) {
    console.error(`usage: ${COMMAND} [baseRef] [--max N] [--json <file>]`);
    process.exit(2);
  }
  try {
    cacheCapture = resolveCachedCaptureDirs({
      command: COMMAND,
      args,
      spec,
      branch: cacheBranch,
      remote,
      baseUrl: process.env.BASE_URL,
      usage: `usage: ${COMMAND} [baseRef] [--max N] [--json <file>]`,
    });
    dirA = cacheCapture.beforeDir;
    dirB = cacheCapture.afterDir;
  } catch (e) {
    console.error(cachedMapsUnavailableMessage(COMMAND, 'comparison', e));
    process.exit(2);
  }
} else {
  if (args.length !== 2 || !Number.isFinite(MAX)) {
    console.error(`usage: ${COMMAND} <beforeDir> <afterDir> [--max N] [--json <file>]  (--help for all options)`);
    process.exit(2);
  }
  [dirA, dirB] = args;
  for (const d of [dirA, dirB]) {
    if (!fs.existsSync(d)) {
      console.error(missingManualCaptureMessage(COMMAND, d));
      process.exit(2);
    }
  }
}

let result;
let inventoryAudit = null;
let coverageVerdict = null;
let determinismVerdict = null;
let residueAudit = null;
let surfacePaths = new Map();
let surfaceKeyOf = () => undefined;
try {
  // v4: a side without a manifest is unsupported — the same-environment guard can't be
  // enforced, so refuse (exit 2 via the catch below) rather than compare on false footing.
  const manifestless = manifestlessSide(dirA, dirB);
  if (manifestless) throw new Error(manifestlessError(manifestless));
  assertCompatibleMapDirs(dirA, dirB);
  result = diffStyleMapDirs(dirA, dirB);
  // Read inventory + the certification ledgers here, while the (possibly cached/restored)
  // dirs still exist — the finally below deletes them in cached-map mode. Coverage is the
  // HEAD bundle's completeness basis; determinism needs both sides.
  inventoryAudit = readInventoryAudit(dirA, dirB);
  const headLedger = readLedger(dirB);
  coverageVerdict = auditCoverage(capturedSurfaceKeys(dirB), headLedger);
  determinismVerdict = auditDeterminism(readLedger(dirA), headLedger);
  // Data-residue: the head bundle's failing data endpoints, gated only if its ledger
  // armed `dataResidue: 'gate'`. Same "read while the dirs exist" rule as the ledgers.
  residueAudit = readResidueAudit(dirB, headLedger?.dataResidue === 'gate', headLedger != null);
  // Element-path sets per surface, for the shared-chrome tier — same "read while
  // the dirs exist" rule as the ledgers above.
  surfacePaths = surfaceElementPaths(dirA, dirB);
  // dirA = before/base, dirB = after/head — same order as generateStyleMapReport.
  surfaceKeyOf = mergeSurfaceKeyLookup(dirA, dirB);
} catch (e) {
  console.error(e.message);
  process.exit(2);
} finally {
  cleanupCachedCaptureDirs(cacheCapture);
}
const { surfaces, counts, compared, volatile, statesUncertified } = result;
const baselineSurfaceFailures = readMapManifest(dirA)?.surfaceCaptureFailures ?? [];
const explainedMissingBaselineSurfaceKeys = explainedMissingBaselineSurfaces(surfaces, baselineSurfaceFailures);
const partialBaseline = explainedMissingBaselineSurfaceKeys.length > 0;

function printBaselineSurfaceFailureCallout() {
  if (!baselineSurfaceFailures.length) return;
  console.log(
    `\n⚠ ${baselineSurfaceFailures.length} surface(s) failed during the BASELINE capture and were omitted from the base bundle — repair base capture on the base branch; do not treat these as greenfield new surfaces:`,
  );
  for (const f of baselineSurfaceFailures) console.log(`  ✗ ${f.key}: ${f.reason.split('\n')[0]}`);
  console.log('  → Re-run styleproof-map on the base commit (or merge a fix) before approving indefinitely.');
}

printBaselineSurfaceFailureCallout();

// ── grouped human output ─────────────────────────────────────────────────────
// Reuse the report's dedup so one real change doesn't print once per surface with
// its derived-longhand echo: group surfaces that changed identically, fold the
// size/position-derived longhands behind a count, and keep the per-surface tally
// in each group's header line. --json below is untouched (the raw machine feed).

// One finding's lines: a heading, then its summarised property deltas (the same
// dedupe the report shows). Returns [] for a DOM finding (handled separately) or a
// finding whose props all summarised away.
function findingLines(f) {
  if (f.kind === 'dom') return [];
  const rows = summarizeProps(f.props);
  if (!rows.length) return [];
  const head =
    f.kind === 'state'
      ? `  [:${f.state}] ${findingLabel(f.path, f.cls)}${f.sub !== f.path ? ` ⇒ ${f.sub}` : ''}`
      : `  ${findingLabel(f.path, f.cls)}${f.pseudo || ''}`;
  return [head, ...rows.map((p) => `    ${p.prop}: ${p.before} → ${p.after}`)];
}

// A DOM finding's one-line heading (added/removed/retagged).
function domLine(dom) {
  return dom.change === 'retagged'
    ? `  DOM retagged: ${dom.path} ${dom.detail ?? ''}`
    : `  DOM ${dom.change}: ${findingLabel(dom.path, dom.cls)}`;
}

// The element lines for one change group, from its representative's cleaned
// findings: one heading per element, then its summarised property deltas.
function elementLines(findings) {
  const lines = [];
  for (const group of groupByPath(findings)) {
    const dom = group.find((f) => f.kind === 'dom');
    if (dom) lines.push(domLine(dom));
    for (const f of group) lines.push(...findingLines(f));
  }
  return lines;
}

// One-sided surfaces keep their own line. The two directions are NOT the same
// verdict: only-in-after is a NEW surface (no baseline, review before
// baselining); only-in-before is a REMOVED surface — a route or width that
// existed and is gone, which is a change, never an onboarding case.
for (const sd of surfaces) {
  if (!sd.missing) continue;
  console.log(
    sd.missing === 'before'
      ? `\n${sd.surface}: new surface — captured only in the after set, no baseline to compare`
      : `\n${sd.surface}: ✗ REMOVED surface — captured only in the before set; the head no longer renders it`,
  );
}

// Group the changed surfaces the way the report does, so an identical change
// across N surfaces prints once (with the count), not N times.
const preparedForGrouping = surfaces
  .filter((sd) => !sd.missing)
  // Carry the RAW findings too, so we can report how many derived longhands the
  // grouped view folded (the cleaned findings have them already removed).
  .map((sd) => ({ surface: sd.surface, findings: cleanFindings(sd.findings), raw: sd.findings }))
  .filter((p) => p.findings.length > 0);

function printGroup(cg) {
  const lines = elementLines(cg.findings);
  const derived = derivedLonghandCount(cg.rep.raw);
  const foldNote = derived > 0 ? ` (+${derived} derived longhand${derived === 1 ? '' : 's'})` : '';
  const others = cg.surfaces.length - 1;
  const scope =
    others > 0
      ? `${cg.rep.surface} (+${others} more surface${others === 1 ? '' : 's'}: ${formatSurfaceList(cg.surfaces)})`
      : cg.rep.surface;
  console.log(`\n${scope}: ${groupTitle(cg.findings)}${foldNote}`);
  for (const line of lines.slice(0, MAX)) console.log(line);
  if (lines.length > MAX) console.log(`  ... and ${lines.length - MAX} more lines (re-run with --max ${lines.length})`);
}

// Shared-chrome tier: a change that rode the frame every view draws (nav/header)
// gets one banner up top, then its detail — so the reviewer reads "the nav changed
// everywhere" once, not once per surface entry. Presentational only.
const grouped = groupBySignature(preparedForGrouping);
const { chrome, rest } = classifyChrome(grouped, surfacePaths, surfaceKeyOf);
if (chrome.length) {
  // Base count from the pre-cleanup surface set (dirB may be deleted by now).
  const bases = countCapturedSurfaceBases([...surfacePaths.keys()], surfaceKeyOf);
  console.log(
    `\n🧱 Global chrome change(s) — across all ${bases} captured surface base(s): ${chrome.length} change(s) rode the shared frame every view draws (a persistent nav, header, or footer).`,
  );
  for (const cg of chrome) printGroup(cg);
}
for (const cg of rest) printGroup(cg);

const invRemovals = printInventoryAudit(inventoryAudit);
const residueFails = printResidueAudit(residueAudit);
const coverageFails = printCoverageVerdict(coverageVerdict);
const determinismFails = printDeterminismVerdict(determinismVerdict);

if (jsonOut) {
  // A write failure (bad --json path, unwritable dir) is a usage/setup error, not a
  // "reviewable differences" result — exit 2, never leak the exit-1 that CI reads as
  // a real diff.
  try {
    fs.writeFileSync(
      jsonOut,
      JSON.stringify(
        {
          counts,
          surfaces,
          compared,
          baselineSurfaceFailures,
          explainedMissingBaselineSurfaces: explainedMissingBaselineSurfaceKeys,
          partialBaseline,
          // Subtrees excluded from every layer of the comparison because a side
          // auto-detected them as volatile (still mutating at capture settle).
          // Changes inside them are NOT certified by this diff.
          volatileExcluded: volatile,
          // Surfaces whose forced-state layer was skipped on BOTH sides — the
          // :hover/:focus/:active layer compared {} vs {} and certifies nothing.
          statesUncertified,
          coverage: coverageVerdict,
          determinism: determinismVerdict,
          // The inventory verdict, machine-readable — parallel to coverage/determinism and
          // to the report's certification block. `null` when no capture carried inventory.
          // `unacknowledged` is the gating set: a CI can hard-fail on `unacknowledged.length`.
          inventory: inventoryAudit && {
            removed: inventoryAudit.delta.removed.map((i) => i.key),
            added: inventoryAudit.delta.added.map((i) => i.key),
            unacknowledged: inventoryAudit.unexplained.map((i) => i.key),
            staleAcknowledgements: inventoryAudit.staleAllowances,
          },
          // Explain the `inventory: null` so a gate reading this JSON can tell "armed but no
          // data" apart from "audited, nothing removed". Neither map carried inventory → set
          // `inventory: true` in the capture spec (styleproof-init scaffolds it).
          ...(inventoryAudit
            ? {}
            : {
                inventoryNote:
                  'no captured map carried an inventory — set `inventory: true` in the capture spec to arm the navigable-removal gate',
              }),
          // Additive data-residue field — the head bundle's failing data endpoints, parallel
          // to inventory. `null` when nothing failed and the gate wasn't armed. `armed` says
          // whether `unacknowledged` blocks; `blocking` is the CI-gating count.
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
  } catch (e) {
    console.error(`${COMMAND}: could not write --json ${jsonOut}: ${e.message}`);
    process.exit(2);
  }
}

const total = counts.dom + counts.style + counts.state;
const newSurfaces = surfaces.filter((s) => s.missing === 'before').length;
const removedSurfaces = surfaces.filter((s) => s.missing === 'after').length;
const greenfieldNewSurfaces = surfaces.filter(
  (s) => s.missing === 'before' && !surfaceMissingMatchesBaselineFailure(s.surface, baselineSurfaceFailures),
).length;
// One SurfaceDiff per distinct surface across both sides (incl. missing-on-one-side).
const surfaceCount = surfaces.length;
if (volatile > 0)
  console.log(
    `\n⚠ ${volatile} auto-detected volatile subtree(s) excluded from the comparison (still mutating at capture\n` +
      '  settle) — changes inside them are NOT certified. Fixture the region, or `ignore` it deliberately.',
  );
if (statesUncertified > 0)
  console.log(
    `\n⚠ forced-state layer uncertified on ${statesUncertified} surface(s): BOTH captures skipped it, so\n` +
      '  :hover/:focus/:active differences there were never compared.',
  );
const newNote = greenfieldNewSurfaces > 0 ? ` (+${greenfieldNewSurfaces} new surface(s) with no baseline)` : '';
const removedNote = removedSurfaces ? ` + ${removedSurfaces} REMOVED surface(s)` : '';
const invNote = invRemovals ? ` + ${invRemovals} inventory gate failure(s) (unacknowledged or stale)` : '';
// residueFails counts unacknowledged failing endpoints AND stale acknowledgements (both gate).
const resNote = residueFails ? ` + ${residueFails} data-residue gate failure(s) (unacknowledged or stale)` : '';
const covNote = coverageFails ? ` + ${coverageVerdict.uncovered.length} uncaptured registered surface(s)` : '';
const detNote = determinismFails ? ' + determinism unproven' : '';
const clean =
  total === 0 &&
  removedSurfaces === 0 &&
  invRemovals === 0 &&
  residueFails === 0 &&
  !coverageFails &&
  !determinismFails;
console.log(
  clean
    ? newSurfaces === 0
      ? `\n✓ 0 changed surfaces across ${compared} captured surface(s): every computed style, pseudo-element, and hover/focus/active state matches`
      : baselineSurfaceFailures.length && greenfieldNewSurfaces === 0
        ? `\nℹ ${newSurfaces} surface(s) on head have no base map because baseline capture failed — repair the base branch (see callout above)`
        : `\nℹ ${greenfieldNewSurfaces} new surface(s) captured with no baseline to compare — review before baselining`
    : `\n✗ ${counts.dom} DOM change(s), ${counts.style} computed-style difference(s), ${counts.state} state-delta difference(s) across ${surfaceCount} surfaces${newNote}${removedNote}${invNote}${resNote}${covNote}${detNote}`,
);
// 0 = identical, 1 = reviewable differences (incl. a REMOVED surface, inventory/residue gate
// failures — unacknowledged or stale — an incomplete coverage registry, or an
// unproven-determinism capture), 3 = ONLY new surfaces (no baseline). 2 = usage.
process.exit(
  total > 0 || removedSurfaces > 0 || invRemovals > 0 || residueFails > 0 || coverageFails || determinismFails
    ? 1
    : greenfieldNewSurfaces > 0
      ? 3
      : 0,
);
