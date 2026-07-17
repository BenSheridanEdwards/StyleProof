import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupBySignature,
  classifyChrome,
  chromePaths,
  derivedLonghandCount,
  cleanFindings,
  countChangedSurfaceScope,
  formatChangedSurfaceScope,
  productSurfaceBase,
  assessComparisonTruth,
  summarizeProps,
  prettyLabel,
  isNonValue,
  groupTitle,
  signatureOf,
  groupByPath,
  safeKey,
  formatSurfaceList,
  countCapturedSurfaceBases,
} from '../dist/change-groups.js';
// Direct module imports so fallow's static coverage path reaches the split leaves
// (re-exports alone do not create a test→src edge for CRAP / untested-risk targets).
import { summarizeProps as summarizePropsDirect, prettyLabel as prettyLabelDirect } from '../dist/prop-summary.js';
import {
  cleanFindings as cleanFindingsDirect,
  groupTitle as groupTitleDirect,
  signatureOf as signatureOfDirect,
  assessComparisonTruth as assessTruthDirect,
} from '../dist/findings-clean.js';
import { safeKey as safeKeyDirect, formatSurfaceList as formatSurfaceListDirect } from '../dist/surface-keys.js';

// change-groups.ts is the pure grouping/classification leaf shared by the report
// and the CLI. These unit-test the two behaviours the report's e2e tests only
// exercise indirectly: the shared-chrome tier (#193) and the derived-longhand
// fold count (#188).

const styleFinding = (path, props) => ({ kind: 'style', path, cls: '', pseudo: null, props });
const addFinding = (path) => ({ kind: 'dom', path, cls: '', change: 'added' });

test('groupBySignature collapses surfaces that changed identically, keeps the widest as representative', () => {
  const f = () => [styleFinding('a > b', [{ prop: 'color', before: 'rgb(0, 0, 0)', after: 'rgb(255, 0, 0)' }])];
  const groups = groupBySignature([
    { surface: 'home@390', findings: f() },
    { surface: 'home@1280', findings: f() },
    { surface: 'pricing@1280', findings: f() },
  ]);
  assert.equal(groups.length, 1, 'one distinct change across three surfaces');
  assert.deepEqual(groups[0].surfaces.sort(), ['home@1280', 'home@390', 'pricing@1280']);
  assert.equal(groups[0].rep.surface, 'home@1280', 'widest surface is the representative');
});

test('countChangedSurfaceScope counts unique bases and variant keys', () => {
  const groups = groupBySignature([
    { surface: 'home@390', findings: [styleFinding('a', [])] },
    { surface: 'home@1280', findings: [styleFinding('a', [])] },
    { surface: 'pricing@1280', findings: [styleFinding('a', [])] },
  ]);
  assert.deepEqual(countChangedSurfaceScope(groups), { bases: 2, variants: 3 });
  assert.equal(formatChangedSurfaceScope(2, 3), '2 changed surface bases (3 variants)');
  assert.equal(formatChangedSurfaceScope(1, 1), '1 changed surface base');
});

test('countChangedSurfaceScope uses metadata.surfaceKey for live-state and popup variants', () => {
  const groups = [
    {
      surfaces: ['dashboard@1280', 'dashboard-loaded@1280', 'dashboard-dialog-open@1280'],
      findings: [styleFinding('a', [])],
    },
  ];
  const surfaceKeyOf = (key) => {
    if (key.startsWith('dashboard-loaded') || key.startsWith('dashboard-dialog-open')) return 'dashboard';
    return undefined;
  };
  assert.deepEqual(countChangedSurfaceScope(groups, surfaceKeyOf), { bases: 1, variants: 3 });
});

test('countChangedSurfaceScope falls back to capture-key base without metadata', () => {
  const groups = [{ surfaces: ['dashboard@1280', 'dashboard-loaded@1280'], findings: [styleFinding('a', [])] }];
  assert.deepEqual(countChangedSurfaceScope(groups), { bases: 2, variants: 2 });
  assert.equal(productSurfaceBase('dashboard-loaded@1280', 'dashboard'), 'dashboard');
  assert.equal(productSurfaceBase('dashboard-loaded@1280'), 'dashboard-loaded');
});

