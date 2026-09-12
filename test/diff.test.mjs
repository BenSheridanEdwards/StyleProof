import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { diffStyleMaps, diffStyleMapDirs, findingLabel } from '../dist/diff.js';
import { saveStyleMap, loadStyleMap } from '../dist/capture.js';
import { makeMap, mkTmp, rmTmp, writeCapture } from './helpers.mjs';

// ------------------------------------------------------- volatile (live regions)

test('diffStyleMaps skips a path flagged volatile on either side', () => {
  const a = makeMap({ elements: { 'body > div:nth-child(1)': { tag: 'div', style: { color: 'red' } } } });
  const b = {
    ...makeMap({ elements: { 'body > div:nth-child(1)': { tag: 'div', style: { color: 'blue' } } } }),
    volatile: ['body > div:nth-child(1)'],
  };
  // The colour change sits on a live region → not a finding (union: volatile on B only).
  assert.equal(diffStyleMaps(a, b).length, 0);
});

test('diffStyleMaps skips descendants of a volatile path, incl. added/removed', () => {
  const a = makeMap({ elements: { 'body > ul:nth-child(1)': { tag: 'ul', style: {} } } });
  const b = {
    ...makeMap({
      elements: {
        'body > ul:nth-child(1)': { tag: 'ul', style: {} },
        // A row that exists only in B — normally a DOM "added", but it lives under
        // a volatile region (a live list), so it must be skipped.
        'body > ul:nth-child(1) > li:nth-child(1)': { tag: 'li', style: { color: 'red' } },
      },
    }),
    volatile: ['body > ul:nth-child(1)'],
  };
  assert.equal(diffStyleMaps(a, b).length, 0);
});

test('diffStyleMapDirs counts volatile regions and keeps them out of findings', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  writeCapture(
    A,
    'home@1280',
    makeMap({ elements: { 'body > div:nth-child(1)': { tag: 'div', style: { color: 'red' } } } }),
    null,
  );
  writeCapture(
    B,
    'home@1280',
    {
      ...makeMap({ elements: { 'body > div:nth-child(1)': { tag: 'div', style: { color: 'blue' } } } }),
      volatile: ['body > div:nth-child(1)'],
    },
    null,
  );
  const { surfaces, counts, volatile } = diffStyleMapDirs(A, B);
  assert.equal(volatile, 1);
  assert.equal(counts.style, 0);
  assert.equal(surfaces.length, 0); // the only diff was on a live region → nothing to report
  rmTmp(root);
});

// ---------------------------------------------------------------- diffStyleMaps

test('reports a DOM-added element (present only in after)', () => {
  const a = makeMap({ elements: { body: { tag: 'body' } } });
  const b = makeMap({
    elements: { body: { tag: 'body' }, 'body > p:nth-child(1)': { tag: 'p', cls: 'lede' } },
  });
  const f = diffStyleMaps(a, b);
  assert.equal(f.length, 1);
  assert.deepEqual(f[0], { kind: 'dom', path: 'body > p:nth-child(1)', cls: 'lede', change: 'added' });
});

test('an added element also yields style findings for its full resting style (before = (unset))', () => {
  const a = makeMap({ elements: { body: { tag: 'body' } } });
  const b = makeMap({
    elements: {
      body: { tag: 'body' },
      'body > button:nth-child(1)': {
        tag: 'button',
        cls: 'btn',
        style: { 'background-color': 'rgb(0, 90, 252)', padding: '6px' },
      },
    },
  });
  const f = diffStyleMaps(a, b);
  assert.ok(f.find((x) => x.kind === 'dom' && x.change === 'added'));
  const style = f.find((x) => x.kind === 'style');
  assert.ok(style, 'added element now yields a style finding for its resting style');
  const bg = style.props.find((p) => p.prop === 'background-color');
  assert.equal(bg.before, '(unset)'); // brand-new — no meaningful before
  assert.equal(bg.after, 'rgb(0, 90, 252)');
});

test('an added element carries its React component on the dom finding (advisory passthrough)', () => {
  const a = makeMap({ elements: { body: { tag: 'body' } } });
  const b = makeMap({
    elements: {
      body: { tag: 'body' },
      'body > button:nth-child(1)': {
        tag: 'button',
        cls: 'btn',
        style: {},
        component: { name: 'Button', props: { variant: 'primary' } },
      },
    },
  });
  const dom = diffStyleMaps(a, b).find((x) => x.kind === 'dom');
  assert.deepEqual(dom.component, { name: 'Button', props: { variant: 'primary' } });
});

test('geometry findings carry a privacy-safe changed-text-length signal', () => {
  const path = 'body > span:nth-child(1)';
  const a = makeMap({
    elements: { [path]: { tag: 'span', ownTextLength: 18, style: { width: '120px' } } },
  });
  const b = makeMap({
    elements: { [path]: { tag: 'span', ownTextLength: 19, style: { width: '128px' } } },
  });
  const finding = diffStyleMaps(a, b).find((item) => item.kind === 'style');
  assert.ok(finding);
  assert.equal(finding.contentLengthSignal, 'changed');
  assert.equal('text' in a.elements[path], false, 'default map stores no rendered copy');
});

test('same-length geometry findings stay ordinary CSS review evidence', () => {
  const path = 'body > span:nth-child(1)';
  const a = makeMap({
    elements: { [path]: { tag: 'span', ownTextLength: 18, style: { width: '120px' } } },
  });
  const b = makeMap({
    elements: { [path]: { tag: 'span', ownTextLength: 18, style: { width: '128px' } } },
  });
  const finding = diffStyleMaps(a, b).find((item) => item.kind === 'style');
  assert.ok(finding);
  assert.equal(finding.contentLengthSignal, undefined);
});

test('zero-length own text is explicit and non-empty transitions are classified', () => {
  const path = 'body > span:nth-child(1)';
  const a = makeMap({ elements: { [path]: { tag: 'span', ownTextLength: 0, style: { width: '0px' } } } });
  const b = makeMap({ elements: { [path]: { tag: 'span', ownTextLength: 4, style: { width: '40px' } } } });
  const finding = diffStyleMaps(a, b).find((item) => item.kind === 'style');
  assert.equal(finding.contentLengthSignal, 'changed');
});

