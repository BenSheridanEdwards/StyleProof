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

const HELP = `styleproof-report — reviewable before/after report from two captures

usage: styleproof-report <beforeDir> <afterDir> --out <dir> [options]

options:
  --out <dir>               output directory (default: styleproof-report)
  --image-base-url <url>    prefix for image URLs in report.md (default: relative)
  --pad <px>                padding around changed rects when cropping (default: 24)
  --max-crops <n>           max crop regions per surface before collapsing (default: 6)
  --min-width <px>          minimum crop width, for context (default: 320)
  --min-height <px>         minimum crop height, for context (default: 180)
  --include-layout-noise    keep size/position-derived longhands (height, width,
                            transform-origin, top…) that a reflow changes up the
                            whole ancestor chain (off by default)
  -h, --help                show this help

exit: 0 no changes, 1 report generated, 2 usage error.
`;

const argv = process.argv.slice(2);
const args = [];
const flags = { out: 'styleproof-report', imageBaseUrl: '' };
let pad;
let maxCrops;
let minWidth;
let minHeight;
let includeLayoutNoise = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-h' || a === '--help') {
    process.stdout.write(HELP);
    process.exit(0);
  } else if (a === '--out') flags.out = argv[++i];
  else if (a.startsWith('--out=')) flags.out = a.slice(6);
  else if (a === '--image-base-url') flags.imageBaseUrl = argv[++i];
  else if (a.startsWith('--image-base-url=')) flags.imageBaseUrl = a.slice(17);
  else if (a === '--pad') pad = Number(argv[++i]);
  else if (a.startsWith('--pad=')) pad = Number(a.slice(6));
  else if (a === '--max-crops') maxCrops = Number(argv[++i]);
  else if (a.startsWith('--max-crops=')) maxCrops = Number(a.slice(12));
  else if (a === '--min-width') minWidth = Number(argv[++i]);
  else if (a.startsWith('--min-width=')) minWidth = Number(a.slice(12));
  else if (a === '--min-height') minHeight = Number(argv[++i]);
  else if (a.startsWith('--min-height=')) minHeight = Number(a.slice(13));
  else if (a === '--include-layout-noise') includeLayoutNoise = true;
  else if (a.startsWith('--include-layout-noise=')) includeLayoutNoise = a.slice(23) !== 'false';
  else if (a.startsWith('--')) {
    console.error(`unknown flag: ${a}`);
    process.exit(2);
  } else args.push(a);
}
if (args.length !== 2) {
  console.error('usage: styleproof-report <beforeDir> <afterDir> --out <dir> [options]  (--help for all options)');
  process.exit(2);
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

let result;
try {
  result = generateStyleMapReport({
    beforeDir: args[0],
    afterDir: args[1],
    outDir: flags.out,
    imageBaseUrl: flags.imageBaseUrl || undefined,
    pad,
    maxCrops,
    minWidth,
    minHeight,
    includeLayoutNoise,
  });
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

console.log(
  result.changedSurfaces === 0
    ? '✓ no changes — empty report written'
    : `✗ ${result.changedSurfaces} changed surface(s), ${result.totalFindings} finding(s)`,
);
console.log(`report: ${result.reportMdPath}`);
process.exit(result.changedSurfaces === 0 ? 0 : 1);
