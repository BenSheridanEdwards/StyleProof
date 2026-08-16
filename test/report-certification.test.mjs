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
function bundle({ captured, baseNav, headNav, expected, exclude = {}, baseDet, headDet }) {
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
    JSON.stringify({ version: 1, expected, exclude, determinism: headDet }),
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

test('complete coverage distinguishes captures from explicit exclusions', () => {
  const { root, base, head, out } = bundle({
    captured: ['home', 'pricing'],
    baseNav: ['home', 'pricing'],
    headNav: ['home', 'pricing'],
    expected: ['home', 'pricing', 'account'],
    exclude: { account: 'Authentication fixture is not available.' },
    baseDet: 'self-checked',
    headDet: 'self-checked',
  });
  generateStyleMapReport({ beforeDir: base, afterDir: head, outDir: out });
  const md = readMd(out);
  assert.match(md, /Coverage.*✓ complete \(2 of 3 registered surface\(s\) captured; 1 explicitly excluded\)/);
  assert.doesNotMatch(md, /all 3 registered surface\(s\) captured/);
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

// ── confidence ledger line (issue #399) ───────────────────────────────────────────
// Completeness and the visual verdict are two badges: the certification block
// carries the confidence line, the headline stays the visual verdict, and a green
// on one never implies the other.
import { writeConfidenceLedger, buildConfidenceLedger, CONFIDENCE_LEDGER } from '../dist/confidence-ledger.js';

test('a healthy asserted bundle renders Confidence ✓ complete, and report.json carries the summary', () => {
  const { root, base, head, out } = bundle({
    captured: ['home', 'about'],
    baseNav: ['home', 'about'],
    headNav: ['home', 'about'],
    expected: ['home', 'about'],
    baseDet: 'self-checked',
    headDet: 'self-checked',
  });
  const result = generateStyleMapReport({ beforeDir: base, afterDir: head, outDir: out });
  const md = readMd(out);
  assert.match(md, /\*\*Confidence\*\* — ✓ complete \(2 captured\)/);
  assert.equal(result.confidence.completeness, 'complete');
  const json = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.equal(json.confidence.completeness, 'complete');
  assert.equal(json.confidence.counts.captured, 2);
  // Two badges: the visual verdict wording never absorbs the completeness claim.
  assert.doesNotMatch(md, /complete.*surfaces identical|surfaces identical.*fully certified/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an unasserted registry renders ⚠ unasserted — no percentage, no completeness claim', () => {
  const { root, base, head, out } = bundle({
    captured: ['home'],
    baseNav: ['home'],
    headNav: ['home'],
    expected: null,
    baseDet: 'self-checked',
    headDet: 'self-checked',
  });
  generateStyleMapReport({ beforeDir: base, afterDir: head, outDir: out });
  const md = readMd(out);
  assert.match(
    md,
    /\*\*Confidence\*\* — ⚠ unasserted \(no `expected` registry — certifies only the 1 captured surface\(s\)/,
  );
  assert.doesNotMatch(md, /\d+(\.\d+)?%/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a registered-but-uncovered surface and unproven determinism read as limited with named counts', () => {
  const { root, base, head, out } = bundle({
    captured: ['home'],
    baseNav: ['home'],
    headNav: ['home'],
    expected: ['home', 'about'],
    baseDet: 'self-checked',
    headDet: 'unproven',
  });
  const result = generateStyleMapReport({ beforeDir: base, afterDir: head, outDir: out });
  const md = readMd(out);
  assert.match(md, /\*\*Confidence\*\* — ⚠ limited \(0 captured, 1 unknown, 1 unproven-determinism\)/);
  assert.equal(result.confidence.completeness, 'limited');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a persisted crawl ledger with an auth wall renders limited and names the inaccessible surface', () => {
  const { root, base, head, out } = bundle({
    captured: ['landing'],
    baseNav: ['landing'],
    headNav: ['landing'],
    expected: null,
    baseDet: 'self-checked',
    headDet: 'self-checked',
  });
  writeConfidenceLedger(
    head,
    buildConfidenceLedger({
      capturedKeys: ['landing'],
      coverage: null,
      auth: { acknowledged: [], unacknowledged: [{ key: '/login·password-input' }] },
    }),
  );
  const result = generateStyleMapReport({ beforeDir: base, afterDir: head, outDir: out });
  const md = readMd(out);
  assert.match(
    md,
    /\*\*Confidence\*\* — ⚠ limited \(1 captured, 1 inaccessible\); inaccessible: \/login·password-input/,
  );
  assert.equal(result.confidence.counts.inaccessible, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a bundle predating the confidence ledger degrades to ⚠ unknown when the block renders (never blocks)', () => {
  // No coverage ledger and no confidence file — but an inventory change forces the
  // certification block, so the confidence line must degrade honestly to unknown.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cert-conf-old-'));
  const base = path.join(root, 'base');
  const head = path.join(root, 'head');
  const out = path.join(root, 'out');
  fs.mkdirSync(base);
  fs.mkdirSync(head);
  fs.writeFileSync(path.join(base, 'home@1440.json'), mapWith(nav(['home', 'billing'])));
  fs.writeFileSync(path.join(head, 'home@1440.json'), mapWith(nav(['home'])));
  const result = generateStyleMapReport({ beforeDir: base, afterDir: head, outDir: out });
  const md = readMd(out);
  assert.match(
    md,
    /\*\*Confidence\*\* — ⚠ unknown \(capture predates the confidence ledger; not blocking retroactively\)/,
  );
  assert.equal(result.confidence.completeness, 'unknown');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a corrupt confidence file degrades to derived/unknown instead of disarming or throwing', () => {
  const { root, base, head, out } = bundle({
    captured: ['home'],
    baseNav: ['home'],
    headNav: ['home'],
    expected: ['home'],
    baseDet: 'self-checked',
    headDet: 'self-checked',
  });
  fs.writeFileSync(path.join(head, CONFIDENCE_LEDGER), '{corrupt');
  const result = generateStyleMapReport({ beforeDir: base, afterDir: head, outDir: out });
  // The coverage ledger still derives a real verdict; the corrupt file cannot disarm it.
  assert.match(readMd(out), /\*\*Confidence\*\* — ✓ complete \(1 captured\)/);
  assert.equal(result.confidence.completeness, 'complete');
  fs.rmSync(root, { recursive: true, force: true });
});
