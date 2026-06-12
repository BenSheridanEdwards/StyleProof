#!/usr/bin/env node
/**
 * Diff two computed-style map captures (see playwright-stylemap).
 *
 *   stylemap-diff <beforeDir> <afterDir> [--max N]
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
 * Custom properties (--*) are ignored: they are inputs, not outcomes. Every
 * visual effect of a variable lands in a real longhand (color, transform,
 * background-image, …) which is compared in full — so defining or renaming a
 * token is invisible here, while changing what an element resolves to is not.
 * (This also covers Tailwind's --tw-* machinery.)
 *
 * Exit code 0 = identical, 1 = differences, 2 = usage/capture error.
 */
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

const argv = process.argv.slice(2);
const args = [];
let MAX = 40;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--max') MAX = Number(argv[++i]);
  else if (argv[i].startsWith('--max=')) MAX = Number(argv[i].slice(6));
  else if (argv[i].startsWith('--')) {
    console.error(`unknown flag: ${argv[i]}`);
    process.exit(2);
  } else args.push(argv[i]);
}
if (args.length !== 2 || !Number.isFinite(MAX)) {
  console.error('usage: stylemap-diff <beforeDir> <afterDir> [--max N]');
  process.exit(2);
}
const [dirA, dirB] = args;
for (const d of [dirA, dirB]) {
  if (!fs.existsSync(d)) {
    console.error(`no capture at ${d}`);
    process.exit(2);
  }
}

const readMap = (p) =>
  JSON.parse(p.endsWith('.gz') ? gunzipSync(fs.readFileSync(p)).toString('utf8') : fs.readFileSync(p, 'utf8'));
const index = (dir) =>
  Object.fromEntries(
    fs
      .readdirSync(dir)
      .filter((f) => /\.json(\.gz)?$/.test(f))
      .map((f) => [f.replace(/\.json(\.gz)?$/, ''), path.join(dir, f)]),
  );
const indexA = index(dirA);
const indexB = index(dirB);
const files = [...new Set([...Object.keys(indexA), ...Object.keys(indexB)])].sort();
if (files.length === 0) {
  console.error(`no .json(.gz) captures found in ${dirA} or ${dirB}`);
  process.exit(2);
}
let domChanges = 0;
let styleChanges = 0;
let stateChanges = 0;

// Class lists are context, not keys — truncate utility soup for readability.
const label = (entry, p) => {
  if (!entry?.cls) return p;
  const classes = entry.cls.split(' ').filter(Boolean);
  const shown = classes.slice(0, 3).join('.');
  return `${p}  (.${shown}${classes.length > 3 ? '…' : ''})`;
};

for (const surface of files) {
  const pa = indexA[surface];
  const pb = indexB[surface];
  if (!pa || !pb) {
    console.log(`\n${surface}: captured in only one set — re-run both captures`);
    domChanges++;
    continue;
  }
  const A = readMap(pa);
  const B = readMap(pb);
  const lines = [];

  for (const p of new Set([...Object.keys(A.elements), ...Object.keys(B.elements)])) {
    const ea = A.elements[p];
    const eb = B.elements[p];
    if (!ea || !eb) {
      lines.push(`  DOM ${!ea ? 'added' : 'removed'}: ${label(ea || eb, p)}`);
      domChanges++;
      continue;
    }
    if (ea.tag !== eb.tag) {
      lines.push(`  DOM retagged: ${p} <${ea.tag}> → <${eb.tag}>`);
      domChanges++;
      continue;
    }
    const defsA = A.defaults[ea.tag] ?? {};
    const defsB = B.defaults[eb.tag] ?? {};
    for (const pseudo of [null, ...new Set([...Object.keys(ea.pseudo ?? {}), ...Object.keys(eb.pseudo ?? {})])]) {
      const propsA = pseudo ? (ea.pseudo?.[pseudo] ?? {}) : ea.style;
      const propsB = pseudo ? (eb.pseudo?.[pseudo] ?? {}) : eb.style;
      const changed = [];
      for (const prop of new Set([...Object.keys(propsA), ...Object.keys(propsB)])) {
        if (prop.startsWith('--')) continue;
        const va = propsA[prop] ?? defsA[prop] ?? '(unset)';
        const vb = propsB[prop] ?? defsB[prop] ?? '(unset)';
        if (va !== vb) changed.push(`    ${prop}: ${va} → ${vb}`);
      }
      if (changed.length) {
        lines.push(`  ${label(ea, p)}${pseudo || ''}`, ...changed);
        styleChanges += changed.length;
      }
    }
  }

  for (const p of new Set([...Object.keys(A.states ?? {}), ...Object.keys(B.states ?? {})])) {
    const sa = A.states?.[p] ?? {};
    const sb = B.states?.[p] ?? {};
    for (const state of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
      const da = sa[state] ?? {};
      const db = sb[state] ?? {};
      for (const sub of new Set([...Object.keys(da), ...Object.keys(db)])) {
        const propsA = da[sub] ?? {};
        const propsB = db[sub] ?? {};
        const changed = [];
        for (const prop of new Set([...Object.keys(propsA), ...Object.keys(propsB)])) {
          if (prop.startsWith('--')) continue;
          const va = propsA[prop] ?? '(state does not change it)';
          const vb = propsB[prop] ?? '(state no longer changes it)';
          if (va !== vb) changed.push(`    ${prop}: ${va} → ${vb}`);
        }
        if (changed.length) {
          lines.push(
            `  [:${state}] ${label(A.elements[p] ?? B.elements[p], p)}${sub !== p ? ` ⇒ ${sub}` : ''}`,
            ...changed,
          );
          stateChanges += changed.length;
        }
      }
    }
  }

  if (lines.length) {
    console.log(`\n${surface}: ${lines.filter((l) => !l.startsWith('    ')).length} element(s) differ`);
    for (const line of lines.slice(0, MAX)) console.log(line);
    if (lines.length > MAX) console.log(`  ... and ${lines.length - MAX} more lines (re-run with --max ${lines.length})`);
  }
}

const total = domChanges + styleChanges + stateChanges;
console.log(
  total === 0
    ? `\n✓ ${files.length} surfaces identical: every computed style, pseudo-element, and hover/focus/active state matches`
    : `\n✗ ${domChanges} DOM change(s), ${styleChanges} computed-style difference(s), ${stateChanges} state-delta difference(s) across ${files.length} surfaces`,
);
process.exit(total === 0 ? 0 : 1);
