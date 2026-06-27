#!/usr/bin/env node
/**
 * Visual diff report: side-by-side before/after crops of every changed
 * region, plus the exact property changes, as markdown ready for a PR
 * comment.
 *
 *   styleproof-report <beforeDir> <afterDir> --out <dir> [options]
 *
 * Both capture dirs need the .json.gz maps; side-by-side images additionally
 * need the .png screenshots that `defineStyleMapCapture` saves by default.
 * Exit code 0 = no changes, 1 = report generated, 2 = usage error.
 */
import { generateStyleMapReport } from '../dist/report.js';
import { cleanupBaseRefCaptureDirs, resolveBaseRefCaptureDirs } from '../dist/cli-base-ref.js';
import { cliErrorMessage, isHelpArg, showHelpAndExit, unknownFlagMessage } from '../dist/cli-errors.js';

const COMMAND = 'styleproof-report';
const DEFAULT_MAPS_DIR = 'stylemaps/current';

const HELP = `${COMMAND} — reviewable before/after report from two captures

usage: ${COMMAND} [baseRef] [options]
       ${COMMAND} --base-ref <gitref> [mapsDir] [options]
       ${COMMAND} <beforeDir> <afterDir> [options]

options:
  --base-ref <ref>          report <mapsDir> as committed at <ref> (e.g. main)
                            against your working <mapsDir> — base from git, no recapture
  --maps-dir <dir>          committed map dir for the base-ref flow
                            (default: ${DEFAULT_MAPS_DIR})
  --out <dir>               output directory (default: styleproof-report)
  --image-base-url <url>    prefix for image URLs in report.md (default: relative)
  --pad <px>                padding around changed rects when cropping (default: 24)
  --max-crops <n>           max crop regions per surface before collapsing (default: 6)
  --fold-details-at <n>     row count at which a crop's property tables fold under a
                            <details> toggle (default: 0 = always; 'Infinity' = never)
  --min-width <px>          minimum crop width, for context (default: 320)
  --min-height <px>         minimum crop height, for context (default: 180)
  --include-layout-noise    keep size/position-derived longhands (height, width,
                            transform-origin, top…) that a reflow changes up the
                            whole ancestor chain (off by default)
  --include-content         render the opt-in content layer: an advisory section
                            of elements whose text changed, each with a
                            before/after crop. Needs captures taken with
                            captureText:true; never affects the check (off by default)
  -h, --help                show this help

exit: 0 no changes, 1 report generated, 2 usage error.
`;

const argv = process.argv.slice(2);
const args = [];
const flags = { out: 'styleproof-report', imageBaseUrl: '' };
let pad;
let maxCrops;
let foldDetailsAt;
let minWidth;
let minHeight;
let includeLayoutNoise = false;
let includeContent = false;
let baseRef = null;
let mapsDir = DEFAULT_MAPS_DIR;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (isHelpArg(a)) showHelpAndExit(HELP);
  else if (a === '--out') flags.out = argv[++i];
  else if (a.startsWith('--out=')) flags.out = a.slice(6);
  else if (a === '--image-base-url') flags.imageBaseUrl = argv[++i];
  else if (a.startsWith('--image-base-url=')) flags.imageBaseUrl = a.slice(17);
  else if (a === '--pad') pad = Number(argv[++i]);
  else if (a.startsWith('--pad=')) pad = Number(a.slice(6));
  else if (a === '--max-crops') maxCrops = Number(argv[++i]);
  else if (a.startsWith('--max-crops=')) maxCrops = Number(a.slice(12));
  else if (a === '--fold-details-at') foldDetailsAt = Number(argv[++i]);
  else if (a.startsWith('--fold-details-at=')) foldDetailsAt = Number(a.slice(18));
  else if (a === '--min-width') minWidth = Number(argv[++i]);
  else if (a.startsWith('--min-width=')) minWidth = Number(a.slice(12));
  else if (a === '--min-height') minHeight = Number(argv[++i]);
  else if (a.startsWith('--min-height=')) minHeight = Number(a.slice(13));
  else if (a === '--include-layout-noise') includeLayoutNoise = true;
  else if (a.startsWith('--include-layout-noise=')) includeLayoutNoise = a.slice(23) !== 'false';
  else if (a === '--include-content') includeContent = true;
  else if (a.startsWith('--include-content=')) includeContent = a.slice(18) !== 'false';
  else if (a === '--base-ref') baseRef = argv[++i];
  else if (a.startsWith('--base-ref=')) baseRef = a.slice(11);
  else if (a === '--maps-dir') mapsDir = argv[++i];
  else if (a.startsWith('--maps-dir=')) mapsDir = a.slice(11);
  else if (a.startsWith('--')) {
    console.error(unknownFlagMessage(COMMAND, a));
    process.exit(2);
  } else args.push(a);
}
let beforeDir;
let afterDir;
let baseCapture = null;
if (baseRef || args.length <= 1) {
  try {
    baseCapture = resolveBaseRefCaptureDirs({
      command: COMMAND,
      baseRef,
      mapsDir,
      args,
      usage: 'usage: styleproof-report --base-ref <gitref> [mapsDir] [--out <dir>] [options]',
    });
  } catch (e) {
    console.error(cliErrorMessage(e));
    process.exit(2);
  }
  beforeDir = baseCapture.beforeDir;
  afterDir = baseCapture.afterDir;
} else {
  if (args.length !== 2) {
    console.error('usage: styleproof-report <beforeDir> <afterDir> --out <dir> [options]  (--help for all options)');
    process.exit(2);
  }
  beforeDir = args[0];
  afterDir = args[1];
}
for (const [name, val] of [
  ['--pad', pad],
  ['--max-crops', maxCrops],
  ['--min-width', minWidth],
  ['--min-height', minHeight],
]) {
  if (val !== undefined && !Number.isFinite(val)) {
    console.error(`${name} must be a number`);
    process.exit(2);
  }
}
// foldDetailsAt allows Infinity ("never fold"), so it gets a NaN-only check.
if (foldDetailsAt !== undefined && Number.isNaN(foldDetailsAt)) {
  console.error('--fold-details-at must be a number (or Infinity)');
  process.exit(2);
}

let result;
try {
  result = generateStyleMapReport({
    beforeDir,
    afterDir,
    outDir: flags.out,
    imageBaseUrl: flags.imageBaseUrl || undefined,
    pad,
    maxCrops,
    foldDetailsAt,
    minWidth,
    minHeight,
    includeLayoutNoise,
    includeContent,
  });
} catch (e) {
  console.error(e.message);
  process.exit(2);
} finally {
  cleanupBaseRefCaptureDirs(baseCapture);
}

const newNote = result.newSurfaces ? ` (+${result.newSurfaces} new surface(s) with no baseline)` : '';
console.log(
  result.changedSurfaces === 0
    ? result.newSurfaces === 0
      ? '✓ no changes — empty report written'
      : `ℹ ${result.newSurfaces} new surface(s) with no baseline — report written for reference`
    : `✗ ${result.changedSurfaces} changed surface(s), ${result.totalFindings} finding(s)${newNote}`,
);
console.log(`report: ${result.reportMdPath}`);
if (includeContent && result.contentChanges > 0) {
  console.log(`📝 ${result.contentChanges} advisory content change(s) — does not affect the exit code`);
}
process.exit(result.changedSurfaces === 0 && result.newSurfaces === 0 ? 0 : 1);
