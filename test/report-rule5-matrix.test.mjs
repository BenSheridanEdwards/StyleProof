import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateStyleMapReport } from '../dist/report.js';
import { MAP_MANIFEST } from '../dist/map-store.js';
import { fixtureCompatibilityKey, makeMap, mkTmp, rmTmp, solidPng, writeCapture } from './helpers.mjs';
import { htmlText, reportProblems, visibleMd } from './rule5-detector.mjs';

// Part 1: style, structure and surfaces. Layout pins refer to visual-first.
const BLACK = 'rgb(0, 0, 0)';
const RED = 'rgb(200, 30, 30)';
const body = { tag: 'body', rect: [0, 0, 1280, 400], style: { color: BLACK } };
const para = { tag: 'p', rect: [20, 100, 300, 20], style: { color: BLACK } };
const promo = { tag: 'div', cls: 'promo', rect: [20, 20, 200, 40], style: { color: BLACK, display: 'block' } };
const promo2 = { tag: 'div', cls: 'promo2', rect: [20, 200, 200, 40], style: { color: BLACK, display: 'block' } };
const title = (color) => ({ tag: 'h1', cls: 'title', text: 'Welcome', rect: [20, 300, 400, 40], style: { color } });
const page = (elements, extra = {}) => ({
  ...makeMap({ elements: { body, ...elements } }),
  metadata: { productState: { id: 'rule5', revision: 'fixture-v1' } },
  ...extra,
});
const rule = (key, hash, extra = {}) => ({ key, hash, sheet: 0, ...extra });
const reach = (rules, extra = {}) => ({
  reach: { version: 2, scope: 'compared', sheets: ['/app.css'], rules, ...extra },
});
const fails = (n) =>
  Array.from({ length: n }, (_, i) => ({ key: `p${i}@1280`, reason: 'timeout on base', kind: 'capture' }));
