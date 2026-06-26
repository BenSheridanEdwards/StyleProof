#!/usr/bin/env node
/**
 * Diff two computed-style map captures (see styleproof).
 *
 *   styleproof-diff <beforeDir> <afterDir> [--max N] [--json <file>]
 *   styleproof-diff --base-ref <gitref> <mapsDir> [--max N] [--json <file>]
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
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { diffStyleMapDirs, findingLabel } from '../dist/diff.js';

const HELP = `styleproof-diff — certify a CSS refactor by diffing two computed-style captures

usage: styleproof-diff <beforeDir> <afterDir> [options]
       styleproof-diff --base-ref <gitref> <mapsDir> [options]

options:
  --base-ref <ref> diff <mapsDir> as committed at <ref> (e.g. main) against your
                   working <mapsDir> — base from git, no recapture
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
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-h' || argv[i] === '--help') {
    process.stdout.write(HELP);
    process.exit(0);
  } else if (argv[i] === '--max') MAX = Number(argv[++i]);
  else if (argv[i].startsWith('--max=')) MAX = Number(argv[i].slice(6));
  else if (argv[i] === '--json') jsonOut = argv[++i];
  else if (argv[i].startsWith('--json=')) jsonOut = argv[i].slice(7);
  else if (argv[i] === '--base-ref') baseRef = argv[++i];
  else if (argv[i].startsWith('--base-ref=')) baseRef = argv[i].slice(11);
  else if (argv[i].startsWith('--')) {
    console.error(`unknown flag: ${argv[i]}`);
    process.exit(2);
  } else args.push(argv[i]);
}

/** Run git, exiting 2 with a clean message on failure. */
function git(gitArgs, { encoding = 'buffer' } = {}) {
  const r = spawnSync('git', gitArgs, { encoding, maxBuffer: 1 << 28 });
  return r;
}

/**
 * Materialise the captures committed at <dir> as of <ref> into a fresh temp dir,
 * so the base of the diff is e.g. main's map — no checkout, no recapture. Reads
 * only via git (no `tar`/deps); binary `.json.gz` files come through `git show`.
 */
function materializeRef(ref, dir) {
  const top = git(['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (top.status !== 0) {
    console.error('styleproof-diff --base-ref must run inside a git repository');
    process.exit(2);
  }
  const toplevel = top.stdout.trim();
  // -z: NUL-separated, unquoted paths (handles spaces/unicode).
  const ls = git(['ls-tree', '-r', '-z', '--name-only', ref, '--', dir], { encoding: 'utf8' });
  if (ls.status !== 0) {
    console.error(`cannot read ${dir} at ${ref}: ${(ls.stderr || '').toString().trim()}`);
    process.exit(2);
  }
  const files = ls.stdout.split('\0').filter(Boolean);
  if (files.length === 0) {
    console.error(`no committed captures at ${dir} in ${ref} — commit the maps so the base lives in git`);
    process.exit(2);
  }
  const dirRepoRel = path.relative(toplevel, path.resolve(dir));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-baseref-'));
  for (const f of files) {
    const show = git(['show', `${ref}:${f}`]); // buffer — preserves .json.gz bytes
    if (show.status !== 0) {
      console.error(`cannot read ${f} at ${ref}`);
      process.exit(2);
    }
    const out = path.join(dest, path.relative(dirRepoRel, f));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, show.stdout);
  }
  return dest;
}

let dirA;
let dirB;
let tmpBase = null;
if (baseRef) {
  if (args.length !== 1 || !Number.isFinite(MAX)) {
    console.error('usage: styleproof-diff --base-ref <gitref> <mapsDir> [--max N] [--json <file>]');
    process.exit(2);
  }
  if (!fs.existsSync(args[0])) {
    console.error(`no capture at ${args[0]}`);
    process.exit(2);
  }
  tmpBase = materializeRef(baseRef, args[0]);
  dirA = tmpBase;
  dirB = args[0];
} else {
  if (args.length !== 2 || !Number.isFinite(MAX)) {
    console.error('usage: styleproof-diff <beforeDir> <afterDir> [--max N] [--json <file>]  (--help for all options)');
    process.exit(2);
  }
  [dirA, dirB] = args;
  for (const d of [dirA, dirB]) {
    if (!fs.existsSync(d)) {
      console.error(`no capture at ${d}`);
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
  if (tmpBase) fs.rmSync(tmpBase, { recursive: true, force: true });
}
const { surfaces, counts } = result;

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

if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ counts, surfaces }, null, 2));

const total = counts.dom + counts.style + counts.state;
const newSurfaces = surfaces.filter((s) => s.missing).length;
// One SurfaceDiff per distinct surface across both sides (incl. missing-on-one-side).
const surfaceCount = surfaces.length;
const newNote = newSurfaces ? ` (+${newSurfaces} new surface(s) with no baseline)` : '';
console.log(
  total === 0
    ? newSurfaces === 0
      ? `\n✓ ${surfaceCount} surfaces identical: every computed style, pseudo-element, and hover/focus/active state matches`
      : `\nℹ ${newSurfaces} new surface(s) captured with no baseline to compare — shown for reference, no reviewable change`
    : `\n✗ ${counts.dom} DOM change(s), ${counts.style} computed-style difference(s), ${counts.state} state-delta difference(s) across ${surfaceCount} surfaces${newNote}`,
);
// 0 = identical, 1 = reviewable differences, 3 = only new surfaces (no baseline,
// nothing to review). 2 stays reserved for usage/capture errors.
process.exit(total > 0 ? 1 : newSurfaces > 0 ? 3 : 0);
