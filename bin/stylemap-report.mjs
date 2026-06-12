#!/usr/bin/env node
/**
 * Visual diff report: side-by-side before/after crops of every changed
 * region, plus the exact property changes, as markdown ready for a PR
 * comment.
 *
 *   stylemap-report <beforeDir> <afterDir> --out <dir> [--image-base-url <url>]
 *
 * Both capture dirs need the .json.gz maps; side-by-side images additionally
 * need the .png screenshots that `defineStyleMapCapture` saves by default.
 * Exit code 0 = no changes, 1 = report generated, 2 = usage error.
 */
import { generateStyleMapReport } from '../dist/report.js';

const argv = process.argv.slice(2);
const args = [];
const flags = { out: 'stylemap-report', imageBaseUrl: '' };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') flags.out = argv[++i];
  else if (argv[i].startsWith('--out=')) flags.out = argv[i].slice(6);
  else if (argv[i] === '--image-base-url') flags.imageBaseUrl = argv[++i];
  else if (argv[i].startsWith('--image-base-url=')) flags.imageBaseUrl = argv[i].slice(17);
  else if (argv[i].startsWith('--')) {
    console.error(`unknown flag: ${argv[i]}`);
    process.exit(2);
  } else args.push(argv[i]);
}
if (args.length !== 2) {
  console.error('usage: stylemap-report <beforeDir> <afterDir> --out <dir> [--image-base-url <url>]');
  process.exit(2);
}

let result;
try {
  result = generateStyleMapReport({
    beforeDir: args[0],
    afterDir: args[1],
    outDir: flags.out,
    imageBaseUrl: flags.imageBaseUrl || undefined,
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
