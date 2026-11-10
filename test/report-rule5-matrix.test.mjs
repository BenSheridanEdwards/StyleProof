import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateStructuralStyleMapReportForTesting, generateStyleMapReport } from '../dist/report.js';
import { reportHeadline } from '../dist/report/headline.js';
import { criticalObligationLines } from '../dist/report/certification.js';
import { MAP_MANIFEST } from '../dist/map-store.js';
import { fixtureCompatibilityKey, makeMap, mkTmp, rmTmp, solidPng, writeCapture } from './helpers.mjs';
import { commentStepExpressions, runActionComment } from './action-comment-harness.mjs';
import { commentProblems, countProblems, htmlText, reportProblems, visibleMd } from './rule5-detector.mjs';

// Ben's report rule 5 across every report shape and every Action input the PR comment reads.
// The detector (test/rule5-detector.mjs) knows no report phrases: it finds repeated statements
// by shared normalised token runs, identifiers listed twice, internal codes, approval talk in
// report text, and comment pointers at content the comment lacks. Shapes follow the branches of
// reportHeadline / summaryLines / noChangedSurfaceSummary / contentNoteLines / reachHeadlineLines /
// productStateWarningLines / criticalObligationLines and the section builders.

const BLACK = 'rgb(0, 0, 0)';
const RED = 'rgb(200, 30, 30)';
const body = { tag: 'body', rect: [0, 0, 1280, 400], style: { color: BLACK } };
const para = { tag: 'p', rect: [20, 100, 300, 20], style: { color: BLACK } };
const promo = { tag: 'div', cls: 'promo', rect: [20, 20, 200, 40], style: { color: BLACK, display: 'block' } };
const promo2 = { tag: 'div', cls: 'promo2', rect: [20, 200, 200, 40], style: { color: BLACK, display: 'block' } };
const title = (color) => ({ tag: 'h1', cls: 'title', text: 'Welcome', rect: [20, 300, 400, 40], style: { color } });
const page = (elements, extra = {}) => ({ ...makeMap({ elements: { body, ...elements } }), ...extra });
const rule = (key, hash, extra = {}) => ({ key, hash, sheet: 0, ...extra });
const reach = (rules, extra = {}) => ({
  reach: { version: 2, scope: 'compared', sheets: ['/app.css'], rules, ...extra },
});
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
const age = (text, width) =>
  page(
    {
      'body > span.age:nth-child(1)': {
        tag: 'span',
        cls: 'age',
        rect: [20, 20, width, 16],
        style: { width: `${width}px`, color: BLACK },
        computedValueStyle: { width: 'auto' },
        ownTextLength: text.length,
        text,
      },
    },
    { metadata: { liveText: { freeze: true, selectors: [] } } },
  );
/** A sibling reorder: raw reviewable evidence that report-only path correspondence collapses. */
function reorder(order) {
  const kinds = {
    button: { tag: 'button', cls: 'action', rect: [10, 10, 80, 24], ownTextLength: 3, style: { color: BLACK } },
    label: { tag: 'span', cls: 'label', rect: [10, 50, 80, 20], ownTextLength: 4, style: { color: BLACK } },
  };
  const elements = {
    body: { tag: 'body', rect: [0, 0, 400, 200], ownTextLength: 0, style: {} },
    'body > div:nth-child(1)': { tag: 'div', cls: 'shell', rect: [0, 0, 200, 100], ownTextLength: 0, style: {} },
  };
  order.forEach((kind, i) => {
    elements[`body > div:nth-child(1) > ${kinds[kind].tag}:nth-child(${i + 1})`] = kinds[kind];
  });
  return makeMap({ elements });
}
const fails = (n) =>
  Array.from({ length: n }, (_, i) => ({ key: `p${i}@1280`, reason: 'timeout on base', kind: 'capture' }));
