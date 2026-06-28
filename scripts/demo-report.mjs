#!/usr/bin/env node
/**
 * Generate the committed demo report at docs/demo/ — the ACTUAL StyleProof report
 * (real rendered images: clean before/after, the highlighted twin, and the zoom
 * crop for a sub-pixel change), so every PR shows what the report really looks
 * like instead of pasted Markdown nobody can verify.
 *
 *   node scripts/demo-report.mjs           # regenerate docs/demo/ (commit the result)
 *   node scripts/demo-report.mjs --check   # CI: fail if docs/demo/ is stale
 *
 * The inputs are SYNTHETIC and deterministic (drawn with pngjs, not a browser),
 * so the output is byte-stable and the --check gate is robust across machines:
 * it compares the report Markdown and the DECODED PIXELS of each crop (not raw
 * PNG bytes), so zlib differences across Node versions never cause a false stale.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { PNG } from 'pngjs';
import { generateStyleMapReport } from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEMO_DIR = path.join(here, '..', 'docs', 'demo');
const W = 900;
const H = 600;

// rgb string ⇄ tuple, so the drawn pixels and the captured style map agree.
const rgb = ([r, g, b]) => `rgb(${r}, ${g}, ${b})`;
const PAGE = [249, 250, 251];
const HEADER = [17, 24, 39];
const BRAND = [255, 255, 255];
const CARD = [255, 255, 255];
const CARET_BASE = [156, 163, 175]; // grey caret …
const CARET_HEAD = [37, 99, 235]; // … recoloured blue (tiny: only visible zoomed)
const CTA_BASE = [37, 99, 235]; // blue CTA …
const CTA_HEAD = [220, 38, 38]; // … recoloured red (normal-size change)
const HERO = [37, 99, 235];

function newPng(w, h, [r, g, b]) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = 255;
  }
  return png;
}
function fill(png, x, y, w, h, [r, g, b]) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = (yy * png.width + xx) << 2;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
}

// One landing "screenshot": dark header with a small caret icon, a CTA button,
// and a card. `tone` picks the base (before) or head (after) palette.
function homeScreenshot(tone) {
  const png = newPng(W, H, PAGE);
  fill(png, 0, 0, W, 64, HEADER); // header bar
  fill(png, 24, 24, 90, 16, BRAND); // brand wordmark
  fill(png, 150, 40, 12, 16, tone === 'base' ? CARET_BASE : CARET_HEAD); // tiny caret
  fill(png, 40, 110, 180, 52, tone === 'base' ? CTA_BASE : CTA_HEAD); // CTA
  fill(png, 40, 200, 360, 150, CARD); // card
  return PNG.sync.write(png);
}
function homeMap(tone) {
  return makeMap({
    body: { tag: 'body', cls: '', rect: [0, 0, W, H], style: { 'background-color': rgb(PAGE) } },
    'body > header:nth-child(1)': {
      tag: 'header',
      cls: 'topbar',
      rect: [0, 0, W, 64],
      style: { 'background-color': rgb(HEADER) },
    },
    'body > header:nth-child(1) > span:nth-child(1)': {
      tag: 'span',
      cls: 'caret',
      rect: [150, 40, 12, 16],
      style: { color: tone === 'base' ? rgb(CARET_BASE) : rgb(CARET_HEAD) },
    },
    'body > main:nth-child(2) > button:nth-child(1)': {
      tag: 'button',
      cls: 'cta primary',
      rect: [40, 110, 180, 52],
      style: { 'background-color': tone === 'base' ? rgb(CTA_BASE) : rgb(CTA_HEAD) },
    },
    'body > main:nth-child(2) > section:nth-child(2)': {
      tag: 'section',
      cls: 'card',
      rect: [40, 200, 360, 150],
      style: { 'background-color': rgb(CARD) },
    },
  });
}

// A second surface that exists only on the head — a brand-new page, to show the
// `🆕 new surface` path (which never gates).
function pricingScreenshot() {
  const png = newPng(W, H, PAGE);
  fill(png, 0, 0, W, 64, HEADER);
  fill(png, 40, 120, 820, 220, HERO);
  return PNG.sync.write(png);
}
function pricingMap() {
  return makeMap({
    body: { tag: 'body', cls: '', rect: [0, 0, W, H], style: { 'background-color': rgb(PAGE) } },
    'body > section:nth-child(1)': {
      tag: 'section',
      cls: 'hero',
      rect: [40, 120, 820, 220],
      style: { 'background-color': rgb(HERO) },
    },
  });
}

// Minimal StyleMap builder (mirrors test/helpers.mjs makeMap) so this script has
// no test-only dependency.
function makeMap(elements) {
  const els = {};
  for (const [p, e] of Object.entries(elements)) {
    els[p] = { tag: e.tag, cls: e.cls ?? '', ...(e.rect ? { rect: e.rect } : {}), style: e.style ?? {} };
  }
  return { defaults: {}, elements: els, states: {} };
}

function writeCapture(dir, surface, map, pngBuf) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${surface}.json.gz`), gzipSync(JSON.stringify(map)));
  fs.writeFileSync(path.join(dir, `${surface}.png`), pngBuf);
}

// Build the before/after captures into a temp dir, then render the real report.
function render(outDir) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-demo-'));
  const beforeDir = path.join(work, 'before');
  const afterDir = path.join(work, 'after');
  writeCapture(beforeDir, 'home@900', homeMap('base'), homeScreenshot('base'));
  writeCapture(afterDir, 'home@900', homeMap('head'), homeScreenshot('head'));
  // pricing exists only on the head → reported as a new surface.
  writeCapture(afterDir, 'pricing@900', pricingMap(), pricingScreenshot());

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir });
  fs.rmSync(res.reportJsonPath, { force: true }); // commit the human report + images only
  fs.rmSync(work, { recursive: true, force: true });
  return res.reportMdPath;
}

// Compare DECODED pixels, not raw bytes — robust to zlib/Node differences.
function pixelsEqual(a, b) {
  const pa = PNG.sync.read(fs.readFileSync(a));
  const pb = PNG.sync.read(fs.readFileSync(b));
  return pa.width === pb.width && pa.height === pb.height && Buffer.compare(pa.data, pb.data) === 0;
}

if (process.argv.includes('--check')) {
  if (!fs.existsSync(path.join(DEMO_DIR, 'report.md'))) {
    console.error('styleproof: docs/demo/ is missing. Run `npm run demo:report` and commit the result.');
    process.exit(1);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-demo-check-'));
  render(tmp);
  const fresh = (d) => fs.readFileSync(path.join(d, 'report.md'), 'utf8');
  const problems = [];
  if (fresh(tmp) !== fresh(DEMO_DIR)) problems.push('report.md differs');
  const cropsOf = (d) => {
    const c = path.join(d, 'crops');
    return fs.existsSync(c) ? fs.readdirSync(c).sort() : [];
  };
  const a = cropsOf(tmp);
  const b = cropsOf(DEMO_DIR);
  if (a.join(',') !== b.join(','))
    problems.push(`crop set differs:\n  committed: ${b.join(', ')}\n  fresh:     ${a.join(', ')}`);
  for (const f of a.filter((f) => b.includes(f))) {
    if (!pixelsEqual(path.join(tmp, 'crops', f), path.join(DEMO_DIR, 'crops', f)))
      problems.push(`pixels differ: crops/${f}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (problems.length) {
    console.error('styleproof: the committed demo report is stale —\n  ' + problems.join('\n  '));
    console.error('\nReport rendering changed. Run `npm run demo:report` and commit docs/demo/.');
    process.exit(1);
  }
  console.log('styleproof: docs/demo/ is up to date.');
} else {
  const md = render(DEMO_DIR);
  console.log(`styleproof: wrote ${path.relative(path.join(here, '..'), md)} + crops/`);
}
