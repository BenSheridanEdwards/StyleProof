#!/usr/bin/env node
/**
 * One-shot: capture the real demo button (base vs a restyle of rest/hover/focus/active)
 * and write a StyleProof report to docs/readme/live-report/.
 * This is the report the README shows. It is not the synthetic docs/demo/ fixture.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { captureStyleMap, generateStyleMapReport } from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const demo = 'file://' + path.join(root, 'example/demo/index.html') + '?state=loaded';
const outDir = path.join(root, 'docs/readme/live-report');
const HEAD_CSS = `
  .btn { background: rgb(220, 38, 38); border-color: rgb(248, 113, 113); color: rgb(255, 255, 255); }
  .btn:hover { background: rgb(7, 9, 12); color: rgb(252, 165, 165); border-color: rgb(252, 165, 165); }
  .btn:focus { outline-color: rgb(252, 165, 165); border-color: rgb(254, 202, 202); }
  .btn:active { background: rgb(153, 27, 27); border-color: rgb(127, 29, 29); }
`;

async function captureOne(page, url, extraCss) {
  await page.goto(url, { waitUntil: 'load' });
  if (extraCss) await page.addStyleTag({ content: extraCss });
  const map = await captureStyleMap(page);
  const png = await page.screenshot({ type: 'png', fullPage: false });
  return { map, png };
}

function writeCapture(dir, surface, map, png) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${surface}.json.gz`), gzipSync(JSON.stringify(map)));
  fs.writeFileSync(path.join(dir, `${surface}.png`), png);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-live-'));
const beforeDir = path.join(work, 'before');
const afterDir = path.join(work, 'after');

const baseAtom = await captureOne(page, demo);
writeCapture(beforeDir, 'demo-button@900', baseAtom.map, baseAtom.png);
const headAtom = await captureOne(page, demo, HEAD_CSS);
writeCapture(afterDir, 'demo-button@900', headAtom.map, headAtom.png);

await browser.close();

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const res = generateStyleMapReport({
  beforeDir,
  afterDir,
  outDir,
  foldDetailsAt: Infinity,
});
fs.rmSync(res.reportJsonPath, { force: true });
fs.rmSync(work, { recursive: true, force: true });
console.log('wrote', path.relative(root, res.reportMdPath));
console.log('findings', res.totalFindings, 'changed', res.changedSurfaces);
