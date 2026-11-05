import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { generateStructuralStyleMapReportForTesting as generateReport } from '../dist/report.js';
import { makeMap, pairFixture, rmTmp, solidPng } from './helpers.mjs';

const owners = [1, 2, 3].map((index) => `body > article:nth-child(${index}) > h2`);
const originalBoxes = [
  { x: 28, y: 28, w: 174, h: 59 },
  { x: 28, y: 158, w: 174, h: 59 },
  { x: 28, y: 288, w: 174, h: 59 },
];

function fixture(context, { states = false, options = {} } = {}) {
  const map = (head) => ({
    ...makeMap({
      elements: Object.fromEntries(
        owners.map((owner, index) => [
          owner,
          {
            tag: 'h2',
            cls: 'card-title',
            rect: [40, 40 + index * 130, 150, 35],
            style: states ? {} : { color: head ? 'red' : 'blue' },
          },
        ]),
      ),
      states: states
        ? Object.fromEntries(
            owners.map((owner) => [
              owner,
              {
                hover: { [owner]: { 'background-color': head ? 'red' : 'blue' } },
                focus: { [owner]: { 'outline-color': head ? 'black' : 'white' } },
              },
            ]),
          )
        : {},
    }),
    viewport: { width: 600, height: 400 },
  });
  const directories = pairFixture({
    surface: 'contract@600',
    before: map(false),
    after: map(true),
    beforePng: solidPng(600, 1800),
    afterPng: solidPng(600, 1800),
  });
  context.after(() => rmTmp(directories.root));
  if (states)
    for (const directory of [directories.beforeDir, directories.afterDir])
      for (const state of ['hover', 'focus'])
        fs.writeFileSync(path.join(directory, `contract@600.${state}.png`), solidPng(600, 1800));
  const result = generateReport({ ...directories, ...options });
  return { directories, report: JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8')) };
}

for (const states of [false, true]) {
  test(`${states ? 'state' : 'resting'} combined sections retain main's three region anchors and reuse shown crop files`, (context) => {
    const { report, directories } = fixture(context, { states });
    const surface = report.surfaces[0];
    assert.deepEqual(
      surface.regions.map(({ paths, before, after }) => ({ paths, before, after })),
      owners.map((owner, index) => ({ paths: [owner], before: originalBoxes[index], after: originalBoxes[index] })),
    );
    assert.equal(surface.sections.length, 1);
    const section = surface.sections[0];
    assert.deepEqual(section.regionIndexes, [0, 1, 2]);
    assert.deepEqual(section.paths, owners);
    assert.deepEqual(
      section.elements,
      owners.map((elementPath) => ({ path: elementPath })),
    );
    assert.deepEqual(section.before, { x: 28, y: 28, w: 174, h: 319 });
    for (const region of surface.regions) {
      assert.deepEqual(region.images, section.images);
      assert.equal(region.elements, undefined);
      if (states) assert.deepEqual(region.stateImages, section.stateImages);
    }
    const images = states
      ? Object.values(section.stateImages).flatMap((images) => Object.values(images))
      : Object.values(section.images);
    assert.deepEqual(
      fs.readdirSync(path.join(directories.outDir, 'crops')).sort(),
      [...new Set(images.map((image) => path.basename(image)))].sort(),
      'legacy anchors must not write additional crops',
    );
    assert.equal(surface.findings.length, states ? 6 : 3);
  });
}

test('zero crop cap keeps main union geometry and adds its combined-section membership', (context) => {
  const { report } = fixture(context, { options: { maxCrops: 0 } });
  const surface = report.surfaces[0];
  assert.equal(surface.regions.length, 1);
  assert.deepEqual(surface.regions[0].paths, owners);
  assert.deepEqual(surface.regions[0].before, { x: 28, y: 28, w: 174, h: 319 });
  assert.deepEqual(surface.sections[0].regionIndexes, [0]);
  assert.deepEqual(surface.regions[0].images, surface.sections[0].images);
});

test('a combined section keeps all legacy anchors and budget omission fields when no image fits', (context) => {
  const { report, directories } = fixture(context, { options: { maxCropFiles: 0 } });
  assert.equal(report.surfaces[0].regions.length, 3);
  for (const region of report.surfaces[0].regions) {
    assert.deepEqual(region.images, {});
    assert.equal(region.cropOmitted, 'budget');
  }
  assert.equal(report.surfaces[0].sections[0].cropOmitted, 'budget');
  assert.deepEqual(fs.readdirSync(path.join(directories.outDir, 'crops')), []);
});

test('nested mixed changes retain main outermost region paths and add complete section coverage', (context) => {
  const parent = 'body > section';
  const child = `${parent} > h2`;
  const map = (head) =>
    makeMap({
      elements: {
        [parent]: { tag: 'section', cls: 'parent', rect: [20, 20, 300, 150], style: { color: head ? 'red' : 'blue' } },
        [child]: { tag: 'h2', cls: 'child', rect: [30, 30, 100, 30], style: { color: head ? 'green' : 'blue' } },
      },
    });
  const directories = pairFixture({
    surface: 'nested@600',
    before: map(false),
    after: map(true),
    beforePng: solidPng(600, 400),
    afterPng: solidPng(600, 400),
  });
  context.after(() => rmTmp(directories.root));
  const result = generateReport(directories);
  const surface = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8')).surfaces[0];
  assert.deepEqual(
    surface.regions.map(({ paths, before, after }) => ({ paths, before, after })),
    [{ paths: [parent], before: { x: 8, y: 8, w: 324, h: 174 }, after: { x: 8, y: 8, w: 324, h: 174 } }],
  );
  assert.deepEqual(surface.sections[0].paths, [parent, child]);
  assert.deepEqual(surface.sections[0].regionIndexes, [0]);
  assert.equal(surface.sections[0].elements, undefined);
});

test('main regions stay empty when only a changed descendant of a hidden anchor is exposed', (context) => {
  const parent = 'body > section';
  const child = `${parent} > h2`;
  const map = (head) =>
    makeMap({
      elements: {
        [parent]: {
          tag: 'section',
          cls: 'parent',
          rect: [20, 20, 300, 150],
          style: { color: head ? 'red' : 'blue', visibility: 'hidden' },
        },
        [child]: {
          tag: 'h2',
          cls: 'child',
          rect: [30, 30, 100, 30],
          style: { color: head ? 'green' : 'blue', visibility: 'visible' },
        },
      },
    });
  const directories = pairFixture({
    surface: 'hidden-parent@600',
    before: map(false),
    after: map(true),
    beforePng: solidPng(600, 400),
    afterPng: solidPng(600, 400),
  });
  context.after(() => rmTmp(directories.root));
  const result = generateReport(directories);
  const surface = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8')).surfaces[0];
  assert.deepEqual(surface.regions, []);
  assert.ok(surface.sections.some((section) => section.paths.includes(child) && section.images.composite));
  assert.ok(surface.sections.every((section) => section.regionIndexes.length === 0));
});

test('a main cap-collapsed region links all displayed sections and chooses an exposed crop', (context) => {
  const map = (head) =>
    makeMap({
      elements: Object.fromEntries(
        owners.map((owner, index) => [
          owner,
          {
            tag: 'h2',
            cls: 'card-title',
            rect: [40, 40 + index * 130, 150, 35],
            style: {
              color: head ? ['red', 'green', 'black'][index] : 'blue',
              ...(index === 0 ? { visibility: 'hidden' } : {}),
            },
          },
        ]),
      ),
    });
  const directories = pairFixture({
    surface: 'hidden-cap@600',
    before: map(false),
    after: map(true),
    beforePng: solidPng(600, 600),
    afterPng: solidPng(600, 600),
  });
  context.after(() => rmTmp(directories.root));
  const result = generateReport({ ...directories, maxCrops: 2 });
  const surface = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8')).surfaces[0];
  assert.equal(surface.regions.length, 1);
  assert.deepEqual(surface.regions[0].paths, owners);
  assert.deepEqual(surface.regions[0].before, { x: 28, y: 28, w: 174, h: 319 });
  assert.equal(surface.sections.length, 3);
  assert.ok(surface.sections.every((section) => section.regionIndexes.length === 1 && section.regionIndexes[0] === 0));
  assert.deepEqual(surface.regions[0].images, surface.sections.find((section) => section.images.composite).images);
  assert.equal(surface.regions[0].visualEvidence, undefined);
});
