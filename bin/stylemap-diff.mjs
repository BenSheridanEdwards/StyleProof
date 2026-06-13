#!/usr/bin/env node
/**
 * Diff two computed-style map captures (see playwright-stylemap).
 *
 *   stylemap-diff <beforeDir> <afterDir> [--max N] [--json <file>]
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
 * Custom properties (--*) are ignored: they are inputs, not outcomes (see
 * README). Exit code 0 = identical, 1 = differences, 2 = usage/capture error.
 */
import fs from 'node:fs';
import { diffStyleMapDirs, findingLabel } from '../dist/diff.js';

const HELP = `stylemap-diff — certify a CSS refactor by diffing two computed-style captures

usage: stylemap-diff <beforeDir> <afterDir> [options]

options:
  --max <n>        max lines printed per surface before truncating (default: 40)
  --json <file>    also write the full structured diff to <file>
  -h, --help       show this help

exit: 0 identical (certified), 1 differences found, 2 usage/capture error.
`;

const argv = process.argv.slice(2);
const args = [];
let MAX = 40;
let jsonOut = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-h' || argv[i] === '--help') {
    process.stdout.write(HELP);
    process.exit(0);
  } else if (argv[i] === '--max') MAX = Number(argv[++i]);
  else if (argv[i].startsWith('--max=')) MAX = Number(argv[i].slice(6));
  else if (argv[i] === '--json') jsonOut = argv[++i];
  else if (argv[i].startsWith('--json=')) jsonOut = argv[i].slice(7);
  else if (argv[i].startsWith('--')) {
    console.error(`unknown flag: ${argv[i]}`);
    process.exit(2);
  } else args.push(argv[i]);
}
if (args.length !== 2 || !Number.isFinite(MAX)) {
  console.error('usage: stylemap-diff <beforeDir> <afterDir> [--max N] [--json <file>]  (--help for all options)');
  process.exit(2);
}
const [dirA, dirB] = args;
for (const d of [dirA, dirB]) {
  if (!fs.existsSync(d)) {
    console.error(`no capture at ${d}`);
    process.exit(2);
  }
}

let result;
try {
  result = diffStyleMapDirs(dirA, dirB);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
const { surfaces, counts } = result;

for (const sd of surfaces) {
  if (sd.missing) {
    console.log(`\n${sd.surface}: captured in only one set — re-run both captures`);
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

if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ counts, surfaces }, null, 2));

const total = counts.dom + counts.style + counts.state;
const surfaceCount = new Set([
  ...fs.readdirSync(dirA).filter((f) => /\.json(\.gz)?$/.test(f)),
  ...fs.readdirSync(dirB).filter((f) => /\.json(\.gz)?$/.test(f)),
]).size;
console.log(
  total === 0
    ? `\n✓ ${surfaceCount} surfaces identical: every computed style, pseudo-element, and hover/focus/active state matches`
    : `\n✗ ${counts.dom} DOM change(s), ${counts.style} computed-style difference(s), ${counts.state} state-delta difference(s) across ${surfaceCount} surfaces`,
);
process.exit(total === 0 ? 0 : 1);