test('chromePaths: a path hosted on >1 base and changed on every hosting base is chrome', () => {
  const surfacePaths = new Map([
    ['home@1280', new Set(['nav', 'main'])],
    ['settings@1280', new Set(['nav', 'panel'])],
  ]);
  const changed = [
    { path: 'nav', surfaces: ['home@1280', 'settings@1280'] },
    { path: 'main', surfaces: ['home@1280'] }, // content: hosted on one base
  ];
  const chrome = chromePaths(changed, surfacePaths);
  assert.ok(chrome.has('nav'), 'nav changed on every base that hosts it → chrome');
  assert.ok(!chrome.has('main'), 'main is hosted on only one base → not chrome');
});

test('chromePaths: a path changed on only SOME hosting bases is not chrome', () => {
  const surfacePaths = new Map([
    ['home@1280', new Set(['nav'])],
    ['settings@1280', new Set(['nav'])],
    ['reports@1280', new Set(['nav'])], // hosts nav but did not change it
  ]);
  const changed = [{ path: 'nav', surfaces: ['home@1280', 'settings@1280'] }];
  assert.ok(!chromePaths(changed, surfacePaths).has('nav'), 'partial coverage is not chrome');
});

test('chromePaths is width-blind: @1280 and @390 of one base count once', () => {
  const surfacePaths = new Map([
    ['home@1280', new Set(['nav'])],
    ['home@390', new Set(['nav'])],
    ['settings@1280', new Set(['nav'])],
  ]);
  const changed = [{ path: 'nav', surfaces: ['home@1280', 'home@390', 'settings@1280'] }];
  assert.ok(chromePaths(changed, surfacePaths).has('nav'), 'both bases covered → chrome');
});

test('chromePaths groups live-state variants by metadata.surfaceKey', () => {
  const surfacePaths = new Map([
    ['dashboard@1280', new Set(['nav'])],
    ['dashboard-loaded@1280', new Set(['nav'])],
    ['settings@1280', new Set(['nav'])],
  ]);
  const changed = [{ path: 'nav', surfaces: ['dashboard-loaded@1280', 'settings@1280'] }];
  const surfaceKeyOf = (key) => (key.startsWith('dashboard') ? 'dashboard' : undefined);
  assert.ok(chromePaths(changed, surfacePaths, surfaceKeyOf).has('nav'));
});

test('classifyChrome promotes an all-chrome group, keeps a mixed group in rest', () => {
  const surfacePaths = new Map([
    ['home@1280', new Set(['nav', 'h1'])],
    ['settings@1280', new Set(['nav'])],
  ]);
  const groups = [
    { surfaces: ['settings@1280'], findings: [addFinding('nav')] }, // pure nav
    {
      surfaces: ['home@1280'],
      findings: [addFinding('nav'), styleFinding('h1', [{ prop: 'color', before: 'a', after: 'b' }])],
    }, // nav + content
  ];
  const { chrome, rest } = classifyChrome(groups, surfacePaths);
  assert.equal(chrome.length, 1, 'the pure-nav group is promoted');
  assert.deepEqual(chrome[0].surfaces, ['settings@1280']);
  assert.equal(rest.length, 1, 'the mixed home group stays in place (content never hidden)');
});

test('derivedLonghandCount counts the reflow-casualty longhands the CLI folds', () => {
  const findings = [
    styleFinding('a', [
      { prop: 'padding-top', before: '10px', after: '14px' },
      { prop: 'padding-right', before: '16px', after: '20px' },
      { prop: 'padding-bottom', before: '10px', after: '14px' },
      { prop: 'padding-left', before: '16px', after: '20px' },
      { prop: 'width', before: '152px', after: '160px' },
      { prop: 'height', before: '44px', after: '52px' },
      { prop: 'transform-origin', before: '76px 22px', after: '80px 26px' },
    ]),
  ];
  // padding folds to one shorthand row (not derived); width/height/transform-origin
  // are the three derived longhands.
  assert.equal(derivedLonghandCount(findings), 3);
  // cleanFindings drops those three, leaving the padding shorthand's four sides.
  const cleaned = cleanFindings(findings);
  const props = cleaned.flatMap((f) => f.props).map((p) => p.prop);
  assert.ok(!props.some((p) => ['width', 'height', 'transform-origin'].includes(p)));
});

