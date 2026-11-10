import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { generateStructuralStyleMapReportForTesting as generateReport } from '../dist/report.js';
import { decodeSectionMeta } from '../dist/report/section-meta.js';
import { makeMap, mkTmp, rmTmp, solidPng, writeCapture } from './helpers.mjs';

const solidPngFor = (side) => solidPng(1280, 400, side === 'before' ? [240, 240, 240] : [230, 230, 250]);

// RV2-03: only one side of this pair is over the 300 KB per-file cap (noise does not compress).
// Halving that side alone would show a blur difference the change did not cause.
function page(noisy) {
  const png = new PNG({ width: 1280, height: 900 });
  let seed = 7;
  for (let i = 0; i < png.data.length; i += 4) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    png.data[i] = noisy ? seed >>> 24 : 230;
    png.data[i + 1] = noisy ? (seed >>> 16) & 255 : 230;
    png.data[i + 2] = noisy ? (seed >>> 8) & 255 : 230;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

test('a pair and its whole pages are scaled together, never one side alone (RV2-03)', (t) => {
  const root = mkTmp('styleproof-pair-scale-');
  t.after(() => rmTmp(root));
  for (const side of ['before', 'after']) {
    const map = makeMap({
      elements: {
        'body > section': {
          tag: 'section',
          cls: 'hero',
          rect: [0, 0, 1280, 600],
          style: { 'background-color': side === 'before' ? 'rgb(1, 2, 3)' : 'rgb(200, 2, 3)' },
        },
      },
    });
    writeCapture(path.join(root, side), 'home@1280', map, page(side === 'before'));
  }
  const result = generateReport({
    beforeDir: path.join(root, 'before'),
    afterDir: path.join(root, 'after'),
    outDir: path.join(root, 'report'),
  });
  const size = (file) => {
    const png = PNG.sync.read(fs.readFileSync(path.join(root, 'report', 'crops', file)));
    return `${png.width}x${png.height}`;
  };
  assert.equal(size('home-1280-1-before.png'), size('home-1280-1-after.png'));
  assert.equal(size('home-1280-page-base.png'), size('home-1280-page-head.png'));
  assert.notEqual(size('home-1280-1-after.png'), '1280x624', 'the pair was downscaled to fit');
  // The notice counts the crops a reviewer compares, not the optional whole pages.
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  assert.match(md, /_2 crop\(s\) downscaled/);
  // The section data records the size written, so report.html shows the halved crop at its own size (RV19-06).
  const meta = md
    .split('\n')
    .map(decodeSectionMeta)
    .find((m) => m?.pairs.length);
  const pair = meta.pairs.find((p) => p.after === 'crops/home-1280-1-after.png');
  assert.equal(`${pair.width}x${pair.height}`, size('home-1280-1-after.png'));
  const html = fs.readFileSync(path.join(root, 'report', 'report.html'), 'utf8');
  const [w, h] = size('home-1280-1-after.png').split('x');
  assert.match(
    html,
    new RegExp(`<img class="shot after" src="data:image/png;base64,[^"]+" width="${w}" height="${h}"`),
  );
});

test('pair alt text escapes element text once (RV2-18)', (t) => {
  const root = mkTmp('styleproof-pair-alt-');
  t.after(() => rmTmp(root));
  for (const side of ['before', 'after']) {
    const style = { color: side === 'before' ? 'rgb(0, 0, 0)' : 'rgb(200, 0, 0)' };
    const elements = {
      'body > button': { tag: 'button', cls: 'btn', text: '<b>x</b>', rect: [20, 20, 300, 40], style },
    };
    writeCapture(path.join(root, side), 'home@1280', makeMap({ elements }), solidPngFor(side));
  }
  const result = generateReport({
    beforeDir: path.join(root, 'before'),
    afterDir: path.join(root, 'after'),
    outDir: path.join(root, 'report'),
  });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  assert.match(md, /alt="Before: the &lt;b&gt;x&lt;\/b&gt; button"/);
  assert.doesNotMatch(md, /&amp;lt;/);
});
