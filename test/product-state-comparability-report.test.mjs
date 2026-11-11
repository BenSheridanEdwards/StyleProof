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
  assert.match(
    md,
    /⛔ \*\*This compare cannot certify:\*\* 1 paired capture\(s\) declare a different product state on base and head/,
  );
  // QA10-01: say the fact without approval wording; certify and advisory runs have nothing to approve.
  assert.match(md, /so their differences are not compared\./);
  // RV11-05: the summary line leads; the blocking product-state line follows it.
  const summary = md.indexOf('No reviewable computed-style changes');
  const blocked = md.indexOf('⛔ **This compare cannot certify:**');
  assert.ok(summary > 0 && blocked > summary, md.slice(0, 400));
  assert.doesNotMatch(md, /approv/i);
  assert.doesNotMatch(md, /## (?:Element-level )?Changes/);
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
  assert.match(
    md,
    /⛔ \*\*This compare cannot certify:\*\* 1 paired capture\(s\) are not proven to show the same product state/,
  );
  assert.doesNotMatch(md, /## (?:Element-level )?Changes/);
  rmTmp(dirs.root);
});

test('report keeps undeclared legacy deltas reviewable without strict mode while disclosing unproven status', () => {
  const dirs = reportFixture({});
  const { result, md } = generate(dirs);
  assert.equal(result.changedSurfaces, 1);
  assert.equal(result.comparison.status, 'unproven');
  assert.equal(result.comparison.blocksCertification, false);
  assert.equal(result.comparison.reviewableCounts.style, 1);
  // Unproven but not required: report.json carries the status; the report shows the changes without a warning.
  assert.doesNotMatch(md, /product.state|cannot certify/i);
  assert.match(md, /## Changes/);
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
  // Proven product-state is hidden from the report body; machine receipt still says comparable.
  assert.doesNotMatch(md, /Product-state identity unproven/);
  assert.equal(result.comparison.status, 'comparable');
  assert.match(md, /## Changes/);
  rmTmp(dirs.root);
});

// RV21-01 (QA21-01): with no summary paragraph (only volatile or live-region notes), the cannot-certify
// line opens the report, as on main, and is report.html's header summary.
{
  const black = 'rgb(0, 0, 0)';
  const els = {
    body: { tag: 'body', rect: [0, 0, 1280, 400], style: { color: black } },
    'body > h1': { tag: 'h1', cls: 'title', text: 'Welcome', rect: [20, 300, 400, 40], style: { color: black } },
    'body > p': { tag: 'p', rect: [20, 100, 300, 20], style: { color: black } },
  };
  const capture = (id, extra = {}) => ({
    ...makeMap({ elements: els }),
    ...(id ? { metadata: { productState: { id, revision: 'v1' } } } : {}),
    ...extra,
  });
  const shapes = [
    ['a subtree newly volatile on head', capture('loading'), capture('ready', { volatile: ['body > h1'] }), {}],
    [
      'a live region and a subtree newly volatile on head',
      capture('loading', { volatile: ['body > p'] }),
      capture('ready', { volatile: ['body > p', 'body > h1'] }),
      {},
    ],
    [
      'a subtree volatile on the base only, with identity required',
      capture(null, { volatile: ['body > h1'] }),
      capture(null),
      { requireStateIdentity: true },
    ],
  ];
  for (const [name, before, after, options] of shapes) {
    test(`with no summary paragraph the cannot-certify line opens the report: ${name} (RV21-01)`, () => {
      const dirs = tmpDirs();
      writeCapture(dirs.beforeDir, 'home@1280', before, solidPng(1280, 400));
      writeCapture(dirs.afterDir, 'home@1280', after, solidPng(1280, 400));
      try {
        const { md } = generate(dirs, options);
        const lines = md.split('\n');
        const top = lines.slice(lines.indexOf('## 🗺️ StyleProof report') + 1).filter((l) => l.trim());
        assert.match(top[0], /^⛔ \*\*This compare cannot certify:\*\*/, top.slice(0, 4).join('\n'));
        assert.equal(lines[lines.indexOf(top[0]) - 1], '', 'a blank line before it');
        const next = lines[lines.indexOf(top[0]) + 1];
        assert.equal(next, '', 'its own paragraph');
        const html = fs.readFileSync(`${dirs.outDir}/report.html`, 'utf8');
        const header = html.match(/<header class="top">[\s\S]*?<\/header>/)?.[0] ?? '';
        assert.match(header, /<p class="summary">⛔ <strong>This compare cannot certify:<\/strong>/);
        assert.doesNotMatch(header, /volatile|live region/);
      } finally {
        rmTmp(dirs.root);
      }
    });
  }
}