test('assessComparisonTruth: raw-only derived longhands are not reviewable evidence', () => {
  // Generic map-pair: only height/width (reflow casualties). Certification differ
  // counts them; the visual report strips them — must fail closed, never approve.
  const surfaces = [
    {
      surface: 'home@1280',
      findings: [
        styleFinding('body', [
          { prop: 'height', before: '800px', after: '820px' },
          { prop: 'width', before: '1280px', after: '1280px' },
        ]),
      ],
    },
  ];
  // width before===after won't appear in real diffs, but height alone is enough.
  surfaces[0].findings[0].props = [{ prop: 'height', before: '800px', after: '820px' }];
  const truth = assessComparisonTruth(surfaces, { dom: 0, style: 1, state: 0 });
  assert.equal(truth.rawCounts.style, 1);
  assert.equal(truth.reviewableCounts.style, 0);
  assert.equal(truth.hasReviewableEvidence, false);
  assert.equal(truth.rawOnlyNoReviewable, true);
});

test('assessComparisonTruth: real style change is reviewable and aligned', () => {
  const surfaces = [
    {
      surface: 'home@1280',
      findings: [styleFinding('body > button', [{ prop: 'color', before: 'rgb(0, 0, 0)', after: 'rgb(255, 0, 0)' }])],
    },
  ];
  const truth = assessComparisonTruth(surfaces, { dom: 0, style: 1, state: 0 });
  assert.equal(truth.rawOnlyNoReviewable, false);
  assert.equal(truth.hasReviewableEvidence, true);
  assert.equal(truth.reviewableCounts.style, 1);
});

test('assessComparisonTruth: new surfaces count as reviewable evidence without raw style counts', () => {
  const truth = assessComparisonTruth([{ surface: 'about@1280', missing: 'before', findings: [] }], {
    dom: 0,
    style: 0,
    state: 0,
  });
  assert.equal(truth.newSurfaces, 1);
  assert.equal(truth.hasReviewableEvidence, true);
  assert.equal(truth.rawOnlyNoReviewable, false);
});

// Direct coverage for logic extracted into prop-summary / findings-clean /
// surface-keys / comparison-truth modules (previously only exercised via report e2e).

test('groupTitle names added/removed/restyled elements', () => {
  const findings = [
    { kind: 'dom', path: 'a', cls: '', change: 'added' },
    { kind: 'dom', path: 'b', cls: '', change: 'removed' },
    { kind: 'style', path: 'c', cls: '', pseudo: null, props: [{ prop: 'color', before: 'a', after: 'b' }] },
  ];
  assert.equal(groupTitle(findings), '1 element added, 1 element removed, 1 element restyled');
});

test('groupTitle falls back to elements changed when only retagged', () => {
  const findings = [{ kind: 'dom', path: 'a', cls: '', change: 'retagged' }];
  assert.equal(groupTitle(findings), '1 element retagged');
});

test('signatureOf collapses grid-template track-count variants across widths', () => {
  const narrow = [
    styleFinding('main', [{ prop: 'grid-template-columns', before: '100px 100px', after: '200px 200px' }]),
  ];
  const wide = [styleFinding('main', [{ prop: 'grid-template-columns', before: '282px ×2', after: '400px ×2' }])];
  // Both are 2→2 track counts after summarizeProps track-count keying — same sig.
  // Raw before/after strings differ; signature must key by track count only.
  assert.equal(signatureOf(narrow), signatureOf(wide));
});