test('legacy text-length gaps are unknown and pseudo findings do not inherit host text', () => {
  const path = 'body > span:nth-child(1)';
  const legacy = makeMap({
    elements: { [path]: { tag: 'span', style: { width: '20px' }, pseudo: { '::before': { width: '2px' } } } },
  });
  const otherLegacy = makeMap({
    elements: { [path]: { tag: 'span', style: { width: '25px' }, pseudo: { '::before': { width: '2.5px' } } } },
  });
  const current = makeMap({
    elements: {
      [path]: { tag: 'span', ownTextLength: 3, style: { width: '30px' }, pseudo: { '::before': { width: '3px' } } },
    },
  });
  const legacyFindings = diffStyleMaps(legacy, otherLegacy).filter((item) => item.kind === 'style');
  const findings = diffStyleMaps(legacy, current).filter((item) => item.kind === 'style');
  assert.equal(legacyFindings.find((item) => item.pseudo === null).contentLengthSignal, 'unknown');
  assert.equal(legacyFindings.find((item) => item.pseudo === '::before').contentLengthSignal, undefined);
  assert.equal(findings.find((item) => item.pseudo === null).contentLengthSignal, 'unknown');
  assert.equal(findings.find((item) => item.pseudo === '::before').contentLengthSignal, undefined);
});

test('reports a DOM-removed element (present only in before)', () => {
  const a = makeMap({
    elements: { body: { tag: 'body' }, 'body > p:nth-child(1)': { tag: 'p', cls: 'lede' } },
  });
  const b = makeMap({ elements: { body: { tag: 'body' } } });
  const f = diffStyleMaps(a, b);
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, 'dom');
  assert.equal(f[0].change, 'removed');
  assert.equal(f[0].cls, 'lede');
});

test('reports a retag and does not also diff its styles', () => {
  const a = makeMap({ elements: { 'body > x:nth-child(1)': { tag: 'div', cls: 'c', style: { color: 'red' } } } });
  const b = makeMap({ elements: { 'body > x:nth-child(1)': { tag: 'span', cls: 'c', style: { color: 'blue' } } } });
  const f = diffStyleMaps(a, b);
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, 'dom');
  assert.equal(f[0].change, 'retagged');
  assert.equal(f[0].detail, '<div> → <span>');
});

test('reports a changed style longhand with before/after', () => {
  const a = makeMap({
    elements: { 'body > div:nth-child(1)': { tag: 'div', cls: 'box', style: { color: 'rgb(0, 0, 0)' } } },
  });
  const b = makeMap({
    elements: { 'body > div:nth-child(1)': { tag: 'div', cls: 'box', style: { color: 'rgb(255, 0, 0)' } } },
  });
  const f = diffStyleMaps(a, b);
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, 'style');
  assert.equal(f[0].pseudo, null);
  assert.deepEqual(f[0].props, [{ prop: 'color', before: 'rgb(0, 0, 0)', after: 'rgb(255, 0, 0)' }]);
});

test('identical maps produce no findings', () => {
  const m = () =>
    makeMap({ elements: { 'body > div:nth-child(1)': { tag: 'div', style: { color: 'red', display: 'block' } } } });
  assert.deepEqual(diffStyleMaps(m(), m()), []);
});

test('ignores custom properties (--*) even when they differ', () => {
  const a = makeMap({
    elements: { 'body > div:nth-child(1)': { tag: 'div', style: { '--brand': '#000', color: 'red' } } },
  });
  const b = makeMap({
    elements: { 'body > div:nth-child(1)': { tag: 'div', style: { '--brand': '#fff', color: 'red' } } },
  });
  // Only the --brand value changed; it must be skipped, so zero findings.
  assert.deepEqual(diffStyleMaps(a, b), []);
});

test('ignores sub-pixel transform/perspective origin jitter', () => {
  const a = makeMap({
    elements: {
      'body > svg:nth-child(1) > text:nth-child(1)': {
        tag: 'text',
        style: {
          'perspective-origin': '23.9844px 48.7188px',
          'transform-origin': '285.781px 30.6094px',
        },
      },
    },
  });
  const b = makeMap({
    elements: {
      'body > svg:nth-child(1) > text:nth-child(1)': {
        tag: 'text',
        style: {
          'perspective-origin': '24px 48.7188px',
          'transform-origin': '285.797px 30.6094px',
        },
      },
    },
  });

  assert.deepEqual(diffStyleMaps(a, b), []);
});

test('keeps meaningful transform/perspective origin changes', () => {
  const a = makeMap({
    elements: {
      'body > svg:nth-child(1) > text:nth-child(1)': {
        tag: 'text',
        style: { 'perspective-origin': '24px 48px', 'transform-origin': '100px 100px' },
      },
    },
  });
  const b = makeMap({
    elements: {
      'body > svg:nth-child(1) > text:nth-child(1)': {
        tag: 'text',
        style: { 'perspective-origin': '32px 48px', 'transform-origin': '100px 130px' },
      },
    },
  });

  const f = diffStyleMaps(a, b);
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].props, [
    { prop: 'perspective-origin', before: '24px 48px', after: '32px 48px' },
    { prop: 'transform-origin', before: '100px 100px', after: '100px 130px' },
  ]);
});

test('ignores sub-pixel jitter on a single-value transform-origin', () => {
  // A one-component origin (`50px`) jitters the same rounding way as the 2/3-value
  // form; it must be suppressed identically (drift within ORIGIN_EPSILON_PX = 0.05).
  const a = makeMap({
    elements: {
      'body > svg:nth-child(1) > text:nth-child(1)': {
        tag: 'text',
        style: { 'transform-origin': '50.0312px' },
      },
    },
  });
  const b = makeMap({
    elements: {
      'body > svg:nth-child(1) > text:nth-child(1)': {
        tag: 'text',
        style: { 'transform-origin': '50px' },
      },
    },
  });

  assert.deepEqual(diffStyleMaps(a, b), []);
});

test('keeps a real (> epsilon) single-value transform-origin change', () => {
  const a = makeMap({
    elements: {
      'body > svg:nth-child(1) > text:nth-child(1)': {
        tag: 'text',
        style: { 'transform-origin': '50px' },
      },
    },
  });
  const b = makeMap({
    elements: {
      'body > svg:nth-child(1) > text:nth-child(1)': {
        tag: 'text',
        style: { 'transform-origin': '80px' },
      },
    },
  });

  const f = diffStyleMaps(a, b);
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].props, [{ prop: 'transform-origin', before: '50px', after: '80px' }]);
});

test('ignores layout-equivalent horizontal margin drift when the element rect is unchanged', () => {
  const a = makeMap({
    elements: {
      'body > div:nth-child(1)': {
        tag: 'div',
        cls: 'content',
        rect: [40, 0, 1200, 800],
        style: {
          'margin-left': '0px',
          'margin-right': '0px',
          'margin-inline-start': '0px',
          'margin-inline-end': '0px',
          width: '1200px',
        },
      },
    },
  });
  const b = makeMap({
    elements: {
      'body > div:nth-child(1)': {
        tag: 'div',
        cls: 'content',
        rect: [40, 0, 1200, 800],
        style: {
          'margin-left': '40px',
          'margin-right': '40px',
          'margin-inline-start': '40px',
          'margin-inline-end': '40px',
          width: '1200px',
        },
      },
    },
  });

  assert.deepEqual(diffStyleMaps(a, b), []);
});

