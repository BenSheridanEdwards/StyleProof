// QA14-02: forced-state rows under "Show the CSS" keep the approved preview's form in report.html:
// a colour swatch beside each colour value, and follower rows read "(follows `color`)". The shop
// fixture (a real three-page capture) had 96 swatches in the approved round-5 and round-13 reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateStyleMapReport } from '../dist/report.js';
import { MAP_MANIFEST } from '../dist/map-store.js';
import { fixtureCompatibilityKey, mkTmp, rmTmp } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('forced-state rows keep their colour swatches and "(follows `color`)" followers (QA14-02)', (t) => {
  const root = mkTmp('styleproof-state-swatches-');
  t.after(() => rmTmp(root));
  // The committed manifests carry no environment key; both sides get the same one here.
  const [beforeDir, afterDir] = ['base', 'head'].map((side) => {
    const dir = path.join(root, side);
    fs.cpSync(path.join(here, 'fixtures/report-real-shop', side), dir, { recursive: true });
    const manifest = path.join(dir, MAP_MANIFEST);
    const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    data.compatibilityKey = fixtureCompatibilityKey('report-real-shop');
    fs.writeFileSync(manifest, JSON.stringify(data));
    return dir;
  });
  const result = generateStyleMapReport({ beforeDir, afterDir, outDir: path.join(root, 'report') });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  const html = fs.readFileSync(path.join(root, 'report', 'report.html'), 'utf8');
  assert.equal((html.match(/class="sw"/g) ?? []).length, 96, 'every colour value in the CSS folds has its swatch');
  // The buttons' own hover and focus: both colour rows carry a swatch on each side.
  const buttons = /<section class="change" id="add-to-basket-buttons">[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
  assert.equal((buttons.match(/class="sw"/g) ?? []).length, 4, 'the Add to basket buttons fold has its 4 swatches');
  assert.doesNotMatch(md, /_\(currentColor\)_/, 'followers never read "(currentColor)"');
  assert.match(md, /`:checked caret-color` \(follows `color`\)/, 'state followers read "(follows `color`)"');
});
