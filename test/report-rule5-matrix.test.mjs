import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateStyleMapReport as generateStyleMapReportWithoutLayoutDefault } from '../dist/report.js';
import { withLegacyReportLayout } from './with-legacy-report-layout.mjs';
import { MAP_MANIFEST } from '../dist/map-store.js';
import { fixtureCompatibilityKey, makeMap, mkTmp, rmTmp, solidPng, writeCapture } from './helpers.mjs';
import { commentStepExpressions, runActionComment } from './action-comment-harness.mjs';
import { commentProblems, countProblems, htmlText, reportProblems, visibleMd } from './rule5-detector.mjs';

const generateStyleMapReport = withLegacyReportLayout(generateStyleMapReportWithoutLayoutDefault);

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
const reviewable = (inputs) => (inputs.certifyGate ? 'CERTIFICATION_FAILED' : 'STYLE_REVIEW_REQUIRED');
const always = (state) => () => state;

const SHAPES = {
  'empty (no changes)': {
    trust: always('NO_REVIEWABLE_STYLE_CHANGES'),
    before: PLAIN,
    after: PLAIN,
    expect: /No reviewable computed-style changes/,
  },
  'style changes only': {
    trust: reviewable,
    before: STYLED(BLACK),
    after: STYLED(RED),
    expect: /\*\*1 change to review\*\*/,
  },
  'structure only (one element)': {
    trust: reviewable,
    before: { 'home@1280': page({ 'body > div.promo': promo, 'body > p': para }) },
    after: PLAIN,
    expect: /1 visible element was added or removed/,
  },
  'structure only (two elements)': {
    trust: reviewable,
    before: { 'home@1280': page({ 'body > div.promo': promo, 'body > div.promo2': promo2, 'body > p': para }) },
    after: PLAIN,
    expect: /2 visible elements were added or removed\*\* — they need review\./,
  },
  'style + structure': {
    trust: reviewable,
    before: { 'home@1280': page({ 'body > h1': title(BLACK), 'body > div.promo': promo, 'body > p': para }) },
    after: STYLED(RED),
    expect: /1 visible element was added or removed/,
  },
  'new surface': {
    trust: reviewable,
    before: PLAIN,
    after: { ...PLAIN, 'pricing@1280': page({ 'body > p': para }) },
    expect: /1 new surface/,
  },
  'removed surface': {
    trust: reviewable,
    before: { ...PLAIN, 'pricing@1280': page({ 'body > p': para }) },
    after: PLAIN,
    expect: /1 removed surface/,
  },
  'new + removed surfaces': {
    trust: reviewable,
    before: { ...PLAIN, 'old@1280': page({ 'body > p': para }) },
    after: { ...PLAIN, 'pricing@1280': page({ 'body > p': para }) },
    expect: /1 removed surface/,
  },
  'removed surface + style': {
    trust: reviewable,
    before: { ...STYLED(BLACK), 'pricing@1280': page({ 'body > p': para }) },
    after: STYLED(RED),
    expect: /1 removed surface/,
  },
  'style + structure + new surface': {
    trust: reviewable,
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
    trust: reviewable,
    before: chromeSurfaces(false),
    after: chromeSurfaces(true),
    expect: /visible element was added or removed/,
  },
  'style + structure + text': {
    trust: reviewable,
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
    trust: reviewable,
    before: { 'home@1280': page({ 'body > h1': title(BLACK), 'body > p': { ...para, text: 'Old text' } }) },
    after: { 'home@1280': page({ 'body > h1': title(RED), 'body > p': { ...para, text: 'New text' } }) },
    expect: /\*\*1 change to review\*\*/,
  },
  'text only': {
    trust: always('NO_REVIEWABLE_STYLE_CHANGES'),
    before: { 'home@1280': page({ 'body > p': { ...para, text: 'Old text' } }) },
    after: { 'home@1280': page({ 'body > p': { ...para, text: 'New text' } }) },
    expect: /No reviewable computed-style changes/,
  },
  'base capture failed (one surface)': {
    trust: always('PARTIAL_BASELINE'),
    failures: fails(1),
    before: PLAIN,
    after: { ...PLAIN, ...heads(1) },
    expect: /1 surface failed to capture on the base/,
  },
  'base capture failed (two surfaces)': {
    trust: always('PARTIAL_BASELINE'),
    failures: fails(2),
    before: PLAIN,
    after: { ...PLAIN, ...heads(2) },
    expect: /2 surfaces failed to capture on the base/,
  },
  'base capture failed (twelve surfaces, over the naming cap)': {
    trust: always('PARTIAL_BASELINE'),
    failures: fails(12),
    before: PLAIN,
    after: { ...PLAIN, ...heads(12) },
    expect: /12 surfaces failed to capture on the base[\s\S]*and 2 more/,
  },
  'base capture failed + style': {
    trust: always('PARTIAL_BASELINE'),
    failures: fails(1),
    before: STYLED(BLACK),
    after: { ...STYLED(RED), ...heads(1) },
    expect: /1 surface failed to capture on the base/,
  },
  'base capture failed + new surface': {
    trust: always('PARTIAL_BASELINE'),
    failures: fails(1),
    before: PLAIN,
    after: { ...PLAIN, ...heads(1), 'pricing@1280': page({ 'body > p': para }) },
    expect: /1 new surface/,
  },
  'product-state blocked (structure)': {
    trust: always('CERTIFICATION_FAILED'),
    opts: { requireStateIdentity: true },
    before: { 'home@1280': page({ 'body > div.promo': promo, 'body > p': para }, { metadata: {} }) },
    after: { 'home@1280': page({ 'body > p': para }, { metadata: {} }) },
    expect: /This compare cannot certify/,
  },
  'product-state blocked (style + structure)': {
    trust: always('CERTIFICATION_FAILED'),
    opts: { requireStateIdentity: true },
    before: {
      'home@1280': page({ 'body > h1': title(BLACK), 'body > div.promo': promo, 'body > p': para }, { metadata: {} }),
    },
    after: STYLED(RED),
    expect: /This compare cannot certify/,
  },
  'reach gate holding, no style change': {
    trust: reviewable,
    opts: { changeReach: 'gate' },
    before: { 'home@1280': page({ 'body > p': para }, reach([rule('.unopened', 'h1')])) },
    after: { 'home@1280': page({ 'body > p': para }, reach([rule('.unopened', 'h2')])) },
    expect: /Reach gate/,
  },
  'reach gate holding, with style changes': {
    trust: reviewable,
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
    trust: reviewable,
    opts: { changeReach: 'gate' },
    before: { 'home@1280': page({ 'body > p': para, 'body > div.promo': promo }, reach([rule('.unopened', 'h1')])) },
    after: { 'home@1280': page({ 'body > p': para }, reach([rule('.unopened', 'h2')])) },
    expect: /Reach gate/,
  },
  'reach gate holding only a missing served-CSS record': {
    trust: reviewable,
    opts: { changeReach: 'gate' },
    before: STYLED(BLACK),
    after: {
      'home@1280': page({ 'body > h1': title(RED), 'body > p': para }, reach([rule('.title', 'h2', { used: true })])),
    },
    expect: /Reach gate/,
  },
  // RV22-03 (QA22-02): with no served-CSS record on either side, the gap's reason and remedy are said once.
  'reach gate, no served-CSS record on either side': {
    trust: reviewable,
    opts: { changeReach: 'gate' },
    before: STYLED(BLACK),
    after: STYLED(RED),
    expect: /\*\*Reach evidence gaps\*\*/,
    expectNot: /ledger/,
  },
  'warn-level reach gaps (one side has no served-CSS record)': {
    trust: reviewable,
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
    trust: reviewable,
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
    trust: always('NO_REVIEWABLE_STYLE_CHANGES'),
    before: {
      'home@1280': page({ 'body > p': para }, reach([rule('.never', 'h1'), rule('.ignored', 'h1', { outside: true })])),
    },
    after: {
      'home@1280': page({ 'body > p': para }, reach([rule('.never', 'h2'), rule('.ignored', 'h2', { outside: true })])),
    },
    expect: /never matched on a captured page/,
  },
  'incomparable product state': {
    trust: always('CERTIFICATION_FAILED'),
    before: stated('checkout-loading')(BLACK),
    after: stated('checkout-ready')(RED),
    expect: /This compare cannot certify:\*\* 1 paired capture\(s\) declare a different product state/,
  },
};

