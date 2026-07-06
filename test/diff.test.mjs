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
