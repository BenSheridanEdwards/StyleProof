import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { generateStructuralStyleMapReportForTesting as generateStyleMapReport } from '../dist/report.js';
import { ReportMarkdown } from '../dist/report/sections.js';
import { makeMap, rmTmp, solidPng, tmpDirs, writeCapture } from './helpers.mjs';
import { elementPath, render } from './report-grouped-fixture.mjs';

test('a crop cap merges different changes without discarding either value or inventing an identical-element list', () => {
  const { md: markdown, json: report } = render({ different: true, maxCrops: 1 });
  const surface = report.surfaces[0];
  assert.equal((markdown.match(/^### /gm) ?? []).length, 1);
  assert.equal(surface.regions.length, 1);
  assert.deepEqual(surface.regions[0].paths, [1, 2, 3].map(elementPath));
  assert.equal(surface.sections, undefined);
  assert.match(markdown, /#961e3c/);
  assert.match(markdown, /#008000/);
  assert.doesNotMatch(markdown, /Showing .* elements for the grouped change/);
  assert.equal(report.counts.style, 3);
});

test('an identical section keeps its representative when the legacy crop cap merges its three boxes', () => {
  const { md: markdown, json: report } = render({ maxCrops: 1 });
  const surface = report.surfaces[0];
  assert.equal(surface.regions.length, 1);
  assert.equal(surface.sections.length, 1);
  assert.deepEqual(surface.sections[0].regionIndexes, [0]);
  assert.deepEqual(surface.regions[0].paths, [1, 2, 3].map(elementPath));
  assert.ok(surface.regions[0].after.h > surface.sections[0].after.h);
  assert.deepEqual(surface.regions[0].images, surface.sections[0].images);
  assert.match(markdown, /3 elements restyled/);
  assert.match(markdown, /Showing 1 of 3 elements/);
  assert.equal((markdown.match(/\(shown\)/g) ?? []).length, 1);
});

test('resting evidence remains linked when the image budget omits every state crop in its section', () => {
  const { md: markdown, json: report } = render({ states: true, restingChange: true, maxCropFiles: 2 });
  const surface = report.surfaces[0];
  const section = surface.sections[0];
  assert.ok(section.images.composite);
  assert.ok(markdown.includes(section.images.composite));
  assert.equal(section.stateImages, undefined);
  assert.equal((markdown.match(/Crop omitted:/g) ?? []).length, 2);
  assert.equal(report.cropBudget.files, 2);
  assert.equal(report.cropBudget.omitted, 2);
  assert.equal(report.counts.style, 3);
  assert.equal(report.counts.state, 6);
  for (const region of surface.regions) assert.deepEqual(region.images, section.images);
  for (const property of ['color', 'background-color', 'outline-width']) {
    assert.equal(markdown.split(`| \`${property}\` |`).length - 1, 1, property);
  }
});

test('a JSON cap keeps complete groups in order and preserves a one-sided surface after the first omitted group', () => {
  const directories = tmpDirs();
  try {
    const screenshot = solidPng(390, 800);
    for (const [surface, count, red] of [
      ['first@390', 1, 120],
      ['second@390', 10, 150],
      ['third@390', 1, 180],
    ]) {
      for (const [directory, after] of [
        [directories.beforeDir, false],
        [directories.afterDir, true],
      ]) {
        const map = makeMap({
          elements: Object.fromEntries(
            Array.from({ length: count }, (_, index) => [
              `body > h2:nth-child(${index + 1})`,
              {
                tag: 'h2',
                cls: 'card-title',
                rect: [20, 20 + index * 60, 180, 20],
                style: { color: after ? `rgb(${red}, 0, 0)` : 'rgb(0, 0, 120)' },
              },
            ]),
          ),
        });
        writeCapture(directory, surface, map, screenshot);
      }
    }
    writeCapture(directories.afterDir, 'new@390', makeMap({ elements: {} }), screenshot);
    const read = (name, maxJsonBytes) => {
      const result = generateStyleMapReport({
        ...directories,
        outDir: path.join(directories.root, name),
        maxJsonBytes,
      });
      return {
        json: JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8')),
        markdown: fs.readFileSync(result.reportMdPath, 'utf8'),
      };
    };
    const full = read('full', Infinity).json;
    const skeleton = read('skeleton', 1).json;
    const first = full.surfaces.find((surface) => surface.representative === 'first@390');
    const firstGroupFits = {
      ...skeleton,
      surfaces: skeleton.surfaces.map((surface) => (surface.representative === 'first@390' ? first : surface)),
    };
    const budget = Buffer.byteLength(JSON.stringify(firstGroupFits, null, 2)) + 200;
    const { json: capped, markdown } = read('capped', budget);
    assert.ok(Buffer.byteLength(JSON.stringify(capped, null, 2)) <= budget);
    assert.deepEqual(capped.counts, full.counts);
    assert.deepEqual(capped.comparison, full.comparison);
    assert.deepEqual(
      capped.surfaces.find((surface) => surface.missing),
      full.surfaces.find((surface) => surface.missing),
    );
    const groups = capped.surfaces.filter((surface) => surface.findings);
    assert.deepEqual(
      groups.map((surface) => surface.findings.length),
      [1, 0, 0],
    );
    assert.deepEqual(
      groups.map((surface) => surface.findingsOmitted ?? 0),
      [0, 10, 1],
    );
    assert.equal(capped.findingsBudget.listed, 1);
    assert.equal(capped.findingsBudget.omitted, 11);
    for (const group of groups) {
      const original = full.surfaces.find((surface) => surface.representative === group.representative);
      assert.deepEqual(group.regions, original.regions);
      assert.deepEqual(group.sections, original.sections);
    }
    assert.match(markdown, /11 finding row\(s\) in 2 change group\(s\) omitted/);
  } finally {
    rmTmp(directories.root);
  }
});

test('JSON finding limits preserve grouped membership, crop omissions and comparison truth', () => {
  const options = { states: true, maxCropFiles: 0 };
  const full = render(options).json;
  for (const maxJsonBytes of [1, Buffer.byteLength(JSON.stringify(full, null, 2)) - 300]) {
    const { md: markdown, json: capped } = render({ ...options, maxJsonBytes });
    assert.deepEqual(capped.counts, full.counts);
    assert.deepEqual(capped.comparison, full.comparison);
    assert.deepEqual(capped.cropBudget, full.cropBudget);
    assert.deepEqual(capped.surfaces[0].regions, full.surfaces[0].regions);
    assert.deepEqual(capped.surfaces[0].sections, full.surfaces[0].sections);
    assert.deepEqual(capped.surfaces[0].findings, []);
    assert.equal(capped.surfaces[0].findingsOmitted, full.surfaces[0].findings.length);
    assert.equal(capped.findingsBudget.maxBytes, maxJsonBytes);
    assert.equal(capped.findingsBudget.listed, 0);
    assert.equal(capped.findingsBudget.omitted, capped.findingsBudget.total);
    assert.match(markdown, /omitted from report.json at its byte budget/);
    assert.match(markdown, /original diff input/);
  }
});

test('a Unicode report cap keeps an intact first section, remaining crop links and its evidence tail', () => {
  const report = new ReportMarkdown(1400);
  report.lines.push('# 变化报告');
  report.append(['', '## Cards']);
  report.detail(['', '### 标题一', 'First complete property table'], '- first — [crop](crops/first.png)');
  for (const name of ['second', 'third']) {
    report.detail(['', `### ${name}`, '属性变化'.repeat(500)], `- ${name} — [crop](crops/${name}.png)`);
  }
  report.finish(['', 'EVIDENCE: 身份尚未验证']);
  const markdown = report.lines.join('\n') + '\n';
  assert.ok(Buffer.byteLength(markdown) <= 1400);
  assert.match(markdown, /### 标题一\nFirst complete property table/);
  assert.ok(!markdown.includes('- first — [crop]'));
  assert.match(markdown, /summarized to keep this report renderable/);
  for (const name of ['second', 'third']) assert.ok(markdown.includes(`- ${name} — [crop](crops/${name}.png)`));
  assert.ok(!markdown.includes('属性变化'));
  assert.ok(markdown.endsWith('EVIDENCE: 身份尚未验证\n'));
});

test('a tight Unicode cap counts undisplayed sections and explicitly replaces oversized evidence', () => {
  for (const budget of [800, 500]) {
    const report = new ReportMarkdown(budget);
    report.lines.push('# 变化报告');
    const summaries = ['first', 'second', 'third'].map(
      (name) => `- ${name}: ${'标题'.repeat(28)} — [crop](crops/${name}.png)`,
    );
    for (const summary of summaries) report.detail(['', '### Full detail', '属性'.repeat(1000)], summary);
    report.finish(['', 'EVIDENCE: ' + '证据'.repeat(1000)]);
    const markdown = report.lines.join('\n') + '\n';
    const displayed = summaries.filter((summary) => markdown.includes(summary)).length;
    assert.ok(Buffer.byteLength(markdown) <= budget);
    assert.ok(displayed > 0 && displayed < summaries.length);
    assert.ok(markdown.includes(`…and ${summaries.length - displayed} more section(s) not listed here`));
    if (budget === 500) assert.match(markdown, /Inline detail omitted at the 500-byte display budget/);
    else assert.match(markdown, /summarized to keep this report renderable/);
    assert.ok(markdown.includes(`Evidence (warnings & failures) omitted at the ${budget}-byte display budget`));
    assert.ok(!markdown.includes('### Full detail'));
    assert.ok(!markdown.includes('EVIDENCE:'));
  }
});
