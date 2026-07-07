import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupBySignature,
  classifyChrome,
  chromePaths,
  derivedLonghandCount,
  cleanFindings,
} from '../dist/change-groups.js';

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
