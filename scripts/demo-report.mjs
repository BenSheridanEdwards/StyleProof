#!/usr/bin/env node
// Generate the committed demo report at docs/demo/ — the ACTUAL StyleProof report
// (real rendered images), so every PR shows what the report really looks like.
//
//   node scripts/demo-report.mjs           # regenerate docs/demo/ (commit the result)
//   node scripts/demo-report.mjs --check   # CI: fail if docs/demo/ is stale
//
// The inputs are SYNTHETIC and deterministic (drawn with pngjs, not a browser). The
// --check gate compares the report Markdown and the DECODED PIXELS of each crop, so
// zlib differences across Node versions never cause a false stale.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { generateStyleMapReport } from '../dist/index.js';
import { fillRect as fill } from '../dist/png-util.js';
import { solidPng, writeCapture } from './fixture-util.mjs';

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
const TOOLBAR = [55, 65, 81];
const SWITCH = [88, 28, 135];
const GRID = [229, 231, 235];
const DUPLICATE_CONTROL = [37, 99, 235];
const CONTENT_CONTROL = [31, 41, 55];
const CONTENT_ADJACENT = [16, 185, 129];
const CONTENT_BASE = [239, 68, 68];
const CONTENT_HEAD = [59, 130, 246];

const page = () => solidPng(W, H, PAGE);
const bg = (color) => ({ 'background-color': rgb(color) });
/** One style-map element; `extra` adds e.g. `text`. */
const el = (tag, cls, rect, style, extra = {}) => ({ tag, cls, rect, style, ...extra });
const body = el('body', '', [0, 0, W, H], bg(PAGE));

const CONTENT_GLYPHS = {
  D: ['110', '101', '101', '101', '110'],
  E: ['111', '100', '110', '100', '111'],
  L: ['100', '100', '100', '100', '111'],
  N: ['10001', '11001', '10101', '10011', '10001'],
  O: ['111', '101', '101', '101', '111'],
  W: ['101', '101', '111', '111', '101'],
};

function drawContentWord(png, word, x, y, scale = 2) {
  let cursorX = x;
  for (const letter of word) {
    const rows = CONTENT_GLYPHS[letter];
    for (const [row, pixels] of rows.entries()) {
      for (const [column, pixel] of [...pixels].entries()) {
        if (pixel === '1') fill(png, cursorX + column * scale, y + row * scale, scale, scale, BRAND);
      }
    }
    cursorX += (rows[0].length + 1) * scale;
  }
}

// One landing "screenshot": dark header with a small caret icon, a CTA button,
// and a card. `tone` picks the base (before) or head (after) palette.
function homeScreenshot(tone) {
  const base = tone === 'base';
  const png = page();
  fill(png, 0, 0, W, 64, HEADER); // header bar
  fill(png, 24, 24, 90, 16, BRAND); // brand wordmark
  fill(png, 150, 40, 12, 16, base ? CARET_BASE : CARET_HEAD); // tiny caret
  fill(png, 40, 110, 180, 52, base ? CTA_BASE : CTA_HEAD); // CTA
  fill(png, 40, 200, 360, 150, CARD); // card
  fill(png, 450, 200, 400, 80, CONTENT_CONTROL); // contextual content control
  fill(png, 470, 220, 100, 40, CONTENT_ADJACENT); // adjacent control proves context
  fill(png, 790, 232, 40, 16, base ? CONTENT_BASE : CONTENT_HEAD); // changed label
  drawContentWord(png, base ? 'OLD' : 'NEW', 798, 235);
  return PNG.sync.write(png);
}
function homeMap(tone) {
  const base = tone === 'base';
  return makeMap({
    body,
    'body > header:nth-child(1)': el('header', 'topbar', [0, 0, W, 64], bg(HEADER)),
    'body > header:nth-child(1) > span:nth-child(1)': el('span', 'caret', [150, 40, 12, 16], {
      color: rgb(base ? CARET_BASE : CARET_HEAD),
    }),
    'body > main:nth-child(2) > button:nth-child(1)': el(
      'button',
      'cta primary',
      [40, 110, 180, 52],
      bg(base ? CTA_BASE : CTA_HEAD),
    ),
    'body > main:nth-child(2) > section:nth-child(2)': el('section', 'card', [40, 200, 360, 150], bg(CARD)),
    'body > main:nth-child(2) > div:nth-child(3)': el(
      'div',
      'content-control',
      [450, 200, 400, 80],
      bg(CONTENT_CONTROL),
    ),
    'body > main:nth-child(2) > div:nth-child(3) > button:nth-child(1)': el(
      'button',
      'adjacent-action',
      [470, 220, 100, 40],
      bg(CONTENT_ADJACENT),
    ),
    'body > main:nth-child(2) > div:nth-child(3) > span:nth-child(2)': el(
      'span',
      'content-label',
      [790, 232, 40, 16],
      { color: rgb(BRAND) },
      { text: base ? 'Old' : 'New' },
    ),
    // The property change is auditable, but the element is fully left of the canvas:
    // the report must name that limitation instead of cropping unrelated content.
    'body > aside:nth-child(3)': el('aside', 'off-canvas-status', [-241, 400, 76, 37], {
      opacity: base ? '0.85' : '1',
    }),
  });
}

