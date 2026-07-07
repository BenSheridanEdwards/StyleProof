// Source of truth — the report leads with the certification gates. A reviewer reading
// report.md should see "is this green trustworthy?" (coverage complete? determinism
// proven? did the navigable set shrink?) BEFORE the pixel details.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateStyleMapReport } from '../dist/index.js';
import { COVERAGE_LEDGER } from '../dist/coverage.js';

const nav = (keys) => keys.map((k) => ({ key: `nav-button:${k}`, kind: 'nav-button', label: k.toUpperCase() }));
const mapWith = (inventory) =>
  JSON.stringify({ defaults: {}, elements: {}, states: {}, ...(inventory ? { inventory } : {}) });

// Build a base/head bundle. `home` carries the nav inventory; ledgers carry the
// coverage registry + determinism basis. Style diff stays empty (inventory ≠ style),
// so only the certification block is under test.
function bundle({ captured, baseNav, headNav, expected, baseDet, headDet }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cert-'));
  const base = path.join(root, 'base');
  const head = path.join(root, 'head');
  const out = path.join(root, 'out');
  fs.mkdirSync(base);
  fs.mkdirSync(head);
  for (const k of captured) {
    fs.writeFileSync(path.join(base, `${k}@1440.json`), mapWith(k === 'home' ? nav(baseNav) : null));
    fs.writeFileSync(path.join(head, `${k}@1440.json`), mapWith(k === 'home' ? nav(headNav) : null));
  }
  fs.writeFileSync(
    path.join(base, COVERAGE_LEDGER),
    JSON.stringify({ version: 1, expected: null, exclude: {}, determinism: baseDet }),
  );
  fs.writeFileSync(
    path.join(head, COVERAGE_LEDGER),
    JSON.stringify({ version: 1, expected, exclude: {}, determinism: headDet }),
  );
  return { root, base, head, out };
}
const readMd = (out) => fs.readFileSync(path.join(out, 'report.md'), 'utf8');