const heads = (n) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}@1280`, page({ 'body > p': para })]));
const PLAIN = { 'home@1280': page({ 'body > p': para }) };
const STYLED = (color) => ({ 'home@1280': page({ 'body > h1': title(color), 'body > p': para }) });

/** Trust the Action's verdict step gives a reviewable shape: certify's gate fails it. */
const reviewable = (inputs) => (inputs.certifyGate ? 'CERTIFICATION_FAILED' : 'STYLE_REVIEW_REQUIRED');
const always = (state) => () => state;

const SHAPES = {
  'empty (no changes)': {
    before: PLAIN,
    after: PLAIN,
    trust: always('NO_REVIEWABLE_STYLE_CHANGES'),
    expect: /No reviewable computed-style changes/,
  },
  'style changes only': {
    before: STYLED(BLACK),
    after: STYLED(RED),
    trust: reviewable,
    expect: /\*\*1 change to review\*\*/,
  },
  'structure only (one element)': {
    before: { 'home@1280': page({ 'body > div.promo': promo, 'body > p': para }) },
    after: PLAIN,
    trust: reviewable,
    expect: /1 visible element was added or removed/,
  },
  'structure only (two elements)': {
    before: { 'home@1280': page({ 'body > div.promo': promo, 'body > div.promo2': promo2, 'body > p': para }) },
    after: PLAIN,
    trust: reviewable,
    expect: /2 visible elements were added or removed/,
  },
  'style + structure': {
    before: { 'home@1280': page({ 'body > h1': title(BLACK), 'body > div.promo': promo, 'body > p': para }) },
    after: STYLED(RED),
    trust: reviewable,
    expect: /1 visible element was added or removed/,
  },
  'new surface': {
    before: PLAIN,
    after: { ...PLAIN, 'pricing@1280': page({ 'body > p': para }) },
    trust: reviewable,
    expect: /1 new surface/,
  },
  'removed surface': {
    before: { ...PLAIN, 'pricing@1280': page({ 'body > p': para }) },
    after: PLAIN,
    trust: reviewable,
    expect: /1 removed surface/,
  },
  'new + removed surfaces': {
    before: { ...PLAIN, 'old@1280': page({ 'body > p': para }) },
    after: { ...PLAIN, 'pricing@1280': page({ 'body > p': para }) },
    trust: reviewable,
    expect: /1 removed surface/,
  },
  'removed surface + style': {
    before: { ...STYLED(BLACK), 'pricing@1280': page({ 'body > p': para }) },
    after: STYLED(RED),
    trust: reviewable,
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
    trust: reviewable,
    expect: /1 new surface/,
  },
  'base capture failed (one surface)': {
    failures: fails(1),
    before: PLAIN,
    after: { ...PLAIN, ...heads(1) },
    trust: always('PARTIAL_BASELINE'),
    expect: /1 surface failed to capture on the base/,
  },
  'base capture failed (two surfaces)': {
    failures: fails(2),
    before: PLAIN,
    after: { ...PLAIN, ...heads(2) },
    trust: always('PARTIAL_BASELINE'),
    expect: /2 surfaces failed to capture on the base/,
  },
  'base capture failed (twelve surfaces, over the naming cap)': {
    failures: fails(12),
    before: PLAIN,
    after: { ...PLAIN, ...heads(12) },
    trust: always('PARTIAL_BASELINE'),
    expect: /12 surfaces failed to capture on the base[\s\S]*and 2 more/,
  },
  'base capture failed + style': {
    failures: fails(1),
    before: STYLED(BLACK),
    after: { ...STYLED(RED), ...heads(1) },
    trust: always('PARTIAL_BASELINE'),
    expect: /1 surface failed to capture on the base/,
  },
  'base capture failed + new surface': {
    failures: fails(1),
    before: PLAIN,
    after: { ...PLAIN, ...heads(1), 'pricing@1280': page({ 'body > p': para }) },
    trust: always('PARTIAL_BASELINE'),
    expect: /1 new surface/,
  },
  'product-state blocked (structure)': {
    opts: { requireStateIdentity: true },
    before: { 'home@1280': page({ 'body > div.promo': promo, 'body > p': para }) },
    after: PLAIN,
    trust: always('CERTIFICATION_FAILED'),
    expect: /This compare cannot certify/,
  },
  'product-state blocked (style + structure)': {
    opts: { requireStateIdentity: true },
    before: { 'home@1280': page({ 'body > h1': title(BLACK), 'body > div.promo': promo, 'body > p': para }) },
    after: STYLED(RED),
    trust: always('CERTIFICATION_FAILED'),
    expect: /This compare cannot certify/,
  },
  'reach gate holding, no style change': {
    opts: { changeReach: 'gate' },
    before: { 'home@1280': page({ 'body > p': para }, reach([rule('.unopened', 'h1')])) },
    after: { 'home@1280': page({ 'body > p': para }, reach([rule('.unopened', 'h2')])) },
    trust: reviewable,
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
    trust: reviewable,
    expect: /Reach gate/,
  },
  'reach gate holding, with structure': {
    opts: { changeReach: 'gate' },
    before: { 'home@1280': page({ 'body > p': para, 'body > div.promo': promo }, reach([rule('.unopened', 'h1')])) },
    after: { 'home@1280': page({ 'body > p': para }, reach([rule('.unopened', 'h2')])) },
    trust: reviewable,
    expect: /Reach gate/,
  },
  'reach gate holding only a missing served-CSS record': {
    opts: { changeReach: 'gate' },
    before: STYLED(BLACK),
    after: {
      'home@1280': page({ 'body > h1': title(RED), 'body > p': para }, reach([rule('.title', 'h2', { used: true })])),
    },
    trust: reviewable,
    expect: /Reach gate/,
  },
  'warn-level reach gaps (one side has no served-CSS record)': {
    before: STYLED(BLACK),
    after: {
      'home@1280': page(
        { 'body > h1': title(RED), 'body > p': para },
        reach([rule('.title', 'h2', { used: true }), rule('.ignored', 'h2', { outside: true })], { unreadable: 2 }),
      ),
    },
    trust: reviewable,
    expect: /could not check every changed CSS rule/,
  },
  'warn-level reach: never matched + unmeasured': {
    before: {
      'home@1280': page({ 'body > p': para }, reach([rule('.never', 'h1'), rule('.ignored', 'h1', { outside: true })])),
    },
    after: {
      'home@1280': page({ 'body > p': para }, reach([rule('.never', 'h2'), rule('.ignored', 'h2', { outside: true })])),
    },
    trust: always('NO_REVIEWABLE_STYLE_CHANGES'),
    expect: /never matched on a captured page/,
  },
  'global chrome': {
    before: chromeSurfaces(false),
    after: chromeSurfaces(true),
    trust: reviewable,
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
    trust: reviewable,
    expect: /visible element was added or removed/,
  },
  'text + style (no structure)': {
    before: { 'home@1280': page({ 'body > h1': title(BLACK), 'body > p': { ...para, text: 'Old text' } }) },
    after: { 'home@1280': page({ 'body > h1': title(RED), 'body > p': { ...para, text: 'New text' } }) },
    trust: reviewable,
    expect: /\*\*1 change to review\*\*/,
  },
  'text only': {
    before: { 'home@1280': page({ 'body > p': { ...para, text: 'Old text' } }) },
    after: { 'home@1280': page({ 'body > p': { ...para, text: 'New text' } }) },
    trust: always('NO_REVIEWABLE_STYLE_CHANGES'),
    expect: /No reviewable computed-style changes/,
  },
  'head-only volatile subtree': {
    before: STYLED(BLACK),
    after: { 'home@1280': page({ 'body > h1': title(BLACK), 'body > p': para }, { volatile: ['body > h1'] }) },
    trust: always('CERTIFICATION_FAILED'),
    expect: /volatile on head/,
  },
  'head-only volatile subtree + style': {
    before: { 'home@1280': page({ 'body > h1': title(BLACK), 'body > div.promo': promo, 'body > p': para }) },
    after: {
      'home@1280': page(
        { 'body > h1': title(RED), 'body > div.promo': promo, 'body > p': para },
        { volatile: ['body > div.promo'] },
      ),
    },
    trust: always('CERTIFICATION_FAILED'),
    expect: /volatile on head/,
  },
  'base-only volatile subtree': {
    before: { 'home@1280': page({ 'body > h1': title(BLACK), 'body > p': para }, { volatile: ['body > h1'] }) },
    after: STYLED(BLACK),
    trust: reviewable,
    expect: /volatile on the base/,
  },
  'base-only volatile subtree + style': {
    before: {
      'home@1280': page(
        { 'body > h1': title(BLACK), 'body > p': para, 'body > div.promo': promo },
        { volatile: ['body > div.promo'] },
      ),
    },
    after: { 'home@1280': page({ 'body > h1': title(RED), 'body > p': para, 'body > div.promo': promo }) },
    trust: reviewable,
    expect: /volatile on the base/,
  },
  'volatile on both sides + style (live region)': {
    before: {
      'home@1280': page(
        { 'body > h1': title(BLACK), 'body > p': para, 'body > div.promo': promo },
        { volatile: ['body > div.promo'] },
      ),
    },
    after: {
      'home@1280': page(
        { 'body > h1': title(RED), 'body > p': para, 'body > div.promo': promo },
        { volatile: ['body > div.promo'] },
      ),
    },
    trust: reviewable,
    expect: /live region/,
  },
  'report consistency failure (correspondence collapsed every finding)': {
    structural: true,
    before: { 's@400': reorder(['button', 'label']) },
    after: { 's@400': reorder(['label', 'button']) },
    trust: always('CERTIFICATION_FAILED'),
    expect: /Report consistency failure/,
  },
  'live-text freeze violated': {
    before: { 'dashboard@1280': age('open 102.1d', 96) },
    after: { 'dashboard@1280': age('open 103.1d', 104) },
    trust: always('CERTIFICATION_FAILED'),
    expect: /Live\/age freeze violated/,
  },
  'data residue unacknowledged (trust state)': {
    before: STYLED(BLACK),
    after: STYLED(RED),
    trust: always('DATA_RESIDUE_UNACKNOWLEDGED'),
    expect: /change to review/,
  },
  'navigation removal unacknowledged (trust state)': {
    before: STYLED(BLACK),
    after: STYLED(RED),
    trust: always('INVENTORY_REMOVAL_UNACKNOWLEDGED'),
    expect: /change to review/,
  },
  'base capture failed entirely (degraded baseline)': {
    before: PLAIN,
    after: PLAIN,
    trust: always('DEGRADED_BASELINE'),
    action: { baseCaptureFailed: true, changed: true },
    expect: /No reviewable computed-style changes/,
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
  for (const [side, captures] of [
    ['before', spec.before],
    ['after', spec.after],
  ]) {
    const sideDir = path.join(dir, side);
    if (fs.existsSync(sideDir)) continue;
    fs.mkdirSync(sideDir, { recursive: true });
    for (const [key, capture] of Object.entries(captures)) writeCapture(sideDir, key, capture, solidPng(1280, 400));
    if (spec.failures) {
      manifest(sideDir, side === 'before' ? 'b'.repeat(40) : 'c'.repeat(40), side === 'before' ? spec.failures : []);
    }
  }
  const outDir = path.join(dir, `report-${includeContent ? 'content' : 'plain'}${migration ? '-migration' : ''}`);
  const result = (spec.structural ? generateStructuralStyleMapReportForTesting : generateStyleMapReport)({
    beforeDir: path.join(dir, 'before'),
    afterDir: path.join(dir, 'after'),
    outDir,
    ...(includeContent ? { includeContent: true } : {}),
    ...(migration ? { migration: true } : {}),
    ...(spec.opts ?? {}),
  });
  return { outDir, contentChanges: result.contentChanges ?? 0 };
}

for (const [shape, spec] of Object.entries(SHAPES)) {
  test(`rule 5 holds for: ${shape}`, async (t) => {
    const dir = mkTmp('styleproof-rule5-');
    t.after(() => rmTmp(dir));
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
                for (const p of commentProblems('comment', comment)) found.add(`${p} [${label}]`);
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

// Branches whose fixtures need a git checkout or capture-time audits: rendered from their
// headline/certification inputs and checked by the same detector.
const baseInput = (overrides = {}) => ({
  changeGroups: [],
  missing: [],
  sectionCount: 0,
  scope: '',
  volatileCount: 0,
  liveCandidateLabels: [],
  contentCount: 0,
  elevatedStructureDom: 0,
  contentEvaluated: false,
  reportConsistency: { ok: true, reason: 'aligned' },
  baseline: { surfaceFailures: [], failures: [], undeclaredOnBase: [] },
  confidenceBlocked: false,
  comparisonBlocked: false,
  reachBlocking: 0,
  ...overrides,
});
const newSurface = (key) => ({ sd: { surface: key, missing: 'before' } });
const RENDERED = {
  'base surface never declared on the base (undeclared-on-base)': () =>
    reportHeadline(
      baseInput({
        missing: [newSurface('reports@1280')],
        baseline: { surfaceFailures: [], failures: [], undeclaredOnBase: ['reports@1280'], sha: 'b'.repeat(40) },
      }),
    ),
  'raw-only deltas the report cannot render (consistency failure)': () =>
    reportHeadline(
      baseInput({
        reportConsistency: { ok: false, reason: 'raw_only_no_reviewable' },
        rawCounts: { dom: 0, style: 2, state: 1 },
      }),
    ),
  'live-state candidate labels': () =>
    reportHeadline(
      baseInput({
        volatileCount: 2,
        liveCandidateLabels: ['ticker', 'clock'],
        changeGroups: [{}],
        sectionCount: 1,
        scope: '.',
      }),
    ),
  'critical state obligations failing': () =>
    criticalObligationLines(
      { armed: true, failing: ['checkout@1280'], unresolved: ['billing@1280'], contradictory: ['admin@1280'] },
      { 'checkout@1280': { owner: 'payments', reason: 'card form' } },
    ),
};
for (const [shape, render] of Object.entries(RENDERED)) {
  test(`rule 5 holds for: ${shape}`, () => {
    const text = render().join('\n');
    assert.ok(text.trim(), `${shape}: renders`);
    const found = reportProblems('report.md', text);
    assert.deepEqual(found, [], `${shape}:\n${found.join('\n')}`);
  });
}
