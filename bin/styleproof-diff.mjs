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
  cliErrorMessage,
  isHelpArg,
  missingManualCaptureMessage,
  showHelpAndExit,
  unknownFlagMessage,
} from '../dist/cli-errors.js';
import { loadStyleMap } from '../dist/capture.js';
import { auditRunInventory } from '../dist/inventory.js';

const COMMAND = path.basename(process.argv[1] ?? 'styleproof-diff').replace(/\.mjs$/, '');

// ── inventory guard (opt-in) ────────────────────────────────────────────────────
// Surfaces the navigable-inventory audit through the CLI. When captures carry
// `inventory` (from captureStyleMap({ inventory: true })), an affordance base
// offered and head no longer does BLOCKS unless acknowledged. Inert when no map
// carries inventory, so every existing capture behaves exactly as before.

// Mirror of indexDir() in diff.ts — the capture-dir file filter, kept local so the
// bin needn't reach into diff internals for one small read.
function dirInventories(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f !== 'styleproof-manifest.json' && /\.json(\.gz)?$/.test(f))
    .map((f) => loadStyleMap(path.join(dir, f)))
    .map((m) => (m.inventory ? { inventory: m.inventory } : {}));
}

// `key -> reason` acknowledged removals. Optional file; absent → none. Malformed
// JSON fails loud (exit 2) rather than silently un-acknowledging a real removal.
function loadAllowRemoved() {
  const p = path.resolve(process.env.STYLEPROOF_INVENTORY ?? 'styleproof.inventory.json');
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`${COMMAND}: ${p} is not valid JSON — ${e.message}`);
    process.exit(2);
  }
}

// Read both sides' inventory and audit removals. MUST run before any cached-map
// cleanup deletes the restored dirs. Returns null when no capture carries inventory.
function readInventoryAudit(dirA, dirB) {
  const baseInv = dirInventories(dirA);
  const headInv = dirInventories(dirB);
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
    console.error(
      [
        `${COMMAND}: cached maps are not available for this comparison`,
        cliErrorMessage(e),
        'Next: run styleproof-map on the base and head commits to upload maps, or let CI recapture both sides.',
      ].join('\n'),
    );
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
try {
  assertCompatibleMapDirs(dirA, dirB);
  result = diffStyleMapDirs(dirA, dirB);
  // Read inventory here, while the (possibly cached/restored) dirs still exist —
  // the finally below deletes them in cached-map mode.
  inventoryAudit = readInventoryAudit(dirA, dirB);
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

if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ counts, surfaces, compared }, null, 2));

const total = counts.dom + counts.style + counts.state;
const newSurfaces = surfaces.filter((s) => s.missing).length;
// One SurfaceDiff per distinct surface across both sides (incl. missing-on-one-side).
const surfaceCount = surfaces.length;
const newNote = newSurfaces ? ` (+${newSurfaces} new surface(s) with no baseline)` : '';
const invNote = invRemovals ? ` + ${invRemovals} unacknowledged inventory removal(s)` : '';
console.log(
  total === 0 && invRemovals === 0
    ? newSurfaces === 0
      ? `\n✓ 0 changed surfaces across ${compared} captured surface(s): every computed style, pseudo-element, and hover/focus/active state matches`
      : `\nℹ ${newSurfaces} new surface(s) captured with no baseline to compare — review before baselining`
    : `\n✗ ${counts.dom} DOM change(s), ${counts.style} computed-style difference(s), ${counts.state} state-delta difference(s) across ${surfaceCount} surfaces${newNote}${invNote}`,
);
// 0 = identical, 1 = reviewable differences (incl. unacknowledged inventory
// removals), 3 = only new surfaces (no baseline). 2 reserved for usage/capture errors.
process.exit(total > 0 || invRemovals > 0 ? 1 : newSurfaces > 0 ? 3 : 0);
