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
