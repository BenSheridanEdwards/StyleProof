#!/usr/bin/env node
/**
 * One-shot: capture the real demo and write the StyleProof report the README
 * inlines. Not a stitched gallery. The product report is the receipt.
 *
 * Save: rest style + size. Docs: hover / focus / active from state-layer shots.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { captureStyleMap, captureStateLayerScreenshots, generateStyleMapReport } from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const demo = 'file://' + path.join(root, 'example/demo/index.html') + '?state=loaded';
const outDir = path.join(root, 'docs/readme/live-report');

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

async function captureOne(page, extraCss) {
  await page.goto(demo, { waitUntil: 'load' });
  if (extraCss) await page.addStyleTag({ content: extraCss });
  const map = await captureStyleMap(page, CAPTURE);
  const png = await page.screenshot({ type: 'png', fullPage: true });
  return { map, png };
}

function writeCapture(dir, surface, map, png) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${surface}.json.gz`), gzipSync(JSON.stringify(map)));
  fs.writeFileSync(path.join(dir, `${surface}.png`), png);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 640 } });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-live-'));
const beforeDir = path.join(work, 'before');
const afterDir = path.join(work, 'after');
const surface = 'demo-button@900';

const base = await captureOne(page);
writeCapture(beforeDir, surface, base.map, base.png);
await captureStateLayerScreenshots(page, path.join(beforeDir, surface), CAPTURE);

const head = await captureOne(page, HEAD_CSS);
writeCapture(afterDir, surface, head.map, head.png);
await captureStateLayerScreenshots(page, path.join(afterDir, surface), CAPTURE);

await browser.close();

fs.rmSync(outDir, { recursive: true, force: true });
const res = generateStyleMapReport({
  beforeDir,
  afterDir,
  outDir,
  foldDetailsAt: Infinity,
  minHeight: 72,
  minWidth: 240,
  zoomBelow: 0,
});
fs.rmSync(res.reportJsonPath, { force: true });
fs.rmSync(work, { recursive: true, force: true });

const report = fs.readFileSync(res.reportMdPath, 'utf8');
const inlined = report.replaceAll('(crops/', '(docs/readme/live-report/crops/');
const comment = [
  '<!-- styleproof-report -->',
  inlined.trim(),
  '',
  '- [ ] **Approve all changes**',
  '',
  '---',
  '_Tick **Approve all changes** to turn the **StyleProof** check green — write access required, one tick signs it off. A new push that changes styles or surfaces re-opens it._',
  '',
].join('\n');
fs.writeFileSync(path.join(outDir, 'comment.md'), comment);
console.log('wrote', path.relative(root, res.reportMdPath));
console.log('findings', res.totalFindings, 'changed', res.changedSurfaces);
const crops = fs.existsSync(path.join(outDir, 'crops')) ? fs.readdirSync(path.join(outDir, 'crops')) : [];
console.log('crops', crops.join(', '));
