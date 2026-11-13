import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { PNG } from 'pngjs';
import { generateStructuralStyleMapReportForTesting as generateStyleMapReport } from '../dist/report.js';
import { makeMap, writeCapture, mkTmp, rmTmp } from './helpers.mjs';

const element = 'body > button:nth-child(1)';
const rect = [210, 230, 80, 40];
function capture(color) {
  const png = new PNG({ width: 600, height: 500 });
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      png.data.set([x % 256, y % 256, (x + y) % 256, 255], i);
      if (x >= 210 && x < 290 && y >= 230 && y < 270) png.data.set([...color, 255], i);
    }
  }
  return png;
}
function assertPixels(file, source) {
  const png = PNG.sync.read(fs.readFileSync(file));
  assert.equal(png.width, 320);
  assert.equal(png.height, 180);
  // The 80x40 element is centred at (250,250); the 320x180 context starts at (90,160).
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      const j = ((y + 160) * source.width + x + 90) * 4;
      assert.deepEqual(png.data.subarray(i, i + 4), source.data.subarray(j, j + 4), `pixel ${x},${y}`);
    }
  }
}

test('report writes separate clean resting and hover crops with exact source pixels', (t) => {
  const root = mkTmp();
  t.after(() => rmTmp(root));
  const beforeDir = path.join(root, 'before');
  const afterDir = path.join(root, 'after');
  const outDir = path.join(root, 'out');
  const sources = [capture([20, 40, 60]), capture([80, 100, 120]), capture([10, 30, 50]), capture([70, 90, 110])];
  for (const [index, dir] of [beforeDir, afterDir].entries()) {
    const map = makeMap({
      elements: { [element]: { tag: 'button', cls: 'cta', rect, style: { color: index ? 'blue' : 'red' } } },
      states: { [element]: { hover: { [element]: { color: index ? 'green' : 'yellow' } } } },
    });
    writeCapture(dir, 'index@600', map, PNG.sync.write(sources[index]));
    fs.writeFileSync(path.join(dir, 'index@600.hover.png'), PNG.sync.write(sources[index + 2]));
  }
  const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  assert.match(md, /\| Before \| After \|/);
  assert.match(
    md,
    /\| <img src="crops\/[^"]+-before.png" width="340" alt="Before: [^"]+"> \| <img src="crops\/[^"]+-after.png" width="340" alt="After: [^"]+"> \|/,
  );
  assert.match(md, /\*\*While hovered\*\*/);
  assert.doesNotMatch(md, /composite|annotated|zoom|◀|Show highlight overlay/);
  const region = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8')).surfaces[0].regions[0];
  assert.deepEqual(Object.keys(region.images).sort(), ['after', 'before']);
  assert.deepEqual(Object.keys(region.stateImages.hover).sort(), ['after', 'before']);
  assert.notEqual(region.images.before, region.stateImages.hover.before);
  for (const [images, offset] of [
    [region.images, 0],
    [region.stateImages.hover, 2],
  ]) {
    assertPixels(path.join(outDir, images.before), sources[offset]);
    assertPixels(path.join(outDir, images.after), sources[offset + 1]);
  }
  // Two clean pairs, the Where map (the only image with boxes), and the whole pages report.html shows on demand.
  const names = fs.readdirSync(path.join(outDir, 'crops')).sort();
  assert.equal(names.filter((n) => /-\d+-(before|after)\.png$/.test(n)).length, 4);
  assert.equal(names.filter((n) => n.endsWith('-where.png')).length, 1);
  assert.deepEqual(
    names.filter((n) => n.includes('-page')),
    [
      'index-600-page-base.png',
      'index-600-page-head.png',
      'index-600-page-hover-base.png',
      'index-600-page-hover-head.png',
    ],
  );
  // The whole pages are the captures themselves, byte-for-byte in pixels.
  for (const [name, source] of [
    ['index-600-page-base.png', sources[0]],
    ['index-600-page-head.png', sources[1]],
    ['index-600-page-hover-base.png', sources[2]],
    ['index-600-page-hover-head.png', sources[3]],
  ]) {
    const png = PNG.sync.read(fs.readFileSync(path.join(outDir, 'crops', name)));
    assert.ok(png.data.equals(source.data), `${name} equals its capture`);
  }
});