test('groupByPath buckets findings per element path', () => {
  const findings = [
    styleFinding('a', [{ prop: 'color', before: 'x', after: 'y' }]),
    styleFinding('b', [{ prop: 'color', before: 'x', after: 'y' }]),
    styleFinding('a', [{ prop: 'margin-top', before: '1px', after: '2px' }]),
  ];
  const groups = groupByPath(findings);
  assert.equal(groups.length, 2);
  assert.equal(groups.find((g) => g[0].path === 'a')?.length, 2);
});

test('cleanFindings drops state echoes of a base style change', () => {
  const findings = [
    styleFinding('btn', [{ prop: 'color', before: 'black', after: 'red' }]),
    {
      kind: 'state',
      path: 'btn',
      cls: '',
      state: 'hover',
      props: [{ prop: 'color', before: 'black', after: 'red' }],
    },
  ];
  const cleaned = cleanFindings(findings);
  assert.equal(cleaned.length, 1);
  assert.equal(cleaned[0].kind, 'style');
});

test('cleanFindings keeps state deltas on newly added elements', () => {
  const findings = [
    addFinding('btn'),
    {
      kind: 'state',
      path: 'btn',
      cls: '',
      state: 'hover',
      props: [{ prop: 'color', before: '(unset)', after: 'blue' }],
    },
  ];
  const cleaned = cleanFindings(findings);
  assert.ok(cleaned.some((f) => f.kind === 'state'));
});

test('safeKey strips Markdown/HTML control characters from surface keys', () => {
  assert.equal(safeKey('home`[x](y)<z>|'), 'home--x--y--z--');
});

test('formatSurfaceList groups widths under each base', () => {
  assert.equal(formatSurfaceList(['home@1280', 'home@390', 'pricing@1080']), 'home @ 1280, 390 · pricing @ 1080');
});

test('countFindings tallies via assessComparisonTruth reviewable/raw counts', () => {
  const findings = [
    addFinding('a'),
    styleFinding('b', [
      { prop: 'color', before: 'a', after: 'b' },
      { prop: 'opacity', before: '1', after: '0.5' },
    ]),
    {
      kind: 'state',
      path: 'c',
      cls: '',
      state: 'hover',
      props: [{ prop: 'outline', before: 'none', after: '1px solid red' }],
    },
  ];
  const truth = assessComparisonTruth([{ surface: 'home@1280', findings }]);
  assert.equal(truth.rawCounts.dom, 1);
  assert.equal(truth.rawCounts.style, 2);
  assert.equal(truth.rawCounts.state, 1);
  assert.equal(truth.hasReviewableEvidence, true);
});

test('countCapturedSurfaceBases prefers metadata.surfaceKey when provided', () => {
  const keys = ['dash@1280', 'dash-loaded@1280'];
  assert.equal(countCapturedSurfaceBases(keys), 2);
  assert.equal(
    countCapturedSurfaceBases(keys, (k) => (k.startsWith('dash') ? 'dash' : undefined)),
    1,
  );
});

test('isNonValue recognises placeholder markers', () => {
  assert.equal(isNonValue('(unset)'), true);
  assert.equal(isNonValue('(gone)'), true);
  assert.equal(isNonValue('1px'), false);
});