// A second surface that exists only on the head — the `🆕 new surface` path (never gates).
function pricingScreenshot() {
  const png = page();
  fill(png, 0, 0, W, 64, HEADER);
  fill(png, 40, 120, 820, 220, HERO);
  return PNG.sync.write(png);
}
const pricingMap = () =>
  makeMap({ body, 'body > section:nth-child(1)': el('section', 'hero', [40, 120, 820, 220], bg(HERO)) });

function insertionScreenshot(tone) {
  const png = page();
  if (tone === 'head') {
    fill(png, 650, 20, 210, 40, SWITCH);
    fill(png, 670, 30, 80, 20, BRAND);
  }
  const offset = tone === 'base' ? 0 : 60;
  fill(png, 40, 20 + offset, 820, 40, TOOLBAR);
  fill(png, 60, 30 + offset, 100, 20, BRAND);
  fill(png, 40, 80 + offset, 820, 240, GRID);
  fill(png, 60, 100 + offset, 340, 180, CARD);
  return PNG.sync.write(png);
}

function insertionMap(tone) {
  const elements = { body };
  const offset = tone === 'base' ? 0 : 1;
  if (tone === 'head') {
    elements['body > div:nth-child(1)'] = el('div', 'scope-switch', [650, 20, 210, 40], bg(SWITCH));
    elements['body > div:nth-child(1) > button:nth-child(1)'] = el('button', 'scope-option', [670, 30, 80, 20], {
      color: rgb(BRAND),
    });
  }
  const dy = offset * 60;
  elements[`body > div:nth-child(${1 + offset})`] = el('div', 'toolbar', [40, 20 + dy, 820, 40], bg(TOOLBAR));
  elements[`body > div:nth-child(${1 + offset}) > button:nth-child(1)`] = el(
    'button',
    'filter',
    [60, 30 + dy, 100, 20],
    {
      color: rgb(BRAND),
    },
  );
  elements[`body > div:nth-child(${2 + offset})`] = el('div', 'grid', [40, 80 + dy, 820, 240], bg(GRID));
  elements[`body > div:nth-child(${2 + offset}) > article:nth-child(1)`] = el(
    'article',
    'card',
    [60, 100 + dy, 340, 180],
    bg(CARD),
  );
  return makeMap(elements);
}

function duplicateInsertionScreenshot(tone) {
  const png = page();
  fill(png, 0, 0, W, 64, HEADER);
  const count = tone === 'base' ? 1 : 2;
  for (let index = 0; index < count; index++) fill(png, 80, 120 + index * 80, 220, 44, DUPLICATE_CONTROL);
  return PNG.sync.write(png);
}

function duplicateInsertionMap(tone) {
  const count = tone === 'base' ? 1 : 2;
  return makeMap({
    body,
    ...Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `body > button:nth-child(${index + 1})`,
        el('button', 'duplicate-control', [80, 120 + index * 80, 220, 44], bg(DUPLICATE_CONTROL)),
      ]),
    ),
  });
}

// Minimal StyleMap builder (mirrors test/helpers.mjs makeMap) so this script has no test-only dependency.
function makeMap(elements) {
  const els = {};
  for (const [p, e] of Object.entries(elements)) {
    els[p] = {
      tag: e.tag,
      cls: e.cls ?? '',
      ...(e.rect ? { rect: e.rect } : {}),
      ...(e.text !== undefined ? { text: e.text } : {}),
      style: e.style ?? {},
    };
  }
  return { defaults: {}, elements: els, states: {} };
}

// Build the before/after captures into a temp dir, then render the real report.
function render(outDir) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-demo-'));
  const beforeDir = path.join(work, 'before');
  const afterDir = path.join(work, 'after');
  const SURFACES = [
    ['home@900', homeMap, homeScreenshot],
    ['sibling-insertion@900', insertionMap, insertionScreenshot],
    ['duplicate-insertion@900', duplicateInsertionMap, duplicateInsertionScreenshot],
  ];
  for (const [surface, map, screenshot] of SURFACES) {
    writeCapture(beforeDir, surface, map('base'), screenshot('base'));
    writeCapture(afterDir, surface, map('head'), screenshot('head'));
  }
  // pricing exists only on the head → reported as a new surface.
  writeCapture(afterDir, 'pricing@900', pricingMap(), pricingScreenshot());

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const res = generateStyleMapReport({ beforeDir, afterDir, outDir, includeContent: true });
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