test('a healthy bundle leads with all-green certification', () => {
  const { root, base, head, out } = bundle({
    captured: ['home', 'about'],
    baseNav: ['home', 'about'],
    headNav: ['home', 'about'],
    expected: ['home', 'about'],
    baseDet: 'self-checked',
    headDet: 'self-checked',
  });
  generateStyleMapReport({ beforeDir: base, afterDir: head, outDir: out });
  const md = readMd(out);
  assert.match(md, /\*\*Certification\*\*/);
  assert.match(md, /Coverage.*✓ complete/);
  assert.match(md, /Determinism.*✓ proven/);
  assert.match(md, /Inventory.*✓ navigable set unchanged/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the certification block surfaces every failing gate (coverage, determinism, inventory)', () => {
  const { root, base, head, out } = bundle({
    captured: ['home'], // 'about' registered but never captured → incomplete coverage
    baseNav: ['home', 'billing', 'settings'],
    headNav: ['home', 'settings'], // billing removed
    expected: ['home', 'about'],
    baseDet: 'self-checked',
    headDet: 'unproven', // head not proven
  });
  generateStyleMapReport({ beforeDir: base, afterDir: head, outDir: out });
  const md = readMd(out);
  assert.match(md, /Coverage.*✗ INCOMPLETE.*about/);
  assert.match(md, /Determinism.*✗ NOT proven/);
  assert.match(md, /Inventory.*⚠ 1 navigable affordance\(s\) removed.*nav-button:billing/);
  // and it appears before the pixel summary
  assert.ok(md.indexOf('**Certification**') < md.indexOf('surfaces identical') || !md.includes('surfaces identical'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('an addition-only run names the added affordance and still reads as ✓ (additions do not gate)', () => {
  // Regression for #192: styleproof-diff prints an inventory addition, so the report's
  // certification block must not claim the navigable set is unchanged.
  const { root, base, head, out } = bundle({
    captured: ['home'],
    baseNav: ['home'],
    headNav: ['home', 'new-view'], // one nav item added
    expected: null,
    baseDet: 'self-checked',
    headDet: 'self-checked',
  });
  generateStyleMapReport({ beforeDir: base, afterDir: head, outDir: out });
  const md = readMd(out);
  assert.match(md, /Inventory.*✓ 1 navigable affordance\(s\) added: nav-button:new-view \(additions don't gate\)/);
  assert.doesNotMatch(md, /navigable set unchanged/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an unacknowledged removal plus an addition renders both — removal drives ⚠, addition appended', () => {
  const { root, base, head, out } = bundle({
    captured: ['home'],
    baseNav: ['home', 'billing'],
    headNav: ['home', 'new-view'], // billing removed (gates), new-view added (does not)
    expected: null,
    baseDet: 'self-checked',
    headDet: 'self-checked',
  });
  generateStyleMapReport({ beforeDir: base, afterDir: head, outDir: out });
  const md = readMd(out);
  assert.match(
    md,
    /Inventory.*⚠ 1 navigable affordance\(s\) removed, unacknowledged: nav-button:billing; 1 navigable affordance\(s\) added: nav-button:new-view \(additions don't gate\)/,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('a hostile added key renders inertly — no Markdown injection into the certification line', () => {
  // Added keys, like removed ones, flow into the privileged PR-comment summary; a key
  // crafted to break out of its code/table context must render with control chars stripped.
  const hostile = 'x](evil)<img src=x>|';
  const { root, base, head, out } = bundle({
    captured: ['home'],
    baseNav: ['home'],
    headNav: ['home', hostile],
    expected: null,
    baseDet: 'self-checked',
    headDet: 'self-checked',
  });
  generateStyleMapReport({ beforeDir: base, afterDir: head, outDir: out });
  const md = readMd(out);
  assert.doesNotMatch(md, /x\]\(evil\)/);
  assert.doesNotMatch(md, /<img src=x>/);
  assert.match(md, /nav-button:x--evil--img src=x-/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an old bundle with no ledger and no inventory change adds no certification block', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cert-old-'));
  const base = path.join(root, 'base');
  const head = path.join(root, 'head');
  const out = path.join(root, 'out');
  fs.mkdirSync(base);
  fs.mkdirSync(head);
  fs.writeFileSync(path.join(base, 'home@1440.json'), mapWith(null));
  fs.writeFileSync(path.join(head, 'home@1440.json'), mapWith(null));
  generateStyleMapReport({ beforeDir: base, afterDir: head, outDir: out });
  assert.doesNotMatch(readMd(out), /\*\*Certification\*\*/);
  fs.rmSync(root, { recursive: true, force: true });
});

// ── data-residue certification line (issue #205) ──────────────────────────────────
// Head map carries a failing-endpoint residue; the ledger arms the gate (or not).
function residueBundle({ residue, gate }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cert-res-'));
  const base = path.join(root, 'base');
  const head = path.join(root, 'head');
  const out = path.join(root, 'out');
  fs.mkdirSync(base);
  fs.mkdirSync(head);
  const map = (r) => JSON.stringify({ defaults: {}, elements: {}, states: {}, ...(r ? { dataResidue: r } : {}) });
  fs.writeFileSync(path.join(base, 'dashboard@1440.json'), map(null));
  fs.writeFileSync(path.join(head, 'dashboard@1440.json'), map(residue));
  const ledger = {
    version: 1,
    expected: null,
    exclude: {},
    determinism: 'self-checked',
    dataResidue: gate ? 'gate' : 'warn',
  };
  fs.writeFileSync(path.join(head, COVERAGE_LEDGER), JSON.stringify(ledger));
  fs.writeFileSync(
    path.join(base, COVERAGE_LEDGER),
    JSON.stringify({ version: 1, expected: null, exclude: {}, determinism: 'self-checked' }),
  );
  return { root, base, head, out };
}
const residueEntry = {
  key: 'dashboard·/api/probe',
  surface: 'dashboard',
  endpoint: '/api/probe',
  reason: 'net::ERR_CONNECTION_REFUSED',
};

test('an armed gate with an unacknowledged failing endpoint renders a ✗ data-residue line', () => {
  const { root, base, head, out } = residueBundle({ residue: [residueEntry], gate: true });
  generateStyleMapReport({ beforeDir: base, afterDir: head, outDir: out });
  assert.match(readMd(out), /Data residue.*✗ 1 failing data endpoint\(s\), unacknowledged: dashboard·\/api\/probe/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('warn opt-out residue renders ⚠ (recorded, not gating)', () => {
  const { root, base, head, out } = residueBundle({ residue: [residueEntry], gate: false });
  generateStyleMapReport({ beforeDir: base, afterDir: head, outDir: out });
  assert.match(readMd(out), /Data residue.*⚠ 1 failing data endpoint\(s\).*recorded, not gating/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a clean healthy bundle (no residue, not armed) omits the data-residue line entirely', () => {
  const { root, base, head, out } = residueBundle({ residue: null, gate: false });
  generateStyleMapReport({ beforeDir: base, afterDir: head, outDir: out });
  const md = readMd(out);
  assert.match(md, /\*\*Certification\*\*/); // ledger present → block renders
  assert.doesNotMatch(md, /Data residue/); // but no residue line
  fs.rmSync(root, { recursive: true, force: true });
});
