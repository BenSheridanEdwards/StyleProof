#!/usr/bin/env node
/**
 * Visual diff report: side-by-side before/after crops of every changed
 * region, plus the exact property changes, as markdown ready for a PR
 * comment.
 *
 *   styleproof-report [baseRef] --out <dir> [options]   # cached map store
 *   styleproof-report <beforeDir> <afterDir> --out <dir> [options]
 *
 * Both capture dirs need the .json.gz maps; side-by-side images additionally
 * need the .png screenshots that `defineStyleMapCapture` saves by default.
 * Exit code 0 = no changes, 1 = report generated, 2 = usage error.
 */
import { generateStyleMapReport } from '../dist/report.js';
import { cachedMapsUnavailableMessage, isHelpArg, showHelpAndExit, unknownFlagMessage } from '../dist/cli-errors.js';
import {
  DEFAULT_MAP_STORE_BRANCH,
  DEFAULT_REMOTE,
  assertCompatibleMapDirs,
  cleanupCachedCaptureDirs,
  resolveCachedCaptureDirs,
} from '../dist/map-store.js';

const COMMAND = 'styleproof-report';

const HELP = `${COMMAND} — reviewable before/after report from two captures

usage: ${COMMAND} [baseRef] [options]
       ${COMMAND} <beforeDir> <afterDir> [options]

options:
  --spec <path>              StyleProof spec used to select compatible cached maps
                             (default: e2e/styleproof.spec.ts)
  --cache-branch <b>         map store branch for default cached-map mode
                             (default: ${DEFAULT_MAP_STORE_BRANCH})
  --remote <name>            git remote for the map store (default: ${DEFAULT_REMOTE})
  --out <dir>               output directory (default: styleproof-report)
  --image-base-url <url>    prefix for image URLs in report.md (default: relative)
  --pad <px>                padding around changed rects when cropping (default: 12)
  --max-crops <n>           max crop regions per surface before collapsing (default: 8)
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
let spec = 'e2e/styleproof.spec.ts';
let cacheBranch = process.env.STYLEPROOF_CACHE_BRANCH ?? DEFAULT_MAP_STORE_BRANCH;
let remote = process.env.STYLEPROOF_REMOTE ?? DEFAULT_REMOTE;
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
  else if (a === '--spec') spec = argv[++i];
  else if (a.startsWith('--spec=')) spec = a.slice(7);
  else if (a === '--cache-branch') cacheBranch = argv[++i];
  else if (a.startsWith('--cache-branch=')) cacheBranch = a.slice(15);
  else if (a === '--remote') remote = argv[++i];
  else if (a.startsWith('--remote=')) remote = a.slice(9);
  else if (a.startsWith('--')) {
    console.error(unknownFlagMessage(COMMAND, a));
    process.exit(2);
  } else args.push(a);
}
let beforeDir;
let afterDir;
let cacheCapture = null;
if (args.length <= 1) {
  try {
    cacheCapture = resolveCachedCaptureDirs({
      command: COMMAND,
      args,
      spec,
      branch: cacheBranch,
      remote,
      baseUrl: process.env.BASE_URL,
      usage: 'usage: styleproof-report [baseRef] [--out <dir>] [options]',
    });
    beforeDir = cacheCapture.beforeDir;
    afterDir = cacheCapture.afterDir;
  } catch (e) {
    console.error(cachedMapsUnavailableMessage(COMMAND, 'report', e));
    process.exit(2);
  }
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
  assertCompatibleMapDirs(beforeDir, afterDir);
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
  cleanupCachedCaptureDirs(cacheCapture);
}

const newNote = result.newSurfaces ? ` (+${result.newSurfaces} new surface(s) with no baseline)` : '';
console.log(
  result.changedSurfaces === 0
    ? result.newSurfaces === 0
      ? '✓ no changes — empty report written'
      : `ℹ ${result.newSurfaces} new surface(s) with no baseline — report written for review`
    : `✗ ${result.changedSurfaces} changed surface(s), ${result.totalFindings} finding(s)${newNote}`,
);
console.log(`report: ${result.reportMdPath}`);
if (includeContent && result.contentChanges > 0) {
  console.log(`📝 ${result.contentChanges} advisory content change(s) — does not affect the exit code`);
}
process.exit(result.changedSurfaces === 0 && result.newSurfaces === 0 ? 0 : 1);
