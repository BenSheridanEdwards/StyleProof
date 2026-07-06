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
 * error, 3 = only new surfaces (present on one side, no baseline to diff against).
 */
import fs from 'node:fs';
import path from 'node:path';
import { diffStyleMapDirs, findingLabel } from '../dist/diff.js';
import {
  DEFAULT_MAP_STORE_BRANCH,
  DEFAULT_REMOTE,
  assertCompatibleMapDirs,
  cleanupCachedCaptureDirs,
  resolveCachedCaptureDirs,
} from '../dist/map-store.js';
import {
  cachedMapsUnavailableMessage,
  isHelpArg,
  missingManualCaptureMessage,
  showHelpAndExit,
  unknownFlagMessage,
} from '../dist/cli-errors.js';
import { readInventories } from '../dist/capture.js';
import { auditRunInventory, readAckFile } from '../dist/inventory.js';
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
  for (const k of staleAllowances) console.log(`  ⚠ stale allowRemoved (key is not actually removed): ${k}`);
  if (unexplained.length)
    console.log(
      `  → ${unexplained.length} unacknowledged removal(s): restore the affordance, or record the decision in styleproof.inventory.json {"<key>":"<why>"}.`,
    );
  return unexplained.length;
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
    return null; // a corrupt ledger reads as no registry → "not asserted", never a false green
  }
}

// Print the completeness verdict; return true if it BLOCKS (a registered surface is missing).
function printCoverageVerdict(v) {
  if (v.basis === 'complete') {
    console.log(`\n✓ coverage complete — all ${v.registrySize} registered surface(s) captured`);
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
    console.log('\n⚠ determinism basis unknown — a capture predates the determinism ledger; recapture to certify it.');
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
      3 only new surfaces (present on one side, no baseline to diff against).
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
try {
  assertCompatibleMapDirs(dirA, dirB);
  result = diffStyleMapDirs(dirA, dirB);
  // Read inventory + the certification ledgers here, while the (possibly cached/restored)
  // dirs still exist — the finally below deletes them in cached-map mode. Coverage is the
  // HEAD bundle's completeness basis; determinism needs both sides.
  inventoryAudit = readInventoryAudit(dirA, dirB);
  const headLedger = readLedger(dirB);
  coverageVerdict = auditCoverage(capturedSurfaceKeys(dirB), headLedger);
  determinismVerdict = auditDeterminism(readLedger(dirA), headLedger);
} catch (e) {
  console.error(e.message);
  process.exit(2);
} finally {
  cleanupCachedCaptureDirs(cacheCapture);
}
const { surfaces, counts, compared } = result;

for (const sd of surfaces) {
  if (sd.missing) {
    const side = sd.missing === 'before' ? 'after' : 'before';
    console.log(`\n${sd.surface}: new surface — captured only in the ${side} set, no baseline to compare`);
    continue;
  }
  const lines = [];
  for (const f of sd.findings) {
    if (f.kind === 'dom') {
      lines.push(
        f.change === 'retagged'
          ? `  DOM retagged: ${f.path} ${f.detail}`
          : `  DOM ${f.change}: ${findingLabel(f.path, f.cls)}`,
      );
    } else if (f.kind === 'style') {
      lines.push(`  ${findingLabel(f.path, f.cls)}${f.pseudo || ''}`);
      for (const p of f.props) lines.push(`    ${p.prop}: ${p.before} → ${p.after}`);
    } else {
      lines.push(`  [:${f.state}] ${findingLabel(f.path, f.cls)}${f.sub !== f.path ? ` ⇒ ${f.sub}` : ''}`);
      for (const p of f.props) lines.push(`    ${p.prop}: ${p.before} → ${p.after}`);
    }
  }
  console.log(`\n${sd.surface}: ${lines.filter((l) => !l.startsWith('    ')).length} element(s) differ`);
  for (const line of lines.slice(0, MAX)) console.log(line);
  if (lines.length > MAX) console.log(`  ... and ${lines.length - MAX} more lines (re-run with --max ${lines.length})`);
}

const invRemovals = printInventoryAudit(inventoryAudit);
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
const newSurfaces = surfaces.filter((s) => s.missing).length;
// One SurfaceDiff per distinct surface across both sides (incl. missing-on-one-side).
const surfaceCount = surfaces.length;
const newNote = newSurfaces ? ` (+${newSurfaces} new surface(s) with no baseline)` : '';
const invNote = invRemovals ? ` + ${invRemovals} unacknowledged inventory removal(s)` : '';
const covNote = coverageFails ? ` + ${coverageVerdict.uncovered.length} uncaptured registered surface(s)` : '';
const detNote = determinismFails ? ' + determinism unproven' : '';
const clean = total === 0 && invRemovals === 0 && !coverageFails && !determinismFails;
console.log(
  clean
    ? newSurfaces === 0
      ? `\n✓ 0 changed surfaces across ${compared} captured surface(s): every computed style, pseudo-element, and hover/focus/active state matches`
      : `\nℹ ${newSurfaces} new surface(s) captured with no baseline to compare — review before baselining`
    : `\n✗ ${counts.dom} DOM change(s), ${counts.style} computed-style difference(s), ${counts.state} state-delta difference(s) across ${surfaceCount} surfaces${newNote}${invNote}${covNote}${detNote}`,
);
// 0 = identical, 1 = reviewable differences (incl. unacknowledged inventory removals, an
// incomplete coverage registry, or an unproven-determinism capture), 3 = only new surfaces
// (no baseline). 2 = usage/capture error.
process.exit(total > 0 || invRemovals > 0 || coverageFails || determinismFails ? 1 : newSurfaces > 0 ? 3 : 0);
