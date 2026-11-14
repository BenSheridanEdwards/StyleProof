import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateStructuralStyleMapReportForTesting as generateReport } from '../dist/report.js';
import { makeMap, mkTmp, rmTmp, solidPng, writeCapture } from './helpers.mjs';

const checkbox = 'body > input:nth-child(1)';
const label = 'body > label:nth-child(2)';
/**
 * "Show the CSS" heads each owner's state changes with the owner's selector, as main does, then the
 * preview's `| :state prop | before | after |` rows. The rows under the block for `selector`, as "state prop".
 */
function ownerRows(section, selector) {
  const out = [];
  let inBlock = false;
  for (const line of section.split('\n')) {
    const head = /^\*\*(?:[^*]+\*\* )?`([^`]+)`(?:\*\*)?(?: ×\d+)?$/.exec(line);
    if (head) inBlock = head[1] === selector;
    const row = /^\| `:([\w-]+) ([\w-]+)` \|/.exec(line);
    if (row && inBlock) out.push(`${row[1]} ${row[2]}`);
  }
  return out;
}

function fixture(t, own = false) {
  const root = mkTmp('styleproof-state-sections-');
  t.after(() => rmTmp(root));
  const beforeDir = path.join(root, 'before');
  const afterDir = path.join(root, 'after');
  for (const dir of [beforeDir, afterDir]) {
    const color = dir === beforeDir ? 'rgb(20, 120, 60)' : 'rgb(160, 40, 40)';
    const map = makeMap({
      elements: {
        [checkbox]: { tag: 'input', cls: 'offers-check', rect: [20, 20, 20, 20] },
        [label]: { tag: 'label', cls: 'offers-label', rect: [40, 20, 100, 20] },
      },
      states: {
        [own ? label : checkbox]: {
          [own ? 'hover' : 'checked']: { [label]: { [own ? 'background-color' : 'color']: color } },
        },
      },
    });
    writeCapture(dir, 'form@390', map, solidPng(390, 180));
    {
      for (const state of [own ? 'hover' : 'checked']) {
        fs.writeFileSync(
          path.join(dir, `form@390.${state}.png`),
          solidPng(390, 180, dir === beforeDir ? [20, 120, 60] : [160, 40, 40]),
        );
      }
    }
  }
  const result = generateReport({ beforeDir, afterDir, outDir: path.join(root, 'report'), layout: 'visual-first' });
  return {
    md: fs.readFileSync(result.reportMdPath, 'utf8'),
    json: JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8')),
  };
}

const sectionsOf = (md) =>
  Object.fromEntries(
    md
      .split(/^### /m)
      .slice(1)
      .map((section) => [section.split('\n')[0], section]),
  );

test('a state that restyles another element names that element and the control driving it', (t) => {
  const { md, json } = fixture(t);
  const sections = sectionsOf(md);
  const offers = sections['Offers label'];
  assert.match(offers, /^On the offers label, the text colour changes from .+ when the offers check is checked\./m);
  assert.match(offers, /\*\*While checked\*\*/);
  assert.doesNotMatch(offers, /While disabled|While showing its placeholder/);
  // The row sits under the control that produced it, as the capture records (main's per-owner block).
  assert.deepEqual(
    ownerRows(offers, 'input.offers-check'),
    ['checked color'],
    "the CSS row is the label colour under the checkbox's :checked",
  );
  // The Where map boxes the label that changed, never the checkbox that drives it.
  const region = json.surfaces[0].regions.find((r) => r.paths.includes(label));
  assert.deepEqual(region.paths, [label]);
  assert.deepEqual(
    region.where.flatMap((map) => map.boxes),
    [[40, 20, 100, 20]],
  );
});

test('own hover names no other driver', (t) => {
  const { md } = fixture(t, true);
  const sections = sectionsOf(md);
  assert.deepEqual(Object.keys(sections), ['Offers label']);
  assert.match(sections['Offers label'], /background changes from .+ when hovered/);
  assert.match(sections['Offers label'], /\*\*While hovered\*\*/);
  assert.doesNotMatch(sections['Offers label'], /when the offers check/);
});