/** Action inputs the comment step reads, from action.yml; each varies here or is pinned with a reason. */
const MODES = [
  { label: 'review-gate', mode: 'review-gate', requireApproval: true, failOnDiff: false },
  { label: 'certify + fail-on-diff', mode: 'certify', requireApproval: false, failOnDiff: true },
  { label: 'certify without fail-on-diff', mode: 'certify', requireApproval: false, failOnDiff: false },
  { label: 'certify + require-approval', mode: 'certify', requireApproval: true, failOnDiff: true },
  { label: 'migration', mode: 'migration', requireApproval: false, failOnDiff: false },
  { label: 'advisory', mode: 'advisory', requireApproval: false, failOnDiff: false, blocking: 'advisory' },
  // A runtime input, not a `${{ }}` expression: the commit already carries a valid approval
  // receipt for this digest, so the box renders ticked and the footer says signed off.
  {
    label: 'review-gate, already approved',
    mode: 'review-gate',
    requireApproval: true,
    failOnDiff: false,
    approved: true,
  },
  {
    label: 'migration, already approved',
    mode: 'migration',
    requireApproval: false,
    failOnDiff: false,
    approved: true,
  },
];
const STORAGE = ['branch', 'artifact'];
const VISIBILITY = [false, true];
const UNTRUSTED = [false, true];
const PINNED = {
  'github.run_attempt': 'run receipt, not copy',
  'github.run_id': 'run receipt, not copy',
  'inputs.github-token': 'credential, never rendered',
  'inputs.report-retention-days': 'one artifact expiry line; its value does not change wording',
  'inputs.status-context': 'a name interpolated into the footer',
  'steps.context.outputs.head-sha': 'receipt marker',
  'steps.context.outputs.pr-number': 'link path',
  'steps.delivery.outputs.upload': 'a skipped upload posts no report content',
  'steps.publish.outputs.sha': 'link path',
  'steps.publish.outputs.url || steps.report-artifact.outputs.artifact-url': 'link path (follows storage)',
  'steps.report-artifact.outputs.artifact-digest': 'receipt marker',
  'steps.verdict.outputs.diff-digest': 'receipt marker',
  'toJSON(inputs.comment-marker)': 'hidden marker',
};
const VARIED = [
  'inputs.base-capture-failed',
  "inputs.fail-on-diff == 'true' && inputs.require-approval != 'true' && inputs.mode == 'certify'",
  'inputs.include-content',
  'inputs.mode',
  'inputs.report-storage',
  'inputs.require-approval',
  'steps.config.outputs.blocking',
  'steps.context.outputs.untrusted-capture',
  'steps.diff.outputs.changed',
  'steps.report.outputs.content-changes',
  'steps.verdict.outputs.state',
];