const heads = (n) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}@1280`, page({ 'body > p': para })]));
const nav = { tag: 'nav', cls: 'shared', rect: [0, 0, 1280, 40], style: { display: 'block' } };
const navLink = {
  tag: 'a',
  cls: 'cta',
  text: 'Help',
  rect: [10, 10, 60, 20],
  style: { color: BLACK, display: 'inline' },
};
const chromeSurfaces = (withLink) =>
  Object.fromEntries(
    ['home@1280', 'settings@1280'].map((key) => [
      key,
      page({ 'body > nav': nav, ...(withLink ? { 'body > nav > a': navLink } : {}), 'body > p': para }),
    ]),
  );
const PLAIN = { 'home@1280': page({ 'body > p': para }) };
const STYLED = (color) => ({ 'home@1280': page({ 'body > h1': title(color), 'body > p': para }) });
const stated = (id) => (color) => ({
  'home@1280': page(
    { 'body > h1': title(color), 'body > p': para },
    { metadata: { productState: { id, revision: 'fixture-v1' } } },
  ),
});
const SHAPES = {
  'empty (no changes)': {
    before: PLAIN,
    after: PLAIN,
    expect: /No reviewable computed-style changes/,
  },
  'style changes only': {
    before: STYLED(BLACK),
    after: STYLED(RED),
    expect: /\*\*1 change to review\*\*/,
  },
  'structure only (one element)': {
    before: { 'home@1280': page({ 'body > div.promo': promo, 'body > p': para }) },
    after: PLAIN,
    expect: /1 visible element was added or removed/,
  },
  'structure only (two elements)': {
    before: { 'home@1280': page({ 'body > div.promo': promo, 'body > div.promo2': promo2, 'body > p': para }) },
    after: PLAIN,
    expect: /2 visible elements were added or removed\*\* — they need review\./,
  },
  'style + structure': {
    before: { 'home@1280': page({ 'body > h1': title(BLACK), 'body > div.promo': promo, 'body > p': para }) },
    after: STYLED(RED),
    expect: /1 visible element was added or removed/,
  },
  'new surface': {
    before: PLAIN,
    after: { ...PLAIN, 'pricing@1280': page({ 'body > p': para }) },
    expect: /1 new surface/,
  },
  'removed surface': {
    before: { ...PLAIN, 'pricing@1280': page({ 'body > p': para }) },
    after: PLAIN,
    expect: /1 removed surface/,
  },
  'new + removed surfaces': {
    before: { ...PLAIN, 'old@1280': page({ 'body > p': para }) },
    after: { ...PLAIN, 'pricing@1280': page({ 'body > p': para }) },
    expect: /1 removed surface/,
  },
  'removed surface + style': {
    before: { ...STYLED(BLACK), 'pricing@1280': page({ 'body > p': para }) },
    after: STYLED(RED),
    expect: /1 removed surface/,
  },
  'style + structure + new surface': {
    before: {
      'home@1280': page({
        'body > h1': title(BLACK),
        'body > div.promo': promo,
        'body > div.promo2': promo2,
        'body > p': para,
      }),
    },
    after: { ...STYLED(RED), 'pricing@1280': page({ 'body > p': para }) },
    expect: /1 new surface/,
  },
  'global chrome': {
    before: chromeSurfaces(false),
    after: chromeSurfaces(true),
    expect: /visible element was added or removed/,
  },
  'style + structure + text': {
    before: {
      'home@1280': page({
        'body > h1': title(BLACK),
        'body > div.promo': promo,
        'body > p': { ...para, text: 'Old text' },
      }),
    },
    after: { 'home@1280': page({ 'body > h1': title(RED), 'body > p': { ...para, text: 'New text' } }) },
    expect: /visible element was added or removed/,
  },
  'text + style (no structure)': {
    before: { 'home@1280': page({ 'body > h1': title(BLACK), 'body > p': { ...para, text: 'Old text' } }) },
    after: { 'home@1280': page({ 'body > h1': title(RED), 'body > p': { ...para, text: 'New text' } }) },
    expect: /\*\*1 change to review\*\*/,
  },
  'text only': {
    before: { 'home@1280': page({ 'body > p': { ...para, text: 'Old text' } }) },
    after: { 'home@1280': page({ 'body > p': { ...para, text: 'New text' } }) },
    expect: /No reviewable computed-style changes/,
  },
  'base capture failed (one surface)': {
    failures: fails(1),
    before: PLAIN,
    after: { ...PLAIN, ...heads(1) },
    expect: /1 surface failed to capture on the base/,
  },
  'base capture failed (two surfaces)': {
    failures: fails(2),
    before: PLAIN,
    after: { ...PLAIN, ...heads(2) },
    expect: /2 surfaces failed to capture on the base/,
  },
  'base capture failed (twelve surfaces, over the naming cap)': {
    failures: fails(12),
    before: PLAIN,
    after: { ...PLAIN, ...heads(12) },
    expect: /12 surfaces failed to capture on the base[\s\S]*and 2 more/,
  },
  'base capture failed + style': {
    failures: fails(1),
    before: STYLED(BLACK),
    after: { ...STYLED(RED), ...heads(1) },
    expect: /1 surface failed to capture on the base/,
  },
  'base capture failed + new surface': {
    failures: fails(1),
    before: PLAIN,
    after: { ...PLAIN, ...heads(1), 'pricing@1280': page({ 'body > p': para }) },
    expect: /1 new surface/,
  },
  'product-state blocked (structure)': {
    opts: { requireStateIdentity: true },
    before: { 'home@1280': page({ 'body > div.promo': promo, 'body > p': para }, { metadata: {} }) },
    after: { 'home@1280': page({ 'body > p': para }, { metadata: {} }) },
    expect: /This compare cannot certify/,
  },
  'product-state blocked (style + structure)': {
    opts: { requireStateIdentity: true },
    before: {
      'home@1280': page({ 'body > h1': title(BLACK), 'body > div.promo': promo, 'body > p': para }, { metadata: {} }),
    },
    after: STYLED(RED),
    expect: /This compare cannot certify/,
  },
  'reach gate holding, no style change': {
    opts: { changeReach: 'gate' },
    before: { 'home@1280': page({ 'body > p': para }, reach([rule('.unopened', 'h1')])) },
    after: { 'home@1280': page({ 'body > p': para }, reach([rule('.unopened', 'h2')])) },
    expect: /Reach gate/,
  },
  'reach gate holding, with style changes': {
    opts: { changeReach: 'gate' },
    before: {
      'home@1280': page(
        { 'body > h1': title(BLACK), 'body > p': para },
        reach([rule('.title', 'h1', { used: true }), rule('.unopened', 'h1')]),
      ),
    },
    after: {
      'home@1280': page(
        { 'body > h1': title(RED), 'body > p': para },
        reach([rule('.title', 'h2', { used: true }), rule('.unopened', 'h2')]),
      ),
    },
    expect: /Reach gate/,
  },
  'reach gate holding, with structure': {
    opts: { changeReach: 'gate' },
    before: { 'home@1280': page({ 'body > p': para, 'body > div.promo': promo }, reach([rule('.unopened', 'h1')])) },
    after: { 'home@1280': page({ 'body > p': para }, reach([rule('.unopened', 'h2')])) },
    expect: /Reach gate/,
  },
  'reach gate holding only a missing served-CSS record': {
    opts: { changeReach: 'gate' },
    before: STYLED(BLACK),
    after: {
      'home@1280': page({ 'body > h1': title(RED), 'body > p': para }, reach([rule('.title', 'h2', { used: true })])),
    },
    expect: /Reach gate/,
  },
  // RV22-03 (QA22-02): with no served-CSS record on either side, the gap's reason and remedy are said once.
  'reach gate, no served-CSS record on either side': {
    opts: { changeReach: 'gate' },
    before: STYLED(BLACK),
    after: STYLED(RED),
    expect: /\*\*Reach evidence gaps\*\*/,
    expectNot: /ledger/,
  },
  'warn-level reach gaps (one side has no served-CSS record)': {
    before: STYLED(BLACK),
    after: {
      'home@1280': page(
        { 'body > h1': title(RED), 'body > p': para },
        reach([rule('.title', 'h2', { used: true }), rule('.ignored', 'h2', { outside: true })], { unreadable: 2 }),
      ),
    },
    expect: /could not check every changed CSS rule/,
  },
  // RV22-01: a change whose only section is a state layer captured on one side has no element; with
  // Change Reach on both sides the summary states no zero count.
  'state layer on one side, Change Reach on both sides': {
    before: {
      'home@1280': page({ 'body > h1': title(BLACK) }, { stateLayers: ['hover'], ...reach([rule('.a', 'h1')]) }),
    },
    after: {
      'home@1280': page(
        { 'body > h1': title(BLACK) },
        { stateLayers: ['hover', 'checked'], ...reach([rule('.a', 'h1')]) },
      ),
    },
    expect: /^\*\*1 change to review\*\* on `home` at 1280px wide\.$/m,
  },
  'warn-level reach: never matched + unmeasured': {
    before: {
      'home@1280': page({ 'body > p': para }, reach([rule('.never', 'h1'), rule('.ignored', 'h1', { outside: true })])),
    },
    after: {
      'home@1280': page({ 'body > p': para }, reach([rule('.never', 'h2'), rule('.ignored', 'h2', { outside: true })])),
    },
    expect: /never matched on a captured page/,
  },
  'incomparable product state': {
    before: stated('checkout-loading')(BLACK),
    after: stated('checkout-ready')(RED),
    expect: /This compare cannot certify:\*\* 1 paired capture\(s\) declare a different product state/,
  },
};

function manifest(dir, sha, failures) {
  fs.writeFileSync(
    path.join(dir, MAP_MANIFEST),
    JSON.stringify({
      version: 1,
      packageVersion: '9.0.0',
      sha,
      dirty: false,
      spec: 'test.spec.ts',
      specHash: 'a'.repeat(64),
      platform: 'linux',
      arch: 'x64',
      nodeMajor: '22',
      screenshots: true,
      har: false,
      compatibilityKey: fixtureCompatibilityKey('rule5-matrix'),
      createdAt: '2026-01-01T00:00:00.000Z',
      ...(failures.length ? { surfaceCaptureFailures: failures } : {}),
    }),
  );
}

for (const [shape, spec] of Object.entries(SHAPES)) {
  test(`rule 5 holds for: ${shape}`, (t) => {
    const dir = mkTmp('styleproof-rule5-');
    t.after(() => rmTmp(dir));
    for (const [side, captures] of [
      ['before', spec.before],
      ['after', spec.after],
    ]) {
      const sideDir = path.join(dir, side);
      fs.mkdirSync(sideDir, { recursive: true });
      for (const [key, capture] of Object.entries(captures)) writeCapture(sideDir, key, capture, solidPng(1280, 400));
    }
    for (const side of ['before', 'after']) {
      if (spec.failures)
        manifest(
          path.join(dir, side),
          (side === 'before' ? 'b' : 'c').repeat(40),
          side === 'before' ? spec.failures : [],
        );
    }
    for (const layout of [undefined, 'visual-first']) {
      const outDir = path.join(dir, layout ?? 'default');
      generateStyleMapReport({
        beforeDir: path.join(dir, 'before'),
        afterDir: path.join(dir, 'after'),
        outDir,
        ...(layout ? { layout } : {}),
        ...(spec.opts ?? {}),
      });
      const md = visibleMd(fs.readFileSync(path.join(outDir, 'report.md'), 'utf8'));
      const html = htmlText(fs.readFileSync(path.join(outDir, 'report.html'), 'utf8'));
      if (!layout && shape === 'structure only (one element)') assert.match(md, /Approve all changes signs these off/);
      if (!layout && shape === 'new surface') assert.match(md, /first-adoption surfaces; approve them/);
      if (!layout && shape === 'removed surface') assert.match(md, /approving accepts the disappearance/);
      if (!layout && shape === 'global chrome') assert.match(md, /approve them with the other changes/);
      if (layout) assert.match(md, spec.expect, `${shape}: fixture branch`);
      if (layout) assert.deepEqual(reportProblems('report.md', md), [], `${shape}: ${layout ?? 'default'} markdown`);
      if (layout) assert.deepEqual(reportProblems('report.html', html), [], `${shape}: ${layout ?? 'default'} HTML`);
    }
  });
}
