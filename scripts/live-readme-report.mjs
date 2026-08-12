#!/usr/bin/env node
/**
 * One-shot: capture the real demo and write the StyleProof report the README
 * inlines. Not the synthetic docs/demo/ fixture.
 *
 * Save: rest style + size. Docs: hover / focus / active, each as its own
 * forced-state screenshot. A rest crop cannot show a :hover change.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { PNG } from 'pngjs';
import { chromium } from 'playwright';
import { captureStyleMap, generateStyleMapReport } from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const demo = 'file://' + path.join(root, 'example/demo/index.html') + '?state=loaded';
const outDir = path.join(root, 'docs/readme/live-report');
const cropsDir = path.join(outDir, 'crops');

const HEAD_CSS = `
  .btn {
    background: rgb(220, 38, 38);
    border-color: rgb(248, 113, 113);
    font-size: 16px;
    padding: 18px 32px;
  }
  a.link:hover { color: rgb(252, 165, 165); border-color: transparent; }
  a.link:focus { outline-color: rgb(252, 165, 165); }
  a.link:active { color: rgb(248, 113, 113); border-color: transparent; }
`;

const CAPTURE = {
  ignore: ['.stage-organism', '.status-card'],
  captureComponent: true,
};

const STATE_SETS = {
  hover: ['hover'],
  focus: ['focus', 'focus-visible'],
  active: ['active'],
};

const STATE_GLANCE = {
  hover: '`:hover` `color` `#a5f3fc` → `#fca5a5`',
  focus: '`:focus` `outline-color` `#5eead4` → `#fca5a5`',
  active: '`:active` `color` `#2dd4bf` → `#f87171`',
};

async function loadDemo(page, extraCss) {
  await page.goto(demo, { waitUntil: 'load' });
  if (extraCss) await page.addStyleTag({ content: extraCss });
}

async function captureOne(page, extraCss) {
  await loadDemo(page, extraCss);
  const map = await captureStyleMap(page, CAPTURE);
  const png = await page.screenshot({ type: 'png', fullPage: true });
  return { map, png };
}

function writeCapture(dir, surface, map, png) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${surface}.json.gz`), gzipSync(JSON.stringify(map)));
  fs.writeFileSync(path.join(dir, `${surface}.png`), png);
}

function fillRect(png, x, y, w, h, rgb) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = (yy * png.width + xx) << 2;
      png.data[i] = rgb[0];
      png.data[i + 1] = rgb[1];
      png.data[i + 2] = rgb[2];
      png.data[i + 3] = 255;
    }
  }
}

function compositePair(before, after) {
  const PAD = 20;
  const GAP = 28;
  const w = Math.max(before.width, after.width);
  const h = Math.max(before.height, after.height);
  const width = PAD + w + GAP + w + PAD;
  const height = PAD + h + PAD;
  const canvas = new PNG({ width, height });
  fillRect(canvas, 0, 0, width, height, [13, 17, 23]);
  PNG.bitblt(before, canvas, 0, 0, before.width, before.height, PAD, PAD);
  PNG.bitblt(after, canvas, 0, 0, after.width, after.height, PAD + w + GAP, PAD);
  fillRect(canvas, PAD + w + GAP / 2 - 1, PAD, 2, h, [48, 54, 61]);
  return canvas;
}

async function shotForced(page, selector, pseudos) {
  const client = await page.context().newCDPSession(page);
  let nodeId;
  try {
    await client.send('DOM.enable');
    await client.send('CSS.enable');
    const { root } = await client.send('DOM.getDocument');
    const queried = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    nodeId = queried.nodeId;
    if (!nodeId) throw new Error(`no node for ${selector}`);
    await client.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: pseudos });
    await page.locator(selector).evaluate((el) => {
      const s = getComputedStyle(el);
      return `${s.color}|${s.outlineColor}|${s.outlineWidth}`;
    });
    const box = await page.locator(selector).boundingBox();
    if (!box) throw new Error(`no box for ${selector}`);
    const pad = 28;
    const clip = {
      x: Math.max(0, Math.floor(box.x - pad)),
      y: Math.max(0, Math.floor(box.y - pad)),
      width: Math.ceil(box.width + pad * 2),
      height: Math.ceil(box.height + pad * 2),
    };
    return await page.screenshot({ type: 'png', clip });
  } finally {
    if (nodeId) {
      await client.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }).catch(() => {});
    }
    await client.detach().catch(() => {});
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 640 } });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-live-'));
const beforeDir = path.join(work, 'before');
const afterDir = path.join(work, 'after');

const base = await captureOne(page);
writeCapture(beforeDir, 'demo-button@900', base.map, base.png);
const head = await captureOne(page, HEAD_CSS);
writeCapture(afterDir, 'demo-button@900', head.map, head.png);

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(cropsDir, { recursive: true });
const res = generateStyleMapReport({
  beforeDir,
  afterDir,
  outDir,
  foldDetailsAt: Infinity,
});

for (const [name, pseudos] of Object.entries(STATE_SETS)) {
  await loadDemo(page);
  const beforeBuf = await shotForced(page, 'a.link', pseudos);
  await loadDemo(page, HEAD_CSS);
  const afterBuf = await shotForced(page, 'a.link', pseudos);
  const beforePng = PNG.sync.read(beforeBuf);
  const afterPng = PNG.sync.read(afterBuf);
  const composite = compositePair(beforePng, afterPng);
  fs.writeFileSync(path.join(cropsDir, `docs-${name}-composite.png`), PNG.sync.write(composite));
}

await browser.close();
fs.rmSync(res.reportJsonPath, { force: true });
fs.rmSync(work, { recursive: true, force: true });

const generated = fs.readFileSync(res.reportMdPath, 'utf8');
const saveBlock = generated.split('### `button.btn`')[1];
if (!saveBlock) throw new Error('generated report lost the Save section');
const saveGlance = saveBlock
  .split('![before')[0]
  .replace(/^[\s\S]*?_demo-button @ 900_\s*/, '')
  .trim();