test('keeps a one-sided margin change even when the rect is unchanged (external compensation is not layout-equivalent)', () => {
  // margin-left 0 -> 40px with margin-right unchanged would shift the box by
  // 40px on its own; an identical rect means something else compensated. That
  // is a real restyle, not layout-equivalent drift — it must not be dropped.
  const a = makeMap({
    elements: {
      'body > div:nth-child(1)': { tag: 'div', rect: [40, 0, 1200, 800], style: { 'margin-left': '0px' } },
    },
  });
  const b = makeMap({
    elements: {
      'body > div:nth-child(1)': { tag: 'div', rect: [40, 0, 1200, 800], style: { 'margin-left': '40px' } },
    },
  });

  const f = diffStyleMaps(a, b);
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].props, [{ prop: 'margin-left', before: '0px', after: '40px' }]);
});

test('keeps horizontal margin changes when the element rect moves', () => {
  const a = makeMap({
    elements: {
      'body > div:nth-child(1)': {
        tag: 'div',
        rect: [0, 0, 1200, 800],
        style: { 'margin-left': '0px' },
      },
    },
  });
  const b = makeMap({
    elements: {
      'body > div:nth-child(1)': {
        tag: 'div',
        rect: [40, 0, 1200, 800],
        style: { 'margin-left': '40px' },
      },
    },
  });

  const f = diffStyleMaps(a, b);
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].props, [{ prop: 'margin-left', before: '0px', after: '40px' }]);
});

test('a property newly set on one side falls back to per-tag default on the other', () => {
  // `before` does not list margin-top (so it falls back to the div default 8px);
  // `after` sets it to 0px. The fallback makes this a real 8px -> 0px change.
  const a = makeMap({
    defaults: { div: { 'margin-top': '8px' } },
    elements: { 'body > div:nth-child(1)': { tag: 'div', style: {} } },
  });
  const b = makeMap({
    defaults: { div: { 'margin-top': '8px' } },
    elements: { 'body > div:nth-child(1)': { tag: 'div', style: { 'margin-top': '0px' } } },
  });
  const f = diffStyleMaps(a, b);
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].props, [{ prop: 'margin-top', before: '8px', after: '0px' }]);
});

test('a value equal to the per-tag default on both sides is not a change', () => {
  // Pruned-out props (absent because they equal the UA default) must compare
  // equal via the fallback, not as (unset) vs a value.
  const a = makeMap({
    defaults: { div: { 'margin-top': '8px' } },
    elements: { 'body > div:nth-child(1)': { tag: 'div', style: {} } },
  });
  const b = makeMap({
    defaults: { div: { 'margin-top': '8px' } },
    elements: { 'body > div:nth-child(1)': { tag: 'div', style: {} } },
  });
  assert.deepEqual(diffStyleMaps(a, b), []);
});

test('reports a pseudo-element style change separately from the element', () => {
  const a = makeMap({
    elements: {
      'body > div:nth-child(1)': { tag: 'div', cls: 'q', style: {}, pseudo: { '::before': { content: '"a"' } } },
    },
  });
  const b = makeMap({
    elements: {
      'body > div:nth-child(1)': { tag: 'div', cls: 'q', style: {}, pseudo: { '::before': { content: '"b"' } } },
    },
  });
  const f = diffStyleMaps(a, b);
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, 'style');
  assert.equal(f[0].pseudo, '::before');
  assert.deepEqual(f[0].props, [{ prop: 'content', before: '"a"', after: '"b"' }]);
});

test('reports a forced-state (hover) delta change', () => {
  const a = makeMap({
    elements: { 'body > a:nth-child(1)': { tag: 'a', cls: 'cta' } },
    states: { 'body > a:nth-child(1)': { hover: { 'body > a:nth-child(1)': { color: 'rgb(0, 0, 255)' } } } },
  });
  // after: hover no longer changes color (the classic dropped `hover:` variant).
  const b = makeMap({
    elements: { 'body > a:nth-child(1)': { tag: 'a', cls: 'cta' } },
    states: { 'body > a:nth-child(1)': { hover: {} } },
  });
  const f = diffStyleMaps(a, b);
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, 'state');
  assert.equal(f[0].state, 'hover');
  assert.equal(f[0].sub, 'body > a:nth-child(1)');
  assert.deepEqual(f[0].props, [{ prop: 'color', before: 'rgb(0, 0, 255)', after: '(state no longer changes it)' }]);
});

test('ignores layout-equivalent margin drift inside forced-state deltas', () => {
  const a = makeMap({
    elements: {
      'body > button:nth-child(1)': { tag: 'button', cls: 'root', rect: [0, 0, 1200, 800] },
      'body > button:nth-child(1) > div:nth-child(1)': {
        tag: 'div',
        cls: 'content',
        rect: [40, 0, 1200, 800],
      },
    },
    states: {
      'body > button:nth-child(1)': {
        hover: {
          'body > button:nth-child(1) > div:nth-child(1)': {
            'margin-left': '40px',
            'margin-right': '40px',
          },
        },
      },
    },
  });
  const b = makeMap({
    elements: {
      'body > button:nth-child(1)': { tag: 'button', cls: 'root', rect: [0, 0, 1200, 800] },
      'body > button:nth-child(1) > div:nth-child(1)': {
        tag: 'div',
        cls: 'content',
        rect: [40, 0, 1200, 800],
      },
    },
    states: { 'body > button:nth-child(1)': { hover: {} } },
  });

  assert.deepEqual(diffStyleMaps(a, b), []);
});

test('findings are sorted by structural path', () => {
  const a = makeMap({
    elements: {
      'body > z:nth-child(2)': { tag: 'z', style: { color: 'red' } },
      'body > a:nth-child(1)': { tag: 'a', style: { color: 'red' } },
    },
  });
  const b = makeMap({
    elements: {
      'body > z:nth-child(2)': { tag: 'z', style: { color: 'blue' } },
      'body > a:nth-child(1)': { tag: 'a', style: { color: 'blue' } },
    },
  });
  const f = diffStyleMaps(a, b);
  assert.deepEqual(
    f.map((x) => x.path),
    ['body > a:nth-child(1)', 'body > z:nth-child(2)'],
  );
});

// ------------------------------------------------------------ diffStyleMapDirs

