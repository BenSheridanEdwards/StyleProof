import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateStyleMapReport } from '../dist/report.js';
import { makeMap, rmTmp, solidPng, tmpDirs, writeCapture } from './helpers.mjs';

function reportFixture({ beforeState, afterState, beforeText = 'Save', afterText = beforeText }) {
  const dirs = tmpDirs();
  const scene = (color, text, productState) => ({
    ...makeMap({
      elements: {
        'body > button.private-selector:nth-child(1)': {
          tag: 'button',
          cls: 'private-selector',
          rect: [8, 8, 100, 36],
          text,
          style: { 'background-color': color },
        },
      },
    }),
    ...(productState === undefined ? {} : { metadata: { productState } }),
  });
  writeCapture(
    dirs.beforeDir,
    'checkout@1280',
    scene('rgb(0, 0, 0)', beforeText, beforeState),
    solidPng(320, 180, [0, 0, 0]),
  );
  writeCapture(
    dirs.afterDir,
    'checkout@1280',
    scene('rgb(255, 0, 0)', afterText, afterState),
    solidPng(320, 180, [255, 0, 0]),
  );
  return dirs;
}

function generate(dirs, options = {}) {
  const result = generateStyleMapReport({
    beforeDir: dirs.beforeDir,
    afterDir: dirs.afterDir,
    outDir: dirs.outDir,
    ...options,
  });
  return {
    result,
    md: fs.readFileSync(result.reportMdPath, 'utf8'),
    json: JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8')),
  };
}

test('report discloses explicit product-state mismatch and withholds approvable style evidence', () => {
  const dirs = reportFixture({
    beforeState: { id: 'checkout-loading', revision: 'fixture-v2' },
    afterState: { id: 'checkout-ready', revision: 'fixture-v2' },
  });
  const { result, md, json } = generate(dirs);
  assert.equal(result.changedSurfaces, 0);
  assert.equal(result.comparison.status, 'incomparable');
  assert.equal(result.comparison.blocksCertification, true);
  assert.equal(result.comparison.rawCounts.style, 1);
  assert.equal(result.comparison.reviewableCounts.style, 0);
  assert.deepEqual(result.comparability, [
    { surface: 'checkout@1280', status: 'incomparable', required: true, reason: 'explicit-state-mismatch' },
  ]);
  assert.equal(json.comparison.status, 'incomparable');
  assert.deepEqual(json.comparability, result.comparability);
  assert.match(md, /product-state comparison.*incomparable|incomparable.*product-state comparison/i);
  assert.match(md, /diagnostic only|not approval evidence|cannot be approved/i);
  assert.doesNotMatch(md, /## Element-level changes/);
  assert.doesNotMatch(md, /private-selector/, 'suppressed raw paths must not appear as report evidence');
  rmTmp(dirs.root);
});

test('report strict mode suppresses undeclared legacy style deltas as globally required-unproven', () => {
  const dirs = reportFixture({});
  const { result, md } = generate(dirs, { requireStateIdentity: true });
  assert.equal(result.changedSurfaces, 0);
  assert.equal(result.comparison.status, 'unproven');
  assert.equal(result.comparison.counts.globalRequiredUnproven, 1);
  assert.equal(result.comparison.blocksCertification, true);
  assert.equal(result.comparison.reviewableCounts.style, 0);
  assert.match(md, /product-state comparison.*unproven|unproven.*product-state comparison/i);
  assert.doesNotMatch(md, /## Element-level changes/);
  rmTmp(dirs.root);
});

test('report keeps undeclared legacy deltas reviewable without strict mode while disclosing unproven status', () => {
  const dirs = reportFixture({});
  const { result, md } = generate(dirs);
  assert.equal(result.changedSurfaces, 1);
  assert.equal(result.comparison.status, 'unproven');
  assert.equal(result.comparison.blocksCertification, false);
  assert.equal(result.comparison.reviewableCounts.style, 1);
  assert.match(md, /legacy compatibility|not proof/i);
  assert.match(md, /## Element-level changes/);
  rmTmp(dirs.root);
});

test('matching explicit identity remains comparable across an ordinary copy edit plus real restyle', () => {
  const state = { id: 'checkout-ready', revision: 'fixture-v2' };
  const dirs = reportFixture({
    beforeState: state,
    afterState: state,
    beforeText: 'Save order',
    afterText: 'Save this order',
  });
  const { result, md } = generate(dirs, { includeContent: true, requireStateIdentity: true });
  assert.equal(result.comparison.status, 'comparable');
  assert.equal(result.comparison.blocksCertification, false);
  assert.equal(result.changedSurfaces, 1);
  assert.match(md, /product-state comparison.*comparable|comparable.*product-state comparison/i);
  assert.match(md, /## Element-level changes/);
  rmTmp(dirs.root);
});