test('summarizeProps folds outline longhands; prettyLabel stays stable after split', () => {
  const out = summarizeProps([
    { prop: 'outline-width', before: '0px', after: '2px' },
    { prop: 'outline-style', before: 'none', after: 'solid' },
    { prop: 'outline-color', before: 'rgb(0, 0, 0)', after: 'rgb(255, 0, 0)' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].prop, 'outline');
  assert.equal(prettyLabel('body > a:nth-child(1)', 'nav-cta primary'), 'a.nav-cta');
  // Same symbols via direct leaf imports (coverage path for fallow).
  assert.equal(summarizePropsDirect([{ prop: 'color', before: 'a', after: 'b' }])[0].prop, 'color');
  assert.equal(prettyLabelDirect('body > a:nth-child(1)', 'nav-cta primary'), 'a.nav-cta');
  assert.equal(groupTitleDirect([{ kind: 'dom', path: 'x', cls: '', change: 'added' }]), '1 element added');
  assert.equal(
    signatureOfDirect([styleFinding('main', [{ prop: 'color', before: 'a', after: 'b' }])]),
    signatureOf([styleFinding('main', [{ prop: 'color', before: 'a', after: 'b' }])]),
  );
  assert.equal(safeKeyDirect('a`b'), 'a-b');
  assert.equal(formatSurfaceListDirect(['home@1280']), 'home @ 1280');
  assert.equal(
    assessTruthDirect([{ surface: 's', findings: [styleFinding('e', [{ prop: 'height', before: '1', after: '2' }])] }])
      .rawOnlyNoReviewable,
    true,
  );
  assert.equal(cleanFindingsDirect([styleFinding('e', [{ prop: 'height', before: '1', after: '2' }])]).length, 0);
});

test('summarizeProps drops redundant logical longhands when physical twin matches', () => {
  const out = summarizePropsDirect([
    { prop: 'margin-block-start', before: '8px', after: '16px' },
    { prop: 'margin-top', before: '8px', after: '16px' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].prop, 'margin-top');
  assert.equal(out[0].before, '8px');
  assert.equal(out[0].after, '16px');
});

test('summarizeProps keeps logical longhand when physical twin differs', () => {
  const out = summarizePropsDirect([
    { prop: 'padding-inline-end', before: '4px', after: '8px' },
    { prop: 'padding-right', before: '4px', after: '12px' },
  ]);
  const props = out.map((p) => p.prop).sort();
  assert.deepEqual(props, ['padding-inline-end', 'padding-right']);
});

test('summarizeProps drops currentColor followers that echo a color change', () => {
  const out = summarizePropsDirect([
    { prop: 'color', before: 'rgb(0, 0, 0)', after: 'rgb(255, 0, 0)' },
    { prop: 'caret-color', before: 'rgb(0, 0, 0)', after: 'rgb(255, 0, 0)' },
    { prop: 'outline-color', before: 'rgb(0, 0, 0)', after: 'rgb(255, 0, 0)' },
    { prop: 'text-decoration-color', before: 'rgb(0, 0, 0)', after: 'rgb(0, 128, 0)' },
  ]);
  const props = out.map((p) => p.prop).sort();
  assert.deepEqual(props, ['color', 'text-decoration-color']);
});

test('summarizeProps folds box families into CSS shorthand forms', () => {
  const uniform = summarizePropsDirect([
    { prop: 'padding-top', before: '8px', after: '12px' },
    { prop: 'padding-right', before: '8px', after: '12px' },
    { prop: 'padding-bottom', before: '8px', after: '12px' },
    { prop: 'padding-left', before: '8px', after: '12px' },
  ]);
  assert.equal(uniform.length, 1);
  assert.equal(uniform[0].prop, 'padding');
  assert.equal(uniform[0].before, '8px');
  assert.equal(uniform[0].after, '12px');

  const verticalHorizontal = summarizePropsDirect([
    { prop: 'margin-top', before: '4px', after: '8px' },
    { prop: 'margin-right', before: '2px', after: '6px' },
    { prop: 'margin-bottom', before: '4px', after: '8px' },
    { prop: 'margin-left', before: '2px', after: '6px' },
  ]);
  assert.equal(verticalHorizontal[0].prop, 'margin');
  assert.equal(verticalHorizontal[0].before, '4px 2px');
  assert.equal(verticalHorizontal[0].after, '8px 6px');

  const threeValue = summarizePropsDirect([
    { prop: 'margin-top', before: '1px', after: '2px' },
    { prop: 'margin-right', before: '3px', after: '4px' },
    { prop: 'margin-bottom', before: '5px', after: '6px' },
    { prop: 'margin-left', before: '3px', after: '4px' },
  ]);
  assert.equal(threeValue[0].before, '1px 3px 5px');
  assert.equal(threeValue[0].after, '2px 4px 6px');

  const fourValue = summarizePropsDirect([
    { prop: 'border-top-width', before: '1px', after: '2px' },
    { prop: 'border-right-width', before: '3px', after: '4px' },
    { prop: 'border-bottom-width', before: '5px', after: '6px' },
    { prop: 'border-left-width', before: '7px', after: '8px' },
  ]);
  assert.equal(fourValue[0].prop, 'border-width');
  assert.equal(fourValue[0].before, '1px 3px 5px 7px');
});

test('summarizeProps folds gap and uniform border families', () => {
  const gap = summarizePropsDirect([
    { prop: 'row-gap', before: '4px', after: '8px' },
    { prop: 'column-gap', before: '4px', after: '8px' },
  ]);
  assert.equal(gap.length, 1);
  assert.equal(gap[0].prop, 'gap');
  assert.equal(gap[0].before, '4px');
  assert.equal(gap[0].after, '8px');

  const unequalGap = summarizePropsDirect([
    { prop: 'row-gap', before: '4px', after: '8px' },
    { prop: 'column-gap', before: '2px', after: '6px' },
  ]);
  assert.equal(unequalGap[0].before, '4px 2px');
  assert.equal(unequalGap[0].after, '8px 6px');

  const borderColor = summarizePropsDirect([
    { prop: 'border-top-color', before: 'red', after: 'blue' },
    { prop: 'border-right-color', before: 'red', after: 'blue' },
    { prop: 'border-bottom-color', before: 'red', after: 'blue' },
    { prop: 'border-left-color', before: 'red', after: 'blue' },
  ]);
  assert.equal(borderColor.length, 1);
  assert.equal(borderColor[0].prop, 'border-color');
  assert.equal(borderColor[0].after, 'blue');
});

test('summarizeProps cleans values and drops non-value-to-non-value no-ops', () => {
  const cleaned = summarizePropsDirect([
    { prop: 'box-shadow', before: 'rgba(0, 0, 0, 0) 0px 0px 0px', after: 'rgb(0, 0, 0) 1px 1px 1px' },
    // cleanVal collapses identical space-separated tokens only when the value has no '('
    { prop: 'letter-spacing', before: '0px 0px', after: '1px 1px' },
  ]);
  assert.equal(cleaned.find((p) => p.prop === 'box-shadow')?.before.includes('transparent'), true);
  assert.equal(cleaned.find((p) => p.prop === 'letter-spacing')?.before, '0px ×2');
  assert.equal(cleaned.find((p) => p.prop === 'letter-spacing')?.after, '1px ×2');

  const noop = summarizePropsDirect([
    { prop: 'color', before: '(unset)', after: '(gone)' },
    { prop: 'opacity', before: '1', after: '1' },
  ]);
  assert.equal(noop.length, 0);
});

test('prettyLabel prefers first semantic class; falls back to tag', () => {
  assert.equal(prettyLabelDirect('div.who-grid > span:nth-child(2)', 'badge active'), 'span.badge');
  assert.equal(prettyLabelDirect('body > h3', ''), 'h3');
  assert.equal(prettyLabelDirect('a:sp-key(ab12)', 'PrimaryCTA'), 'a');
});

test('assessComparisonTruth: removed surfaces are reviewable; recomputes raw when omitted', () => {
  const removed = assessComparisonTruth([{ surface: 'old@1280', missing: 'after', findings: [] }]);
  assert.equal(removed.removedSurfaces, 1);
  assert.equal(removed.hasReviewableEvidence, true);
  assert.equal(removed.rawOnlyNoReviewable, false);

  const heightOnly = assessComparisonTruth([
    {
      surface: 'home@1280',
      findings: [styleFinding('body', [{ prop: 'height', before: '1px', after: '2px' }])],
    },
  ]);
  assert.equal(heightOnly.rawCounts.style, 1);
  assert.equal(heightOnly.rawOnlyNoReviewable, true);
});