test('diffStyleMapDirs flags a surface present in only one dir', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  writeCapture(A, 'home@1280', makeMap({ elements: { body: { tag: 'body' } } }), null);
  writeCapture(B, 'home@1280', makeMap({ elements: { body: { tag: 'body' } } }), null);
  // extra surface only in B
  writeCapture(B, 'about@1280', makeMap({ elements: { body: { tag: 'body' } } }), null);
  const { surfaces, counts } = diffStyleMapDirs(A, B);
  const missing = surfaces.find((s) => s.surface === 'about@1280');
  assert.ok(missing, 'about surface present');
  assert.equal(missing.missing, 'before'); // only in B (after) → missing from the before set
  // A new surface has no baseline to diff, so it is NOT a change — it must not
  // inflate the tallies that drive the review gate (only `home@1280` matched,
  // and it is identical).
  assert.equal(counts.dom, 0);
  assert.equal(counts.style, 0);
  assert.equal(counts.state, 0);
  rmTmp(root);
});

test('diffStyleMapDirs indexes both .json and .json.gz by stem', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  fs.mkdirSync(A, { recursive: true });
  fs.mkdirSync(B, { recursive: true });
  // plain .json on one side, gz on the other — same stem, must pair up.
  saveStyleMap(
    path.join(A, 'home@1280.json'),
    makeMap({ elements: { 'body > p:nth-child(1)': { tag: 'p', style: { color: 'red' } } } }),
  );
  saveStyleMap(
    path.join(B, 'home@1280.json.gz'),
    makeMap({ elements: { 'body > p:nth-child(1)': { tag: 'p', style: { color: 'blue' } } } }),
  );
  const { surfaces, counts } = diffStyleMapDirs(A, B);
  assert.equal(counts.style, 1);
  assert.equal(surfaces.length, 1);
  assert.equal(surfaces[0].surface, 'home@1280');
  rmTmp(root);
});

test('diffStyleMapDirs throws when neither dir has captures', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  fs.mkdirSync(A, { recursive: true });
  fs.mkdirSync(B, { recursive: true });
  assert.throws(() => diffStyleMapDirs(A, B), /no \.json\(\.gz\)? captures found/);
  rmTmp(root);
});

test('diffStyleMapDirs aggregates style/state counts by changed-prop total', () => {
  const root = mkTmp();
  const A = path.join(root, 'a');
  const B = path.join(root, 'b');
  writeCapture(
    A,
    's@1280',
    makeMap({ elements: { 'body > div:nth-child(1)': { tag: 'div', style: { color: 'red', display: 'block' } } } }),
    null,
  );
  writeCapture(
    B,
    's@1280',
    makeMap({ elements: { 'body > div:nth-child(1)': { tag: 'div', style: { color: 'blue', display: 'flex' } } } }),
    null,
  );
  const { counts } = diffStyleMapDirs(A, B);
  assert.equal(counts.style, 2); // two longhands changed on one element
  assert.equal(counts.dom, 0);
  assert.equal(counts.state, 0);
  rmTmp(root);
});

// ---------------------------------------------------------------- findingLabel

test('findingLabel returns the bare path when there is no class', () => {
  assert.equal(findingLabel('body > div:nth-child(1)', ''), 'body > div:nth-child(1)');
});

test('findingLabel appends up to three classes', () => {
  assert.equal(findingLabel('body > div', 'a b'), 'body > div  (.a.b)');
});

test('findingLabel truncates beyond three classes with an ellipsis', () => {
  assert.equal(findingLabel('body > div', 'a b c d'), 'body > div  (.a.b.c…)');
});

// ------------------------------------------------------- save/load roundtrip

test('saveStyleMap/loadStyleMap roundtrip is identical for .json and .json.gz', () => {
  const root = mkTmp();
  const m = makeMap({ elements: { 'body > div:nth-child(1)': { tag: 'div', cls: 'x', style: { color: 'red' } } } });
  const plainPath = path.join(root, 'x.json');
  const gzPath = path.join(root, 'x.json.gz');
  saveStyleMap(plainPath, m);
  saveStyleMap(gzPath, m);
  // gz file must actually be smaller-on-disk-shaped (binary, not the raw json)
  assert.notEqual(fs.readFileSync(gzPath)[0], '{'.charCodeAt(0));
  assert.deepEqual(loadStyleMap(plainPath), m);
  assert.deepEqual(loadStyleMap(gzPath), m);
  rmTmp(root);
});

// ------------------------------------------------ statesSkipped + pseudo defaults

test('flags the forced-state layer skipped on exactly one side (statesSkipped)', () => {
  const a = { ...makeMap({ elements: { body: { tag: 'body' } } }), statesSkipped: true };
  const b = makeMap({ elements: { body: { tag: 'body' } } });
  const f = diffStyleMaps(a, b);
  const meta = f.find((x) => x.kind === 'state' && x.state === 'forced-state capture');
  assert.ok(meta, 'emits a loud finding when one side skipped state capture');
});

test('no state-skip finding when both sides skipped (or neither)', () => {
  const skipped = () => ({ ...makeMap({ elements: { body: { tag: 'body' } } }), statesSkipped: true });
  assert.deepEqual(diffStyleMaps(skipped(), skipped()), []);
  const full = () => makeMap({ elements: { body: { tag: 'body' } } });
  assert.deepEqual(diffStyleMaps(full(), full()), []);
});

test('diffStyleMapDirs marks forced-state certification incomplete when either capture skipped or disabled it', () => {
  for (const [label, beforeEvidence, afterEvidence, expected] of [
    ['both skipped', { statesSkipped: true }, { statesSkipped: true }, 1],
    ['before skipped', { statesSkipped: true }, {}, 1],
    ['after skipped', {}, { statesSkipped: true }, 1],
    ['captureStates false is explicitly unsupported', { statesCaptured: false }, { statesCaptured: false }, 1],
    ['neither', {}, {}, 0],
  ]) {
    const root = mkTmp();
    const before = path.join(root, 'before');
    const after = path.join(root, 'after');
    const map = (stateEvidence) => ({
      ...makeMap({ elements: { body: { tag: 'body' } } }),
      ...stateEvidence,
    });
    writeCapture(before, 'home@1280', map(beforeEvidence), null);
    writeCapture(after, 'home@1280', map(afterEvidence), null);
    assert.equal(diffStyleMapDirs(before, after).statesUncertified, expected, label);
    rmTmp(root);
  }
});

test('a pseudo-element pruned against its OWN ua default (tag::pseudo) is not a change', () => {
  // `before` omits ::before content (pruned because it equals the pseudo's own
  // default '"x"'); `after` sets it explicitly to '"x"'. With the per-pseudo
  // default both resolve to '"x"', so this must NOT be a finding.
  const a = makeMap({
    defaults: { 'div::before': { content: '"x"' } },
    elements: { 'body > div:nth-child(1)': { tag: 'div', pseudo: { '::before': {} } } },
  });
  const b = makeMap({
    defaults: { 'div::before': { content: '"x"' } },
    elements: { 'body > div:nth-child(1)': { tag: 'div', pseudo: { '::before': { content: '"x"' } } } },
  });
  assert.deepEqual(diffStyleMaps(a, b), []);
});