test('the matrix varies or pins every input the comment step reads', () => {
  const unaccounted = commentStepExpressions().filter((e) => !VARIED.includes(e) && !(e in PINNED));
  assert.deepEqual(unaccounted, []);
});

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

function generate(dir, spec, { includeContent, migration }) {
  const outDir = path.join(dir, `matrix-${includeContent}-${migration}`);
  const result = generateStyleMapReport({
    beforeDir: path.join(dir, 'before'),
    afterDir: path.join(dir, 'after'),
    outDir,
    layout: 'visual-first',
    includeContent,
    migration,
    ...(spec.opts ?? {}),
  });
  return { outDir, contentChanges: result.contentChanges ?? 0 };
}

for (const [shape, spec] of Object.entries(SHAPES)) {
  test(`rule 5 holds for: ${shape}`, async (t) => {
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
    const found = new Set();
    for (const includeContent of [false, true]) {
      for (const migration of [false, true]) {
        const { outDir, contentChanges } = generate(dir, spec, { includeContent, migration });
        const md = fs.readFileSync(path.join(outDir, 'report.md'), 'utf8');
        const html = fs.readFileSync(path.join(outDir, 'report.html'), 'utf8');
        const json = JSON.parse(fs.readFileSync(path.join(outDir, 'report.json'), 'utf8'));
        const variant = `${includeContent ? 'content on' : 'content off'}${migration ? ', migration' : ''}`;
        if (!includeContent && !migration)
          assert.match(visibleMd(md), spec.expect, `${shape}: the fixture reaches its branch`);
        const reportFound = [
          ...reportProblems('report.md', visibleMd(md)),
          ...reportProblems('report.html', htmlText(html)),
          ...countProblems(md, json),
        ];
        for (const p of reportFound) found.add(`${p} [${variant}]`);
        for (const inputs of MODES.filter((m) => (m.mode === 'migration') === migration)) {
          for (const storage of STORAGE) {
            for (const repositoryPrivate of VISIBILITY) {
              for (const untrusted of UNTRUSTED) {
                const certifyGate = inputs.mode === 'certify' && inputs.failOnDiff && !inputs.requireApproval;
                const comment = await runActionComment({
                  reportDir: outDir,
                  ...inputs,
                  trustState: spec.trust({ certifyGate }),
                  storage,
                  repositoryPrivate,
                  untrusted,
                  includeContent,
                  contentChanges,
                  ...(spec.action ?? {}),
                });
                const label = `${inputs.label}, ${storage}, ${repositoryPrivate ? 'private' : 'public'}${untrusted ? ', fork' : ''}, ${variant}`;
                // Approval is the action only in review-gate, migration or with require-approval.
                const approvalMode =
                  inputs.mode !== 'advisory' &&
                  (inputs.requireApproval || inputs.mode === 'review-gate' || inputs.mode === 'migration');
                for (const p of commentProblems('comment', comment, { approvalMode })) found.add(`${p} [${label}]`);
              }
            }
          }
        }
      }
    }
    // One line per distinct problem (inputs folded), so a failure stays readable.
    const distinct = [...new Set([...found].map((p) => p.replace(/ \[[^\]]*\]$/, '')))];
    assert.deepEqual(
      distinct,
      [],
      `${shape}:\n${distinct.slice(0, 40).join('\n')}\n\nfirst inputs: ${[...found][0] ?? ''}`,
    );
  });
}
