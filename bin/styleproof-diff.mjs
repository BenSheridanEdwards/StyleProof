#!/usr/bin/env node
/**
 * Diff two computed-style map captures (see styleproof).
 *
 *   styleproof-diff [baseRef] [--maps-dir <dir>] [--max N] [--json <file>]
 *   styleproof-diff --base-ref <gitref> [mapsDir] [--max N] [--json <file>]
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
 * --base-ref reads the base from a git ref instead of a second directory: it
 * materialises the captures committed at <mapsDir> as of <gitref> (e.g. `main`)
 * and diffs them against your working <mapsDir>. That's the "base map lives on
 * main, CI just diffs" flow — commit each branch's maps (pre-push), and the gate
 * never recomputes the base. Both sides must be captured in the same environment
 * (browser + fonts) for the diff to be meaningful.
 *
 * Custom properties (--*) are ignored: they are inputs, not outcomes (see
 * README). Exit code 0 = identical, 1 = reviewable differences, 2 = usage/capture
 * error, 3 = only new surfaces (present on one side, no baseline to diff against).
 */
import fs from 'node:fs';
import path from 'node:path';
import { diffStyleMapDirs, findingLabel } from '../dist/diff.js';
import { cleanupBaseRefCaptureDirs, resolveBaseRefCaptureDirs } from '../dist/cli-base-ref.js';
import {
  cliErrorMessage,
  isHelpArg,
  missingManualCaptureMessage,
  showHelpAndExit,
  unknownFlagMessage,
} from '../dist/cli-errors.js';

const COMMAND = path.basename(process.argv[1] ?? 'styleproof-diff').replace(/\.mjs$/, '');
const DEFAULT_MAPS_DIR = 'stylemaps/current';

const HELP = `${COMMAND} — certify a CSS refactor by diffing two computed-style map captures

usage: ${COMMAND} [baseRef] [options]
       ${COMMAND} --base-ref <gitref> [mapsDir] [options]
       ${COMMAND} <beforeDir> <afterDir> [options]

options:
  --base-ref <ref> diff <mapsDir> as committed at <ref> (e.g. main) against your
                   working <mapsDir> — base from git, no recapture
  --maps-dir <dir> committed map dir for the base-ref flow
                   (default: ${DEFAULT_MAPS_DIR})
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
let baseRef = null;
let mapsDir = DEFAULT_MAPS_DIR;
for (let i = 0; i < argv.length; i++) {
  if (isHelpArg(argv[i])) showHelpAndExit(HELP);
  else if (argv[i] === '--max') MAX = Number(argv[++i]);
  else if (argv[i].startsWith('--max=')) MAX = Number(argv[i].slice(6));
  else if (argv[i] === '--json') jsonOut = argv[++i];
  else if (argv[i].startsWith('--json=')) jsonOut = argv[i].slice(7);
  else if (argv[i] === '--base-ref') baseRef = argv[++i];
  else if (argv[i].startsWith('--base-ref=')) baseRef = argv[i].slice(11);
  else if (argv[i] === '--maps-dir') mapsDir = argv[++i];
  else if (argv[i].startsWith('--maps-dir=')) mapsDir = argv[i].slice(11);
  else if (argv[i].startsWith('--')) {
    console.error(unknownFlagMessage(COMMAND, argv[i]));
    process.exit(2);
  } else args.push(argv[i]);
}

let dirA;
let dirB;
let baseCapture = null;
if (baseRef || args.length <= 1) {
  if (!Number.isFinite(MAX)) {
    console.error(`usage: ${COMMAND} [baseRef] [--maps-dir <dir>] [--max N] [--json <file>]`);
    process.exit(2);
  }
  try {
    baseCapture = resolveBaseRefCaptureDirs({
      command: COMMAND,
      baseRef,
      mapsDir,
      args,
      usage: `usage: ${COMMAND} --base-ref <gitref> [mapsDir] [--max N] [--json <file>]`,
    });
  } catch (e) {
    console.error(cliErrorMessage(e));
    process.exit(2);
  }
  dirA = baseCapture.beforeDir;
  dirB = baseCapture.afterDir;
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
try {
  result = diffStyleMapDirs(dirA, dirB);
} catch (e) {
  console.error(e.message);
  process.exit(2);
} finally {
  cleanupBaseRefCaptureDirs(baseCapture);
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

if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ counts, surfaces, compared }, null, 2));

const total = counts.dom + counts.style + counts.state;
const newSurfaces = surfaces.filter((s) => s.missing).length;
// One SurfaceDiff per distinct surface across both sides (incl. missing-on-one-side).
const surfaceCount = surfaces.length;
const newNote = newSurfaces ? ` (+${newSurfaces} new surface(s) with no baseline)` : '';
console.log(
  total === 0
    ? newSurfaces === 0
      ? `\n✓ 0 changed surfaces across ${compared} captured surface(s): every computed style, pseudo-element, and hover/focus/active state matches`
      : `\nℹ ${newSurfaces} new surface(s) captured with no baseline to compare — shown for reference, no reviewable change`
    : `\n✗ ${counts.dom} DOM change(s), ${counts.style} computed-style difference(s), ${counts.state} state-delta difference(s) across ${surfaceCount} surfaces${newNote}`,
);
// 0 = identical, 1 = reviewable differences, 3 = only new surfaces (no baseline,
// nothing to review). 2 stays reserved for usage/capture errors.
process.exit(total > 0 ? 1 : newSurfaces > 0 ? 3 : 0);