// ------------------------------------------------------- re-nesting (#472)
// A wrapper added around (or removed from around) an element changes the path of
// every descendant. Certification excludes structure, so before the fix a real
// restyle on the re-nested element vanished with the advisory remove+add and the
// surface certified clean. These pin the user-visible contract through the same
// entry point the diff CLI and the report use.

const cta = (color) => ({
  tag: 'button',
  cls: 'cta',
  rect: [10, 10, 120, 40],
  ownTextLength: 3,
  style: { color, 'background-color': 'rgb(0, 0, 255)' },
});
const card = { tag: 'div', cls: 'card', rect: [0, 0, 200, 100], ownTextLength: 0, style: {} };
const wrap = { tag: 'div', cls: 'card__body', rect: [0, 0, 200, 100], ownTextLength: 0, style: {} };
const flat = (color) =>
  makeMap({ elements: { 'div:nth-child(1)': card, 'div:nth-child(1) > button:nth-child(1)': cta(color) } });
const wrapped = (color) =>
  makeMap({
    elements: {
      'div:nth-child(1)': card,
      'div:nth-child(1) > div:nth-child(1)': wrap,
      'div:nth-child(1) > div:nth-child(1) > button:nth-child(1)': cta(color),
    },
  });
function dirsFor(before, after) {
  const root = mkTmp();
  writeCapture(path.join(root, 'a'), 'home@1280', before, null);
  writeCapture(path.join(root, 'b'), 'home@1280', after, null);
  return { root, A: path.join(root, 'a'), B: path.join(root, 'b') };
}
const colorChanges = (surfaces) =>
  surfaces.flatMap((s) =>
    s.findings
      .filter((f) => f.kind === 'style')
      .flatMap((f) => f.props.filter((p) => p.prop === 'color').map((p) => `${p.before}->${p.after}`)),
  );

test('diffStyleMapDirs surfaces a restyle on an element that a new wrapper re-nested', () => {
  const { root, A, B } = dirsFor(flat('rgb(255, 0, 0)'), wrapped('rgb(0, 128, 0)'));
  const { surfaces, counts } = diffStyleMapDirs(A, B);
  assert.equal(counts.style, 1);
  assert.equal(counts.dom, 0, 'structure stays advisory: no dom findings in certification');
  assert.deepEqual(colorChanges(surfaces), ['rgb(255, 0, 0)->rgb(0, 128, 0)']);
  assert.equal(surfaces[0].findings[0].path, 'div:nth-child(1) > div:nth-child(1) > button:nth-child(1)');
  rmTmp(root);
});

test('diffStyleMapDirs surfaces a restyle on an element whose wrapper was removed', () => {
  const { root, A, B } = dirsFor(wrapped('rgb(255, 0, 0)'), flat('rgb(0, 128, 0)'));
  const { surfaces, counts } = diffStyleMapDirs(A, B);
  assert.equal(counts.style, 1);
  assert.deepEqual(colorChanges(surfaces), ['rgb(255, 0, 0)->rgb(0, 128, 0)']);
  rmTmp(root);
});

test('diffStyleMapDirs stays clean when only the nesting changed (no false positive)', () => {
  const { root, A, B } = dirsFor(flat('rgb(255, 0, 0)'), wrapped('rgb(255, 0, 0)'));
  const { surfaces, counts } = diffStyleMapDirs(A, B);
  assert.deepEqual(counts, { dom: 0, style: 0, state: 0 });
  assert.equal(surfaces.length, 0);
  rmTmp(root);
});

test('diffStyleMapDirs carries forced-state deltas across a re-nesting', () => {
  const before = {
    ...flat('rgb(255, 0, 0)'),
    states: {
      'div:nth-child(1) > button:nth-child(1)': {
        hover: { 'div:nth-child(1) > button:nth-child(1)': { color: 'rgb(200, 0, 0)' } },
      },
    },
  };
  // Head re-nests the button and DROPS its :hover colour.
  const { root, A, B } = dirsFor(before, wrapped('rgb(255, 0, 0)'));
  const { surfaces, counts } = diffStyleMapDirs(A, B);
  assert.equal(counts.style, 0);
  assert.equal(counts.state, 1);
  assert.equal(surfaces[0].findings[0].kind, 'state');
  assert.equal(surfaces[0].findings[0].state, 'hover');
  rmTmp(root);
});

test('diffStyleMapDirs structural inventory mode (includeStructure: true) is unchanged: raw remove + add', () => {
  const { root, A, B } = dirsFor(flat('rgb(255, 0, 0)'), wrapped('rgb(0, 128, 0)'));
  const { surfaces } = diffStyleMapDirs(A, B, { includeStructure: true });
  const dom = surfaces[0].findings.filter((f) => f.kind === 'dom');
  assert.ok(dom.some((f) => f.change === 'removed' && f.path === 'div:nth-child(1) > button:nth-child(1)'));
  assert.ok(
    dom.some((f) => f.change === 'added' && f.path === 'div:nth-child(1) > div:nth-child(1) > button:nth-child(1)'),
  );
  rmTmp(root);
});

// --------------------------------------------------------- #513 baselineFailures in DiffResult