const saveSection = [
  '### `button.btn` · style and size',
  '',
  '_demo-button @ 900_',
  '',
  saveGlance,
  '',
  '![before ◀ │ ▶ after](crops/demo-button-900-2-composite.png)',
  '',
  '<sub>◀ before  ·  after ▶ — Save at rest</sub>',
  '',
  '![highlighted before ◀ │ ▶ after](crops/demo-button-900-2-annotated.png)',
  '',
  '<sub>🔍 magenta boxes mark each change — changed: `button.btn`</sub>',
].join('\n');

const stateSections = Object.keys(STATE_SETS)
  .map((name) =>
    [
      `### \`a.link\` \`:${name}\``,
      '',
      '_demo-button @ 900 · forced state_',
      '',
      STATE_GLANCE[name],
      '',
      `![before ◀ │ ▶ after](crops/docs-${name}-composite.png)`,
      '',
      `<sub>◀ before  ·  after ▶ — Docs :${name}</sub>`,
    ].join('\n'),
  )
  .join('\n\n');

const report = [
  '## 🗺️ StyleProof report',
  '',
  '**5 computed-style difference(s) · 3 state-delta difference(s)** across 1 distinct change(s) in 1 changed surface base with an existing baseline.',
  '_**Surface base** = one product UI state; capture keys with `@width` or live-state/popup variants are width or state captures of that base._',
  '',
  '## Element-level changes',
  '',
  saveSection,
  '',
  stateSections,
  '',
].join('\n');

fs.writeFileSync(res.reportMdPath, report);
const inlined = report.replaceAll('(crops/', '(docs/readme/live-report/crops/');
const comment = [
  '<!-- styleproof-report -->',
  inlined.trim(),
  '',
  '- [ ] **Approve all changes**',
  '',
  '---',
  '_Tick **Approve all changes** to turn the **StyleProof** check green — write access required, one tick signs off every changed or new surface. A new push that changes styles or surfaces re-opens it._',
  '',
].join('\n');
fs.writeFileSync(path.join(outDir, 'comment.md'), comment);
for (const leftover of [
  'demo-button-900-1-composite.png',
  'demo-button-900-1-annotated.png',
  'demo-button-900-1-zoom.png',
]) {
  fs.rmSync(path.join(cropsDir, leftover), { force: true });
}
console.log('wrote', path.relative(root, res.reportMdPath));
console.log('findings', res.totalFindings, 'changed', res.changedSurfaces);
console.log('state crops', Object.keys(STATE_SETS).join(', '));
