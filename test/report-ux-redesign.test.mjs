// Report UX redesign: verdict first, human labels, one primary crop + highlight toggle,
// green certification hidden, product-state warning above the fold, no mid-report glossary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { generateStyleMapReport } from '../dist/index.js';
import { humanLabel, summarizePropsWithFollowOns } from '../dist/change-groups.js';

function solidPng(w, h, rgb = [200, 200, 200]) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgb[0];
    png.data[i + 1] = rgb[1];
    png.data[i + 2] = rgb[2];
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

function writeCapture(dir, key, map, png) {
  fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(map));
  fs.writeFileSync(path.join(dir, `${key}.png`), png);
}

function tmpDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ux-'));
  const beforeDir = path.join(root, 'before');
  const afterDir = path.join(root, 'after');
  const outDir = path.join(root, 'out');
  fs.mkdirSync(beforeDir);
  fs.mkdirSync(afterDir);
  fs.mkdirSync(outDir);
  return { root, beforeDir, afterDir, outDir };
}

test('humanLabel title-cases the marker class before the selector', () => {
  assert.equal(humanLabel('html > body > div:nth-child(1)', 'page-title'), 'Page title');
  assert.equal(humanLabel('html > body > h1', ''), 'h1');
});

test('currentColor follow-ons nest under color rather than remaining as peer props', () => {
  const rows = summarizePropsWithFollowOns([
    { prop: 'color', before: 'rgb(0, 0, 0)', after: 'rgb(255, 0, 0)' },
    { prop: 'caret-color', before: 'rgb(0, 0, 0)', after: 'rgb(255, 0, 0)' },
    { prop: 'outline-color', before: 'rgb(0, 0, 0)', after: 'rgb(255, 0, 0)' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].prop, 'color');
  assert.equal(rows[0].followOns?.length, 2);
  assert.deepEqual(rows[0].followOns.map((f) => f.prop).sort(), ['caret-color', 'outline-color']);
});

test('report skeleton is verdict-first with one primary crop and collapsed evidence', () => {
  const { root, beforeDir, afterDir, outDir } = tmpDirs();
  const el = (color) => ({
    'html > body > div:nth-child(1)': {
      tag: 'div',
      cls: 'page-title',
      rect: [10, 10, 200, 40],
      style: { color },
    },
  });
  writeCapture(
    beforeDir,
    'home@900',
    { defaults: {}, elements: el('rgb(156, 163, 175)'), states: {}, tokens: { '--muted': 'rgb(156, 163, 175)' } },
    solidPng(900, 400),
  );
  writeCapture(
    afterDir,
    'home@900',
    { defaults: {}, elements: el('rgb(37, 99, 235)'), states: {}, tokens: { '--accent': 'rgb(37, 99, 235)' } },
    solidPng(900, 400, [37, 99, 235]),
  );

  const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');

  // Verdict first — before any Certification / Evidence fold.
  assert.match(md, /\*\*1 change needs review\*\*/);
  assert.ok(md.indexOf('**1 change needs review**') < md.indexOf('## Changes'));
  assert.doesNotMatch(md.slice(0, md.indexOf('## Changes')), /\*\*Certification\*\*/);

  // Human label before selector.
  assert.match(md, /\*\*Page title\*\* `div\.page-title`/);

  // No mid-report glossary.
  assert.doesNotMatch(md, /Surface base.*=.*product UI state/);

  // One primary before/after; highlight overlay is optional/collapsed.
  assert.match(md, /!\[before ◀ │ ▶ after\]\(crops\/.+-composite\.png\)/);
  assert.match(md, /<summary>Show highlight overlay<\/summary>/);
  // Annotated must not appear as a peer carousel above the fold.
  const beforeDetails = md.slice(0, md.indexOf('<summary>Show highlight overlay</summary>'));
  assert.doesNotMatch(beforeDetails, /-annotated\.png/);
  assert.doesNotMatch(beforeDetails, /-zoom\.png/);

  // Nothing else line when only this restyle exists.
  assert.match(md, /Nothing else — no other element or inventory changes/);

  // Evidence collapsed by default.
  assert.match(md, /<summary>Evidence \(warnings & failures\)<\/summary>/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('proven product-state identity does not emit the above-the-fold warning', () => {
  const { root, beforeDir, afterDir, outDir } = tmpDirs();
  const state = { id: 'home-ready', revision: 'v1' };
  const el = (color) => ({
    'html > body > button.cta': {
      tag: 'button',
      cls: 'cta',
      rect: [10, 10, 120, 32],
      style: { color },
    },
  });
  for (const [dir, color] of [
    [beforeDir, 'rgb(0, 0, 0)'],
    [afterDir, 'rgb(255, 0, 0)'],
  ]) {
    writeCapture(
      dir,
      'home@900',
      {
        defaults: {},
        elements: el(color),
        states: {},
        metadata: { productState: state },
      },
      solidPng(900, 400),
    );
  }
  const result = generateStyleMapReport({
    beforeDir,
    afterDir,
    outDir,
    requireStateIdentity: true,
  });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  assert.equal(result.comparison.status, 'comparable');
  assert.doesNotMatch(md, /Product-state identity unproven/);
  assert.match(md, /\*\*1 change needs review\*\*/);
  fs.rmSync(root, { recursive: true, force: true });
});