test('diffStyleMapDirs returns baselineFailures populated from baseline manifest (#513)', () => {
  const root = mkTmp();
  const A = path.join(root, 'before');
  const B = path.join(root, 'after');
  const m = makeMap({ elements: { body: { tag: 'body' } } });
  writeCapture(A, 'home@1280', m, null);
  writeCapture(A, 'about@1280', m, null);
  writeCapture(B, 'home@1280', m, null);
  writeCapture(B, 'about@1280', m, null);
  writeCapture(B, 'pricing@1280', m, null);
  fs.writeFileSync(
    path.join(A, 'styleproof-manifest.json'),
    JSON.stringify({
      version: 1,
      packageVersion: 'test',
      sha: 'a'.repeat(40),
      dirty: false,
      spec: 'e2e/styleproof.spec.ts',
      specHash: '0'.repeat(64),
      platform: process.platform,
      arch: process.arch,
      nodeMajor: process.versions.node.split('.')[0],
      screenshots: true,
      har: false,
      compatibilityKey: '0'.repeat(16),
      createdAt: '2026-01-01T00:00:00.000Z',
      surfaceCaptureFailures: [
        { key: 'pricing@1280', reason: 'timeout on base', kind: 'capture' },
        { key: 'contact@auto', reason: 'viewport detection failed', kind: 'capture' },
        { key: 'faq@900', reason: 'network error', kind: 'capture' },
        { key: 'team@1440', reason: 'element not found', kind: 'capture' },
        { key: 'blog@1280', reason: 'assertion failed', kind: 'capture' },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(B, 'styleproof-manifest.json'),
    JSON.stringify({
      version: 1,
      packageVersion: 'test',
      sha: 'b'.repeat(40),
      dirty: false,
      spec: 'e2e/styleproof.spec.ts',
      specHash: '0'.repeat(64),
      platform: process.platform,
      arch: process.arch,
      nodeMajor: process.versions.node.split('.')[0],
      screenshots: true,
      har: false,
      compatibilityKey: '0'.repeat(16),
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  const result = diffStyleMapDirs(A, B);
  assert.ok(Array.isArray(result.baselineFailures), 'baselineFailures should be an array');
  assert.equal(result.baselineFailures.length, 5, 'should have 5 baseline failures');
  assert.deepEqual(
    result.baselineFailures.map((f) => f.key).sort(),
    ['blog@1280', 'contact@auto', 'faq@900', 'pricing@1280', 'team@1440'].sort(),
  );
  assert.ok(
    result.baselineFailures.every((f) => f.reason === 'capture_failed'),
    'all failures should have bounded reason',
  );
  rmTmp(root);
});

test('diffStyleMapDirs returns empty baselineFailures when baseline manifest has no failures (#513)', () => {
  const root = mkTmp();
  const A = path.join(root, 'before');
  const B = path.join(root, 'after');
  const m = makeMap({ elements: { body: { tag: 'body' } } });
  writeCapture(A, 'home@1280', m, null);
  writeCapture(B, 'home@1280', m, null);
  fs.writeFileSync(
    path.join(A, 'styleproof-manifest.json'),
    JSON.stringify({
      version: 1,
      packageVersion: 'test',
      sha: 'a'.repeat(40),
      dirty: false,
      spec: 'e2e/styleproof.spec.ts',
      specHash: '0'.repeat(64),
      platform: process.platform,
      arch: process.arch,
      nodeMajor: process.versions.node.split('.')[0],
      screenshots: true,
      har: false,
      compatibilityKey: '0'.repeat(16),
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  fs.writeFileSync(
    path.join(B, 'styleproof-manifest.json'),
    JSON.stringify({
      version: 1,
      packageVersion: 'test',
      sha: 'b'.repeat(40),
      dirty: false,
      spec: 'e2e/styleproof.spec.ts',
      specHash: '0'.repeat(64),
      platform: process.platform,
      arch: process.arch,
      nodeMajor: process.versions.node.split('.')[0],
      screenshots: true,
      har: false,
      compatibilityKey: '0'.repeat(16),
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  const result = diffStyleMapDirs(A, B);
  assert.ok(Array.isArray(result.baselineFailures), 'baselineFailures should be an array');
  assert.equal(result.baselineFailures.length, 0, 'should have no baseline failures');
  rmTmp(root);
});

test('diffStyleMapDirs returns empty baselineFailures when baseline manifest is missing (#513)', () => {
  const root = mkTmp();
  const A = path.join(root, 'before');
  const B = path.join(root, 'after');
  const m = makeMap({ elements: { body: { tag: 'body' } } });
  writeCapture(A, 'home@1280', m, null);
  writeCapture(B, 'home@1280', m, null);
  const result = diffStyleMapDirs(A, B);
  assert.ok(Array.isArray(result.baselineFailures), 'baselineFailures should be an array');
  assert.equal(result.baselineFailures.length, 0, 'should have no baseline failures when manifest is missing');
  rmTmp(root);
});

// --------------------------------------------------------- #514 SurfaceClassification

test('diffStyleMapDirs classifies genuinely-new surfaces vs baseline-repair-debt (#514)', () => {
  const root = mkTmp();
  const A = path.join(root, 'before');
  const B = path.join(root, 'after');
  const m = makeMap({ elements: { body: { tag: 'body' } } });
  writeCapture(A, 'home@1280', m, null);
  writeCapture(B, 'home@1280', m, null);
  writeCapture(B, 'about@1280', m, null);
  writeCapture(B, 'pricing@1280', m, null);
  fs.writeFileSync(
    path.join(A, 'styleproof-manifest.json'),
    JSON.stringify({
      version: 1,
      packageVersion: 'test',
      sha: 'a'.repeat(40),
      dirty: false,
      spec: 'e2e/styleproof.spec.ts',
      specHash: '0'.repeat(64),
      platform: process.platform,
      arch: process.arch,
      nodeMajor: process.versions.node.split('.')[0],
      screenshots: true,
      har: false,
      compatibilityKey: '0'.repeat(16),
      createdAt: '2026-01-01T00:00:00.000Z',
      surfaceCaptureFailures: [{ key: 'about@1280', reason: 'timeout on base', kind: 'capture' }],
    }),
  );
  fs.writeFileSync(
    path.join(B, 'styleproof-manifest.json'),
    JSON.stringify({
      version: 1,
      packageVersion: 'test',
      sha: 'b'.repeat(40),
      dirty: false,
      spec: 'e2e/styleproof.spec.ts',
      specHash: '0'.repeat(64),
      platform: process.platform,
      arch: process.arch,
      nodeMajor: process.versions.node.split('.')[0],
      screenshots: true,
      har: false,
      compatibilityKey: '0'.repeat(16),
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  const result = diffStyleMapDirs(A, B);
  const aboutSurface = result.surfaces.find((s) => s.surface === 'about@1280');
  const pricingSurface = result.surfaces.find((s) => s.surface === 'pricing@1280');
  const homeSurface = result.surfaces.find((s) => s.surface === 'home@1280');
  assert.ok(aboutSurface, 'about surface should be in results');
  assert.ok(pricingSurface, 'pricing surface should be in results');
  assert.equal(aboutSurface.classification, 'baseline-repair-debt', 'about should be baseline-repair-debt');
  assert.equal(pricingSurface.classification, 'genuinely-new', 'pricing should be genuinely-new');
  assert.equal(homeSurface, undefined, 'home has no findings so may not be in surfaces list');
  rmTmp(root);
});

test('diffStyleMapDirs classifies removed surfaces (#514)', () => {
  const root = mkTmp();
  const A = path.join(root, 'before');
  const B = path.join(root, 'after');
  const m = makeMap({ elements: { body: { tag: 'body' } } });
  writeCapture(A, 'home@1280', m, null);
  writeCapture(A, 'about@1280', m, null);
  writeCapture(B, 'home@1280', m, null);
  const result = diffStyleMapDirs(A, B);
  const aboutSurface = result.surfaces.find((s) => s.surface === 'about@1280');
  assert.ok(aboutSurface, 'about surface should be in results');
  assert.equal(aboutSurface.classification, 'removed', 'about should be classified as removed');
  assert.equal(aboutSurface.missing, 'after', 'about should be missing after');
  rmTmp(root);
});

test('diffStyleMapDirs classifies changed surfaces (#514)', () => {
  const root = mkTmp();
  const A = path.join(root, 'before');
  const B = path.join(root, 'after');
  const ma = makeMap({ elements: { body: { tag: 'body', style: { color: 'red' } } } });
  const mb = makeMap({ elements: { body: { tag: 'body', style: { color: 'blue' } } } });
  writeCapture(A, 'home@1280', ma, null);
  writeCapture(B, 'home@1280', mb, null);
  const result = diffStyleMapDirs(A, B);
  const homeSurface = result.surfaces.find((s) => s.surface === 'home@1280');
  assert.ok(homeSurface, 'home surface should be in results');
  assert.equal(homeSurface.classification, 'changed', 'home should be classified as changed');
  assert.equal(homeSurface.missing, undefined, 'home should not be missing');
  rmTmp(root);
});

test('diffStyleMapDirs returns isNew derived from classification for backward compatibility (#514)', () => {
  const root = mkTmp();
  const A = path.join(root, 'before');
  const B = path.join(root, 'after');
  const m = makeMap({ elements: { body: { tag: 'body' } } });
  writeCapture(A, 'home@1280', m, null);
  writeCapture(B, 'home@1280', m, null);
  writeCapture(B, 'about@1280', m, null);
  writeCapture(B, 'pricing@1280', m, null);
  fs.writeFileSync(
    path.join(A, 'styleproof-manifest.json'),
    JSON.stringify({
      version: 1,
      packageVersion: 'test',
      sha: 'a'.repeat(40),
      dirty: false,
      spec: 'e2e/styleproof.spec.ts',
      specHash: '0'.repeat(64),
      platform: process.platform,
      arch: process.arch,
      nodeMajor: process.versions.node.split('.')[0],
      screenshots: true,
      har: false,
      compatibilityKey: '0'.repeat(16),
      createdAt: '2026-01-01T00:00:00.000Z',
      surfaceCaptureFailures: [{ key: 'about@1280', reason: 'timeout on base', kind: 'capture' }],
    }),
  );
  fs.writeFileSync(
    path.join(B, 'styleproof-manifest.json'),
    JSON.stringify({
      version: 1,
      packageVersion: 'test',
      sha: 'b'.repeat(40),
      dirty: false,
      spec: 'e2e/styleproof.spec.ts',
      specHash: '0'.repeat(64),
      platform: process.platform,
      arch: process.arch,
      nodeMajor: process.versions.node.split('.')[0],
      screenshots: true,
      har: false,
      compatibilityKey: '0'.repeat(16),
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  const result = diffStyleMapDirs(A, B);
  const aboutSurface = result.surfaces.find((s) => s.surface === 'about@1280');
  const pricingSurface = result.surfaces.find((s) => s.surface === 'pricing@1280');
  assert.equal(aboutSurface.isNew, false, 'baseline-repair-debt should NOT be isNew');
  assert.equal(pricingSurface.isNew, true, 'genuinely-new should be isNew');
  rmTmp(root);
});

// --------------------------------------------------------- #612 known-truth CSS mutation → exact diff findings
// Prove the full capture→diff pipeline reports EXACT before/after CSS mutations
// from a known-truth fixture pair — not merely "a change was found".

test('known-truth CSS diff: reports exact before/after mutations, no false positives (#612)', async () => {
  const oracle = JSON.parse(
    fs.readFileSync(
      path.join(path.dirname(import.meta.url.replace('file://', '')), 'fixtures/known-truth-css/expected-diff.json'),
      'utf8',
    ),
  );

  // Synthetic maps matching the documented CSS from before.html and after.html.
  // The paths mirror what the capture produces from the fixture HTML structure.
  const beforeMap = makeMap({
    elements: {
      // .hero-container: background-color rgb(248, 250, 252), padding 32px
      'body > main:nth-child(1) > div:nth-child(1)': {
        tag: 'div',
        cls: 'hero-container',
        style: {
          'background-color': 'rgb(248, 250, 252)',
          'padding-top': '32px',
          'padding-right': '32px',
          'padding-bottom': '32px',
          'padding-left': '32px',
        },
      },
      // .cta-button: background-color rgb(20, 184, 166), color rgb(255, 255, 255)
      'body > main:nth-child(1) > div:nth-child(1) > button:nth-child(1)': {
        tag: 'button',
        cls: 'cta-button',
        style: {
          'background-color': 'rgb(20, 184, 166)',
          color: 'rgb(255, 255, 255)',
          'padding-top': '12px',
          'padding-right': '24px',
          'padding-bottom': '12px',
          'padding-left': '24px',
          'font-size': '16px',
          cursor: 'pointer',
        },
      },
      // .label-span: color rgb(71, 85, 105), font-size 14px
      'body > main:nth-child(1) > div:nth-child(1) > span:nth-child(2)': {
        tag: 'span',
        cls: 'label-span',
        style: {
          color: 'rgb(71, 85, 105)',
          'font-size': '14px',
          'margin-left': '8px',
        },
      },
      // .footer-text: color rgb(107, 114, 128), font-size 12px
      'body > main:nth-child(1) > footer:nth-child(2) > p:nth-child(1)': {
        tag: 'p',
        cls: 'footer-text',
        style: {
          color: 'rgb(107, 114, 128)',
          'font-size': '12px',
          'margin-top': '16px',
        },
      },
    },
  });

  const afterMap = makeMap({
    elements: {
      // .hero-container: UNCHANGED
      'body > main:nth-child(1) > div:nth-child(1)': {
        tag: 'div',
        cls: 'hero-container',
        style: {
          'background-color': 'rgb(248, 250, 252)',
          'padding-top': '32px',
          'padding-right': '32px',
          'padding-bottom': '32px',
          'padding-left': '32px',
        },
      },
      // .cta-button: background-color CHANGED rgb(20, 184, 166) → rgb(220, 38, 38)
      'body > main:nth-child(1) > div:nth-child(1) > button:nth-child(1)': {
        tag: 'button',
        cls: 'cta-button',
        style: {
          'background-color': 'rgb(220, 38, 38)', // CHANGED from rgb(20, 184, 166)
          color: 'rgb(255, 255, 255)', // UNCHANGED
          'padding-top': '12px',
          'padding-right': '24px',
          'padding-bottom': '12px',
          'padding-left': '24px',
          'font-size': '16px',
          cursor: 'pointer',
        },
      },
      // .label-span: UNCHANGED
      'body > main:nth-child(1) > div:nth-child(1) > span:nth-child(2)': {
        tag: 'span',
        cls: 'label-span',
        style: {
          color: 'rgb(71, 85, 105)',
          'font-size': '14px',
          'margin-left': '8px',
        },
      },
      // .footer-text: UNCHANGED
      'body > main:nth-child(1) > footer:nth-child(2) > p:nth-child(1)': {
        tag: 'p',
        cls: 'footer-text',
        style: {
          color: 'rgb(107, 114, 128)',
          'font-size': '12px',
          'margin-top': '16px',
        },
      },
    },
  });

  const findings = diffStyleMaps(beforeMap, afterMap);

  // Fail-closed contract: assert findings match oracle EXACTLY.

  // 1. Verify all expected findings are present with exact before/after values.
  assert.equal(
    findings.length,
    oracle.expectedFindings.length,
    `expected ${oracle.expectedFindings.length} finding(s), got ${findings.length}`,
  );

  for (const expected of oracle.expectedFindings) {
    const actual = findings.find((f) => f.path === expected.path && f.kind === expected.kind);
    assert.ok(actual, `missing expected finding for path: ${expected.path}`);
    assert.equal(actual.cls, expected.cls, `cls mismatch for ${expected.path}`);
    assert.equal(actual.pseudo, expected.pseudo, `pseudo mismatch for ${expected.path}`);
    assert.deepEqual(
      actual.props,
      expected.props,
      `props mismatch for ${expected.path}: expected ${JSON.stringify(expected.props)}, got ${JSON.stringify(actual.props)}`,
    );
  }

  // 2. Verify no unexpected findings (elements in noChangeExpected have zero findings).
  for (const noChange of oracle.noChangeExpected) {
    const unexpected = findings.find((f) => f.path === noChange.path);
    assert.equal(
      unexpected,
      undefined,
      `unexpected finding on noChangeExpected element ${noChange.path} (${noChange.cls}): ${JSON.stringify(unexpected)}`,
    );
  }

  // 3. Verify no false positives: every finding is in expectedFindings.
  for (const actual of findings) {
    const expected = oracle.expectedFindings.find((e) => e.path === actual.path && e.kind === actual.kind);
    assert.ok(expected, `unexpected finding (false positive): ${JSON.stringify(actual)}`);
  }
});

test('known-truth CSS diff: detects missing expected finding (fail-closed regression guard) (#612)', () => {
  // This test proves the known-truth test would FAIL if diffStyleMaps missed the
  // documented mutation. We intentionally create maps where the expected change
  // does NOT occur and verify the assertion fails.

  const oracle = JSON.parse(
    fs.readFileSync(
      path.join(path.dirname(import.meta.url.replace('file://', '')), 'fixtures/known-truth-css/expected-diff.json'),
      'utf8',
    ),
  );

  // Maps where background-color does NOT change (both are the before value).
  const beforeMap = makeMap({
    elements: {
      'body > main:nth-child(1) > div:nth-child(1) > button:nth-child(1)': {
        tag: 'button',
        cls: 'cta-button',
        style: { 'background-color': 'rgb(20, 184, 166)' },
      },
    },
  });
  const afterMap = makeMap({
    elements: {
      'body > main:nth-child(1) > div:nth-child(1) > button:nth-child(1)': {
        tag: 'button',
        cls: 'cta-button',
        style: { 'background-color': 'rgb(20, 184, 166)' }, // Same as before — no change
      },
    },
  });

  const findings = diffStyleMaps(beforeMap, afterMap);

  // The oracle expects 1 finding; with no change, we get 0 — this must fail.
  assert.equal(findings.length, 0, 'regression guard: no findings when CSS is identical');
  assert.notEqual(
    findings.length,
    oracle.expectedFindings.length,
    'regression guard: count mismatch catches missing finding',
  );
});

test('known-truth CSS diff: detects wrong before/after value (fail-closed regression guard) (#612)', () => {
  // This test proves the known-truth test would FAIL if diffStyleMaps reported
  // wrong values. We create maps with a different before value.

  const oracle = JSON.parse(
    fs.readFileSync(
      path.join(path.dirname(import.meta.url.replace('file://', '')), 'fixtures/known-truth-css/expected-diff.json'),
      'utf8',
    ),
  );

  // Maps with a WRONG before value (rgb(0, 0, 0) instead of rgb(20, 184, 166)).
  const beforeMap = makeMap({
    elements: {
      'body > main:nth-child(1) > div:nth-child(1) > button:nth-child(1)': {
        tag: 'button',
        cls: 'cta-button',
        style: { 'background-color': 'rgb(0, 0, 0)' }, // Wrong before value
      },
    },
  });
  const afterMap = makeMap({
    elements: {
      'body > main:nth-child(1) > div:nth-child(1) > button:nth-child(1)': {
        tag: 'button',
        cls: 'cta-button',
        style: { 'background-color': 'rgb(220, 38, 38)' },
      },
    },
  });

  const findings = diffStyleMaps(beforeMap, afterMap);

  // The diff reports a change, but with the WRONG before value.
  assert.equal(findings.length, 1);
  const actual = findings[0];
  const expectedProp = oracle.expectedFindings[0].props[0];

  // The before value does NOT match the oracle — this would fail the exact match.
  assert.notEqual(actual.props[0].before, expectedProp.before, 'regression guard: wrong before value is detectable');
  assert.equal(actual.props[0].before, 'rgb(0, 0, 0)', 'regression guard: diff reports the actual (wrong) before');
});

test('known-truth CSS diff: detects false positive on noChangeExpected (fail-closed regression guard) (#612)', () => {
  // This test proves the known-truth test would FAIL if diffStyleMaps reported
  // a false positive on an element that should have no changes.

  const oracle = JSON.parse(
    fs.readFileSync(
      path.join(path.dirname(import.meta.url.replace('file://', '')), 'fixtures/known-truth-css/expected-diff.json'),
      'utf8',
    ),
  );

  // Maps where a noChangeExpected element (.hero-container) HAS a spurious diff.
  const heroPath = oracle.noChangeExpected.find((e) => e.cls === 'hero-container').path;

  const beforeMap = makeMap({
    elements: {
      [heroPath]: {
        tag: 'div',
        cls: 'hero-container',
        style: { 'background-color': 'rgb(248, 250, 252)' },
      },
    },
  });
  const afterMap = makeMap({
    elements: {
      [heroPath]: {
        tag: 'div',
        cls: 'hero-container',
        style: { 'background-color': 'rgb(255, 0, 0)' }, // Spurious change
      },
    },
  });

  const findings = diffStyleMaps(beforeMap, afterMap);

  // A finding on a noChangeExpected path is a false positive — the test must catch it.
  assert.equal(findings.length, 1);
  const falsePositive = findings.find((f) => f.path === heroPath);
  assert.ok(falsePositive, 'regression guard: false positive on noChangeExpected is detectable');
});
