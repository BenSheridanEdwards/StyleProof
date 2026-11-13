import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  correspondBeforeMap,
  correspondContentShiftedPaths,
  correspondenceSignature,
  correspondElementPaths,
  hasMeaningfulSharedPrefix,
  isReNestedPath,
  remapBeforeStyleMap,
  sharedPathPrefix,
} from '../dist/path-correspondence.js';
import { diffContentMaps, diffStyleMaps, presentationDiffStyleMaps } from '../dist/diff.js';
import { makeMap } from './helpers.mjs';

test('correspondenceSignature uses tag + x/y/width + ownTextLength (not height or text)', () => {
  const a = correspondenceSignature({
    tag: 'span',
    cls: 'label secret-class',
    rect: [10, 20, 30, 14],
    ownTextLength: 5,
    style: { 'font-size': '12px' },
    text: 'hello',
  });
  const b = correspondenceSignature({
    tag: 'span',
    cls: 'other',
    rect: [10, 20, 30, 15], // height differs — still same signature
    ownTextLength: 5,
    style: { 'font-size': '13.3333px' },
  });
  assert.equal(a, b);
  assert.ok(a && !a.includes('hello') && !a.includes('secret'));
  // width change breaks the pair
  assert.notEqual(
    a,
    correspondenceSignature({
      tag: 'span',
      cls: '',
      rect: [10, 20, 31, 14],
      ownTextLength: 5,
      style: {},
    }),
  );
});

test('correspondenceSignature is null without a rect or ownTextLength', () => {
  assert.equal(correspondenceSignature({ tag: 'div', cls: '', style: {} }), null);
  assert.equal(
    correspondenceSignature({ tag: 'div', cls: '', rect: [0, 0, 100, 20], style: {} }),
    null,
    'legacy maps without ownTextLength must fail closed',
  );
});

test('shared structural prefix requires a non-empty common ancestor segment', () => {
  assert.equal(sharedPathPrefix('body > button:nth-child(1)', 'body > div:nth-child(1) > button:nth-child(1)'), 'body');
  assert.ok(hasMeaningfulSharedPrefix('body > button:nth-child(1)', 'body > div:nth-child(1) > button:nth-child(1)'));
  assert.equal(sharedPathPrefix('main > span', 'aside > span'), '');
  assert.equal(hasMeaningfulSharedPrefix('main > span', 'aside > span'), false);
});

test('wrapper insert with identical geometry pairs the descendant uniquely', () => {
  const button = {
    tag: 'button',
    cls: 'cta',
    rect: [10, 10, 120, 40],
    ownTextLength: 3,
    style: { 'font-size': '12px' },
  };
  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 800, 600], ownTextLength: 0, style: {} },
      'body > button:nth-child(1)': button,
    },
  });
  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 800, 600], ownTextLength: 0, style: {} },
      'body > div:nth-child(1)': {
        tag: 'div',
        cls: 'wrap',
        rect: [0, 0, 200, 80],
        ownTextLength: 0,
        style: { display: 'block' },
      },
      'body > div:nth-child(1) > button:nth-child(1)': button,
    },
  });
  const mapping = correspondElementPaths(before, after);
  assert.equal(mapping.size, 1);
  assert.equal(mapping.get('body > button:nth-child(1)'), 'body > div:nth-child(1) > button:nth-child(1)');
});

test('presentation diff: wrapper with unchanged descendant collapses to wrapper DOM add only', () => {
  const button = {
    tag: 'button',
    cls: 'cta',
    rect: [10, 10, 120, 40],
    ownTextLength: 3,
    style: { 'background-color': 'rgb(0, 90, 252)', 'font-size': '12px' },
  };
  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 800, 600], ownTextLength: 0, style: {} },
      'body > button:nth-child(1)': button,
    },
  });
  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 800, 600], ownTextLength: 0, style: {} },
      'body > div:nth-child(1)': {
        tag: 'div',
        cls: 'wrap',
        rect: [0, 0, 200, 80],
        ownTextLength: 0,
        style: { padding: '8px' },
      },
      'body > div:nth-child(1) > button:nth-child(1)': { ...button },
    },
  });

  const raw = diffStyleMaps(before, after);
  assert.ok(raw.some((f) => f.kind === 'dom' && f.change === 'removed' && f.path === 'body > button:nth-child(1)'));
  assert.ok(raw.filter((f) => f.kind === 'dom' && f.change === 'added').length >= 2);

  const presented = presentationDiffStyleMaps(before, after);
  const dom = presented.filter((f) => f.kind === 'dom');
  assert.equal(dom.filter((f) => f.change === 'removed').length, 0, 'corresponded button removal collapses');
  assert.ok(
    dom.some((f) => f.change === 'added' && f.path === 'body > div:nth-child(1)'),
    'new wrapper remains a DOM add',
  );
  assert.equal(
    presented.filter((f) => f.kind === 'style' && f.path.includes('button')).length,
    0,
    'unchanged corresponded button is not a restyle',
  );
});

test('presentation diff: wrapper with true font-size delta shows paired before→after', () => {
  const baseBtn = {
    tag: 'span',
    cls: 'label',
    rect: [40, 40, 80, 14],
    ownTextLength: 4,
    style: { 'font-size': '12px', height: '14px' },
  };
  const headBtn = {
    ...baseBtn,
    rect: [40, 40, 80, 15], // height change only — still pairs (height ignored)
    style: { 'font-size': '13.3333px', height: '15px' },
  };
  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 800, 600], ownTextLength: 0, style: {} },
      'body > span:nth-child(1)': baseBtn,
    },
  });
  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 800, 600], ownTextLength: 0, style: {} },
      'body > div:nth-child(1)': {
        tag: 'div',
        cls: 'wrap',
        rect: [30, 30, 100, 40],
        ownTextLength: 0,
        style: {},
      },
      'body > div:nth-child(1) > span:nth-child(1)': headBtn,
    },
  });

  const presented = presentationDiffStyleMaps(before, after);
  const style = presented.find(
    (f) => f.kind === 'style' && f.path === 'body > div:nth-child(1) > span:nth-child(1)' && f.pseudo === null,
  );
  assert.ok(style, 'paired style finding at head path');
  const font = style.props.find((p) => p.prop === 'font-size');
  assert.deepEqual(font, { prop: 'font-size', before: '12px', after: '13.3333px' });
  const height = style.props.find((p) => p.prop === 'height');
  assert.ok(height, 'height geometry effect still reported on the pair');
  assert.equal(height.before, '14px');
  assert.equal(height.after, '15px');
  assert.equal(
    presented.filter((f) => f.kind === 'dom' && f.change === 'removed').length,
    0,
    'no unpaired removal for the corresponded leaf',
  );
});

test('ambiguous duplicate signatures remain unmatched', () => {
  const twin = {
    tag: 'button',
    cls: 'chip',
    rect: [0, 0, 64, 24],
    ownTextLength: 1,
    style: { color: 'rgb(0, 0, 0)' },
  };
  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 400, 200], ownTextLength: 0, style: {} },
      'body > button:nth-child(1)': twin,
      'body > button:nth-child(2)': { ...twin },
    },
  });
  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 400, 200], ownTextLength: 0, style: {} },
      'body > section:nth-child(1)': {
        tag: 'section',
        cls: 'row',
        rect: [0, 0, 400, 80],
        ownTextLength: 0,
        style: {},
      },
      'body > section:nth-child(1) > button:nth-child(1)': { ...twin },
      'body > section:nth-child(1) > button:nth-child(2)': { ...twin },
    },
  });
  assert.equal(correspondElementPaths(before, after).size, 0);
  const presented = presentationDiffStyleMaps(before, after);
  assert.ok(presented.some((f) => f.kind === 'dom' && f.change === 'removed'));
  assert.ok(presented.some((f) => f.kind === 'dom' && f.change === 'added'));
  // Inventory rows on unpaired adds are fine; invented *paired* restyles are not.
  // A paired restyle sits on a path present in both maps after correspondence —
  // which would mean no DOM add/remove for that path.
  const oneSided = new Set(
    presented.filter((f) => f.kind === 'dom' && (f.change === 'added' || f.change === 'removed')).map((f) => f.path),
  );
  const pairedButtonStyles = presented.filter(
    (f) => f.kind === 'style' && f.path.includes('button') && !oneSided.has(f.path),
  );
  assert.equal(pairedButtonStyles.length, 0, 'duplicates must not invent paired restyles');
});

test('remapBeforeStyleMap rewrites forced-state owner and target paths when safe', () => {
  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 100, 100], style: {} },
      'body > button:nth-child(1)': {
        tag: 'button',
        cls: 'x',
        rect: [1, 1, 10, 10],
        ownTextLength: 0,
        style: {},
      },
    },
    states: {
      'body > button:nth-child(1)': {
        hover: {
          'body > button:nth-child(1)': { color: 'rgb(0, 0, 0)' },
          'body > button:nth-child(1)::before': { opacity: '1' },
        },
      },
    },
  });
  const mapping = new Map([['body > button:nth-child(1)', 'body > div:nth-child(1) > button:nth-child(1)']]);
  const remapped = remapBeforeStyleMap(before, mapping);
  assert.ok(remapped.elements['body > div:nth-child(1) > button:nth-child(1)']);
  assert.equal(remapped.elements['body > button:nth-child(1)'], undefined);
  assert.deepEqual(remapped.states['body > div:nth-child(1) > button:nth-child(1)'].hover, {
    'body > div:nth-child(1) > button:nth-child(1)': { color: 'rgb(0, 0, 0)' },
    'body > div:nth-child(1) > button:nth-child(1)::before': { opacity: '1' },
  });
});

test('remapBeforeStyleMap rewrites the forced Typed OM margin proof with its owner and target', () => {
  // Left on a stale path, a moved target would read as "computed margins unchanged from rest" (#917).
  const forced = { 'margin-left': '40px', 'margin-right': '40px' };
  const before = {
    ...makeMap({
      elements: { 'body > button:nth-child(1)': { tag: 'button', rect: [1, 1, 10, 10], ownTextLength: 0 } },
    }),
    stateComputedValueStyle: { 'body > button:nth-child(1)': { hover: { 'body > button:nth-child(1)': forced } } },
  };
  const moved = 'body > div:nth-child(1) > button:nth-child(1)';
  const remapped = remapBeforeStyleMap(before, new Map([['body > button:nth-child(1)', moved]]));
  assert.deepEqual(remapped.stateComputedValueStyle, { [moved]: { hover: { [moved]: forced } } });
});

test('remapBeforeStyleMap leaves a legacy map without the margin proof without it', () => {
  const before = makeMap({
    elements: { 'body > button:nth-child(1)': { tag: 'button', rect: [1, 1, 10, 10], ownTextLength: 0 } },
  });
  const remapped = remapBeforeStyleMap(
    before,
    new Map([['body > button:nth-child(1)', 'body > div:nth-child(1) > button:nth-child(1)']]),
  );
  assert.equal('stateComputedValueStyle' in remapped, false);
});

test('raw diffStyleMaps is unchanged by the correspondence helpers (correspondence is applied by diffStyleMapDirs)', () => {
  const button = {
    tag: 'button',
    cls: 'cta',
    rect: [10, 10, 120, 40],
    ownTextLength: 3,
    style: { 'font-size': '12px' },
  };
  const before = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 800, 600], ownTextLength: 0, style: {} },
      'body > button:nth-child(1)': button,
    },
  });
  const after = makeMap({
    elements: {
      body: { tag: 'body', rect: [0, 0, 800, 600], ownTextLength: 0, style: {} },
      'body > div:nth-child(1)': {
        tag: 'div',
        cls: 'wrap',
        rect: [0, 0, 200, 80],
        ownTextLength: 0,
        style: {},
      },
      'body > div:nth-child(1) > button:nth-child(1)': {
        ...button,
        style: { 'font-size': '14px' },
      },
    },
  });
  const rawA = diffStyleMaps(before, after);
  const rawB = diffStyleMaps(before, after);
  assert.deepEqual(rawA, rawB);
  // Presentation may pair; raw still sees remove + add (+ inventories).
  assert.ok(rawA.some((f) => f.kind === 'dom' && f.change === 'removed'));
  assert.ok(rawA.filter((f) => f.kind === 'dom' && f.change === 'added').length >= 2);
  const presented = presentationDiffStyleMaps(before, after);
  assert.notDeepEqual(presented, rawA);
});

// ─── re-nesting (#472) ───────────────────────────────────────────────────────

test('isReNestedPath: a wrapper added or removed around the same leaf is a re-nesting', () => {
  const flat = 'div:nth-child(1) > button:nth-child(1)';
  const wrapped = 'div:nth-child(1) > div:nth-child(1) > button:nth-child(1)';
  assert.equal(isReNestedPath(flat, wrapped), true, 'wrapper added');
  assert.equal(isReNestedPath(wrapped, flat), true, 'wrapper removed');
  // The wrapped element's own index may change; hashed semantic segments may not.
  assert.equal(isReNestedPath(flat, 'div:nth-child(1) > div:nth-child(1) > button:nth-child(2)'), true);
  assert.equal(
    isReNestedPath('div:sp-key(abc) > button:nth-child(1)', 'div:sp-key(xyz) > div:nth-child(1) > button:nth-child(1)'),
    false,
  );
  // Different leaf, same length, or an unrelated subtree is never a re-nesting.
  assert.equal(isReNestedPath(flat, 'div:nth-child(1) > div:nth-child(1) > a:nth-child(1)'), false);
  assert.equal(isReNestedPath(flat, 'section:nth-child(1) > button:nth-child(1)'), false);
  assert.equal(isReNestedPath(flat, 'aside:nth-child(2) > p:nth-child(1) > button:nth-child(1)'), false);
});

test('a wrapper inserted at the document root (no shared ancestor) still pairs the descendant', () => {
  const button = {
    tag: 'button',
    cls: 'cta',
    rect: [10, 10, 120, 40],
    ownTextLength: 3,
    style: { color: 'rgb(255, 0, 0)' },
  };
  const before = makeMap({ elements: { 'button:nth-child(1)': button } });
  const after = makeMap({
    elements: {
      'div:nth-child(1)': { tag: 'div', cls: 'wrap', rect: [0, 0, 200, 80], ownTextLength: 0, style: {} },
      'div:nth-child(1) > button:nth-child(1)': { ...button, style: { color: 'rgb(0, 128, 0)' } },
    },
  });
  assert.equal(hasMeaningfulSharedPrefix('button:nth-child(1)', 'div:nth-child(1) > button:nth-child(1)'), false);
  const mapping = correspondElementPaths(before, after);
  assert.equal(mapping.get('button:nth-child(1)'), 'div:nth-child(1) > button:nth-child(1)');
  const findings = presentationDiffStyleMaps(before, after, { includeStructure: false });
  assert.deepEqual(
    findings.map((f) => [f.kind, f.props?.map((p) => `${p.prop}:${p.before}->${p.after}`)]),
    [['style', ['color:rgb(255, 0, 0)->rgb(0, 128, 0)']]],
  );
});

test('correspondBeforeMap runs the nth-child shift first, then geometry among what is still one-sided', () => {
  const button = {
    tag: 'button',
    cls: 'cta',
    rect: [10, 60, 120, 40],
    ownTextLength: 3,
    style: { color: 'rgb(255, 0, 0)' },
  };
  const card = { tag: 'div', cls: 'card', rect: [0, 50, 200, 80], ownTextLength: 0, style: {} };
  const before = makeMap({
    elements: { 'div:nth-child(1)': card, 'div:nth-child(1) > button:nth-child(1)': button },
    states: {
      'div:nth-child(1) > button:nth-child(1)': {
        hover: { 'div:nth-child(1) > button:nth-child(1)': { color: 'rgb(200, 0, 0)' } },
      },
    },
  });
  // Head: a banner inserted BEFORE the card (nth-child shift) AND the button re-nested in a wrapper.
  const after = makeMap({
    elements: {
      'p:nth-child(1)': { tag: 'p', cls: 'banner', rect: [0, 0, 200, 40], ownTextLength: 12, style: {} },
      'div:nth-child(2)': card,
      'div:nth-child(2) > div:nth-child(1)': {
        tag: 'div',
        cls: 'card__body',
        rect: [0, 50, 200, 80],
        ownTextLength: 0,
        style: {},
      },
      'div:nth-child(2) > div:nth-child(1) > button:nth-child(1)': button,
    },
  });
  const corresponded = correspondBeforeMap(before, after);
  assert.deepEqual(Object.keys(corresponded.elements).sort(), [
    'div:nth-child(2)',
    'div:nth-child(2) > div:nth-child(1) > button:nth-child(1)',
  ]);
  assert.deepEqual(Object.keys(corresponded.states), ['div:nth-child(2) > div:nth-child(1) > button:nth-child(1)']);
  assert.deepEqual(
    Object.keys(corresponded.states['div:nth-child(2) > div:nth-child(1) > button:nth-child(1)'].hover),
    ['div:nth-child(2) > div:nth-child(1) > button:nth-child(1)'],
  );
});

test('a content-shifted owner carries its ::after hover target to the head path (#948)', () => {
  // A banner row inserted first shifts both rows down one nth-child; each row's
  // :hover recolours its own ::after.
  const item = (n) => `body > ul:nth-child(1) > li:nth-child(${n})`;
  const row = { tag: 'li', cls: 'row', ownTextLength: 4, style: {} };
  const hoverAfter = (n, color) => ({ [item(n)]: { hover: { [`${item(n)}::after`]: { color } } } });
  const before = makeMap({
    elements: { [item(1)]: row, [item(2)]: row },
    states: { ...hoverAfter(1, 'rgb(0, 0, 200)'), ...hoverAfter(2, 'rgb(0, 0, 200)') },
  });
  const after = (lastColor) =>
    makeMap({
      elements: { [item(1)]: { ...row, cls: 'banner' }, [item(2)]: row, [item(3)]: row },
      states: { ...hoverAfter(2, 'rgb(0, 0, 200)'), ...hoverAfter(3, lastColor) },
    });
  const certify = (head) =>
    diffStyleMaps(correspondBeforeMap(before, head), head, { includeStructure: false }).map((f) => [
      f.kind,
      f.path,
      f.sub,
      f.props.map((p) => p.prop),
    ]);
  assert.deepEqual(certify(after('rgb(0, 0, 200)')), [], 'an unchanged ::after target is not one-sided');
  assert.deepEqual(certify(after('rgb(200, 0, 0)')), [['state', item(3), `${item(3)}::after`, ['color']]]);
});

test('correspondContentShiftedPaths leaves the base map as it is when the sibling paths are the same on both sides', () => {
  // A modifier class moved from the first row to the third: every path exists on
  // both sides, so no sibling was inserted or removed and nothing may be re-paired.
  const rowPath = (position) => `ul:nth-child(1) > li:nth-child(${position})`;
  const rows = (current) =>
    makeMap({
      elements: Object.fromEntries(
        [1, 2, 3].map((position) => [
          rowPath(position),
          {
            tag: 'li',
            cls: position === current ? 'item current' : 'item',
            rect: [0, (position - 1) * 24, 400, 24],
            ownTextLength: 0,
            style: { 'background-color': position === current ? 'rgb(230, 240, 255)' : 'rgba(0, 0, 0, 0)' },
          },
        ]),
      ),
    });
  const before = rows(1);
  assert.deepEqual(correspondContentShiftedPaths(before, rows(3)).elements, before.elements);
});

test('an ambiguous geometry signature stays one-sided (fails closed) even when re-nested', () => {
  const button = {
    tag: 'button',
    cls: 'cta',
    rect: [10, 10, 120, 40],
    ownTextLength: 3,
    style: { color: 'rgb(255, 0, 0)' },
  };
  // Two overlapping buttons with identical geometry: no unique identity → no pairing.
  const before = makeMap({ elements: { 'button:nth-child(1)': button, 'button:nth-child(2)': button } });
  const after = makeMap({
    elements: {
      'div:nth-child(1)': { tag: 'div', cls: 'wrap', rect: [0, 0, 200, 80], ownTextLength: 0, style: {} },
      'div:nth-child(1) > button:nth-child(1)': { ...button, style: { color: 'rgb(0, 128, 0)' } },
      'div:nth-child(1) > button:nth-child(2)': button,
    },
  });
  assert.equal(correspondElementPaths(before, after).size, 0);
});

test('certification never pairs an element whose hashed identity was replaced, even with identical geometry', () => {
  // A row that lost its `data-style` identity: the same box, but a developer-authored
  // identity replacement is structural (the 5.0.2 rule), never a restyle to pair back.
  const row = { tag: 'tr', cls: '', rect: [0, 0, 400, 24], ownTextLength: 10, style: { color: 'rgb(0, 90, 180)' } };
  const before = makeMap({ elements: { 'table:nth-child(1) > tbody:nth-child(1) > tr:sp-key(abc123)': row } });
  const after = makeMap({
    elements: {
      'table:nth-child(1) > tbody:nth-child(1) > tr:nth-child(1)': { ...row, style: { color: 'rgb(0, 0, 0)' } },
    },
  });
  // Presentation (geometry-only) may still pair it for crops…
  assert.equal(correspondElementPaths(before, after).size, 1);
  // …but certification keeps it one-sided, so the gate reports no restyle here.
  assert.deepEqual(Object.keys(correspondBeforeMap(before, after).elements), [
    'table:nth-child(1) > tbody:nth-child(1) > tr:sp-key(abc123)',
  ]);
  assert.equal(diffStyleMaps(correspondBeforeMap(before, after), after, { includeStructure: false }).length, 0);
});

test('certification keeps the DESCENDANTS of an identity-replaced element one-sided too', () => {
  // The row lost its `data-style`; its cell kept the same box and inherits the row's
  // colour. Pairing the cell alone would report the inherited change as a cell restyle.
  const cell = { tag: 'td', cls: '', rect: [0, 0, 400, 24], ownTextLength: 10, style: { color: 'rgb(0, 90, 180)' } };
  const before = makeMap({
    elements: {
      'table:nth-child(1) > tbody:nth-child(1) > tr:sp-key(abc123)': {
        tag: 'tr',
        cls: '',
        rect: [0, 0, 400, 24],
        ownTextLength: 0,
        style: {},
      },
      'table:nth-child(1) > tbody:nth-child(1) > tr:sp-key(abc123) > td:nth-child(1)': cell,
    },
  });
  const after = makeMap({
    elements: {
      'table:nth-child(1) > tbody:nth-child(1) > tr:nth-child(1)': {
        tag: 'tr',
        cls: '',
        rect: [0, 0, 400, 24],
        ownTextLength: 0,
        style: {},
      },
      'table:nth-child(1) > tbody:nth-child(1) > tr:nth-child(1) > td:nth-child(1)': {
        ...cell,
        style: { color: 'rgb(0, 0, 0)' },
      },
    },
  });
  assert.equal(diffStyleMaps(correspondBeforeMap(before, after), after, { includeStructure: false }).length, 0);
  // A wrapper WITHOUT identity around the same cell still pairs (no hashed identity changed).
  const wrapped = makeMap({
    elements: {
      'table:nth-child(1) > tbody:nth-child(1) > tr:sp-key(abc123)': {
        tag: 'tr',
        cls: '',
        rect: [0, 0, 400, 24],
        ownTextLength: 0,
        style: {},
      },
      'table:nth-child(1) > tbody:nth-child(1) > tr:sp-key(abc123) > td:nth-child(1)': {
        tag: 'td',
        cls: '',
        rect: [0, 0, 400, 24],
        ownTextLength: 0,
        style: {},
      },
      'table:nth-child(1) > tbody:nth-child(1) > tr:sp-key(abc123) > td:nth-child(1) > span:nth-child(1)': {
        ...cell,
        tag: 'span',
        style: { color: 'rgb(0, 0, 0)' },
      },
    },
  });
  const beforeSpan = makeMap({
    elements: {
      'table:nth-child(1) > tbody:nth-child(1) > tr:sp-key(abc123)': {
        tag: 'tr',
        cls: '',
        rect: [0, 0, 400, 24],
        ownTextLength: 0,
        style: {},
      },
      'table:nth-child(1) > tbody:nth-child(1) > tr:sp-key(abc123) > span:nth-child(1)': { ...cell, tag: 'span' },
    },
  });
  const findings = diffStyleMaps(correspondBeforeMap(beforeSpan, wrapped), wrapped, { includeStructure: false });
  assert.deepEqual(
    findings.map((f) => [f.kind, f.props.map((p) => p.prop)]),
    [['style', ['color']]],
  );
});

// Two renamed labels can leave an old and a new text of the same length on different
// siblings. With own text captured, that coincidence must not read as an nth-child shift.
const navItems = (labels, withText) =>
  makeMap({
    elements: Object.fromEntries(
      labels.map((label, i) => [
        `body > nav:nth-child(1) > button:nth-child(${i + 1})`,
        {
          tag: 'button',
          cls: 'nav-item',
          rect: [0, i * 40, 220, 40],
          ownTextLength: label.length,
          ...(withText ? { text: label } : {}),
        },
      ]),
    ),
  });
const BASE_LABELS = ['Overview', 'Audit log', 'Members', 'Billing', 'Settings'];
const HEAD_LABELS = ['Overview', 'Audit trail', 'People', 'Invoices', 'Preferences'];
const item = (n) => `body > nav:nth-child(1) > button:nth-child(${n})`;

test('renamed labels of equal length are not paired as an nth-child shift when own text is captured', () => {
  const before = navItems(BASE_LABELS, true);
  const shifted = correspondContentShiftedPaths(before, navItems(HEAD_LABELS, true));
  assert.equal(shifted.elements[item(4)].text, 'Billing', 'the fourth item keeps its own path');
  assert.equal(shifted.elements[item(5)].text, 'Settings', 'the fifth item is not moved onto the fourth');
  assert.equal(Object.keys(shifted.elements).length, 5, 'no base element is dropped');
});

test('without captured own text, an equal-length pair still reads as an nth-child shift', () => {
  const before = navItems(BASE_LABELS, false);
  const shifted = correspondContentShiftedPaths(before, navItems(HEAD_LABELS, false));
  assert.equal(shifted.elements[item(4)].ownTextLength, 'Settings'.length, 'length is the only evidence, as before');
});

// The mirror case: a sibling is inserted before a label, and the shifted label is also
// renamed to text of the same length. The head no longer holds a label at the old path,
// so only the shift explains the evidence and the label must still pair with itself.
const toolbarSlot = (n) => `body > div:nth-child(1) > span:nth-child(${n})`;
const toolbarEntry = (className, label) => ({
  tag: 'span',
  cls: className,
  rect: [0, 0, 80, 20],
  ownTextLength: label.length,
  text: label,
});

test('a real nth-child shift whose label is renamed to the same length still pairs the label with itself', () => {
  const before = makeMap({ elements: { [toolbarSlot(1)]: toolbarEntry('label', 'Save') } });
  const after = makeMap({
    elements: {
      [toolbarSlot(1)]: toolbarEntry('notice', 'Help'),
      [toolbarSlot(2)]: toolbarEntry('label', 'Send'),
    },
  });
  const shifted = correspondContentShiftedPaths(before, after);
  assert.deepEqual(Object.keys(shifted.elements), [toolbarSlot(2)], 'the label moves onto its shifted path');
  assert.deepEqual(diffContentMaps(before, after), [
    { kind: 'structure', path: toolbarSlot(1), cls: 'notice', change: 'added' },
    { kind: 'text', path: toolbarSlot(2), cls: 'label', before: 'Save', after: 'Send' },
  ]);
});

// Further down a shift chain, the head element at a moved element's old path is the previous
// shifted sibling, which always has the same shape. That must not read as a rename in place.
const NOTICE_STYLE = { color: 'rgb(120, 60, 0)', 'background-color': 'rgb(255, 240, 200)' };
const LABEL_STYLE = { color: 'rgb(20, 20, 20)', 'background-color': 'rgb(255, 255, 255)' };
const styledToolbarEntry = (className, label) => ({
  ...toolbarEntry(className, label),
  style: className === 'notice' ? NOTICE_STYLE : LABEL_STYLE,
});
const toolbar = (entries) =>
  makeMap({
    elements: Object.fromEntries(
      entries.map(([className, label], index) => [toolbarSlot(index + 1), styledToolbarEntry(className, label)]),
    ),
  });

test('a shift chain whose later labels are renamed to the same length still pairs every label with itself', () => {
  const before = toolbar([
    ['label', 'Save'],
    ['label', 'Load'],
  ]);
  const after = toolbar([
    ['notice', 'Note'],
    ['label', 'Send'],
    ['label', 'Read'],
  ]);
  assert.deepEqual(diffContentMaps(before, after), [
    { kind: 'structure', path: toolbarSlot(1), cls: 'notice', change: 'added' },
    { kind: 'text', path: toolbarSlot(2), cls: 'label', before: 'Save', after: 'Send' },
    { kind: 'text', path: toolbarSlot(3), cls: 'label', before: 'Load', after: 'Read' },
  ]);
  assert.deepEqual(
    diffStyleMaps(correspondBeforeMap(before, after), after, { includeStructure: false }),
    [],
    'certification sees no restyle on the inserted notice',
  );
});

test('a shift chain with duplicate labels and a later same-length rename still pairs every label with itself', () => {
  const before = toolbar([
    ['label', 'Copy'],
    ['label', 'Copy'],
    ['label', 'Load'],
  ]);
  const after = toolbar([
    ['notice', 'Note'],
    ['label', 'Copy'],
    ['label', 'Copy'],
    ['label', 'Read'],
  ]);
  assert.deepEqual(diffContentMaps(before, after), [
    { kind: 'structure', path: toolbarSlot(1), cls: 'notice', change: 'added' },
    { kind: 'text', path: toolbarSlot(4), cls: 'label', before: 'Load', after: 'Read' },
  ]);
  assert.deepEqual(diffStyleMaps(correspondBeforeMap(before, after), after, { includeStructure: false }), []);
});

// A shift chain can span labels of different text lengths, so the element shifted onto a
// label's old path can come from another signature group or from own-text identity.
const RESTYLED_LABEL_STYLE = { color: 'rgb(200, 0, 0)', 'background-color': 'rgb(255, 255, 255)' };

test('a shift chain across text lengths still pairs a renamed label and certifies its restyle', () => {
  const before = toolbar([
    ['label', 'Save'],
    ['label', 'Close'],
  ]);
  const after = toolbar([
    ['notice', 'Notice'],
    ['label', 'Save'],
    ['label', 'Clear'],
  ]);
  after.elements[toolbarSlot(3)].style = RESTYLED_LABEL_STYLE;
  assert.deepEqual(diffContentMaps(before, after), [
    { kind: 'structure', path: toolbarSlot(1), cls: 'notice', change: 'added' },
    { kind: 'text', path: toolbarSlot(3), cls: 'label', before: 'Close', after: 'Clear' },
  ]);
  assert.deepEqual(
    diffStyleMaps(correspondBeforeMap(before, after), after, { includeStructure: false }).map((finding) => [
      finding.path,
      finding.props.map((property) => property.prop),
    ]),
    [[toolbarSlot(3), ['color']]],
    'the restyle of the shifted label is certified',
  );
});

test('a same-shape sibling of another text length inserted before a renamed label reads as a shift', () => {
  const before = toolbar([['label', 'Save']]);
  const after = toolbar([
    ['label', 'Hi'],
    ['label', 'Send'],
  ]);
  after.elements[toolbarSlot(2)].style = RESTYLED_LABEL_STYLE;
  assert.deepEqual(diffContentMaps(before, after), [
    { kind: 'structure', path: toolbarSlot(1), cls: 'label', change: 'added' },
    { kind: 'text', path: toolbarSlot(2), cls: 'label', before: 'Save', after: 'Send' },
  ]);
  assert.deepEqual(
    diffStyleMaps(correspondBeforeMap(before, after), after, { includeStructure: false }).map((finding) => [
      finding.path,
      finding.props.map((property) => property.prop),
    ]),
    [[toolbarSlot(2), ['color']]],
    'the restyle of the shifted label is certified',
  );
});

// An inserted or removed sibling can sit in a group of its own text length, which changes size and
// contributes no move. The labels that shift past it must still pair as a shift.
const labelToolbar = (labels) => toolbar(labels.map((label) => ['label', label]));
const certifiedRestyles = (before, after) =>
  diffStyleMaps(correspondBeforeMap(before, after), after, { includeStructure: false }).map((finding) => [
    finding.path,
    finding.props.map((property) => property.prop),
  ]);

test('a label inserted before renamed labels of colliding lengths still certifies the restyle main certifies', () => {
  const before = labelToolbar(['Save', 'Cut', 'Cut', 'Copy']);
  const after = labelToolbar(['Cut', 'Send', 'Cut', 'Cut', 'Code']);
  after.elements[toolbarSlot(5)].style = RESTYLED_LABEL_STYLE;
  assert.deepEqual(certifiedRestyles(before, after), [[toolbarSlot(5), ['color']]]);
});

test('a label removed before renamed labels of colliding lengths still certifies the restyle main certifies', () => {
  const before = labelToolbar(['Old', 'Save', 'Cut', 'Copy']);
  const after = labelToolbar(['Send', 'Cat', 'Code']);
  after.elements[toolbarSlot(3)].style = RESTYLED_LABEL_STYLE;
  assert.deepEqual(certifiedRestyles(before, after), [[toolbarSlot(3), ['color']]]);
});

test('reordered siblings of different classes keep the base elements that main keeps', () => {
  const before = toolbar([
    ['notice', 'a'],
    ['label', 'b'],
    ['label', 'c'],
    ['label', 'dd'],
  ]);
  const after = toolbar([
    ['label', 'h'],
    ['notice', 'g'],
    ['label', 'fff'],
    ['label', 'e'],
  ]);
  const shifted = correspondContentShiftedPaths(before, after);
  assert.deepEqual(
    Object.entries(shifted.elements).map(([elementPath, element]) => [elementPath, element.text]),
    [
      [toolbarSlot(1), 'a'],
      [toolbarSlot(2), 'b'],
      [toolbarSlot(4), 'c'],
    ],
  );
});

// Nested markup: an item inserted one level up leaves each label's own parent unchanged, so the
// list to judge is the one where the two paths diverge.
const navigationLink = (n) => `body > ul:nth-child(1) > li:nth-child(${n}) > a:nth-child(1)`;
const navigationList = (labels) =>
  makeMap({
    elements: Object.fromEntries(
      labels.flatMap((label, index) => [
        [
          `body > ul:nth-child(1) > li:nth-child(${index + 1})`,
          { tag: 'li', cls: 'item', rect: [0, index * 40, 220, 40], ownTextLength: 0 },
        ],
        [
          navigationLink(index + 1),
          { tag: 'a', cls: 'link', rect: [0, index * 40, 220, 40], ownTextLength: label.length, text: label },
        ],
      ]),
    ),
  });

test('an item inserted above nested links does not pair a renamed link with the inserted one', () => {
  const textChanges = diffContentMaps(navigationList(['Billing', 'Undo']), navigationList(['Log', 'Profile', 'Add']))
    .filter((change) => change.kind === 'text')
    .map((change) => [change.path, change.before, change.after]);
  assert.deepEqual(textChanges, [[navigationLink(2), 'Billing', 'Profile']]);
});

// One signature group can span several lists with the same path pattern: a rename in one list
// must not cancel a real shift in another.
const toolbarButton = (toolbarIndex, n) => `body > nav:nth-child(${toolbarIndex}) > button:nth-child(${n})`;
const toolbars = (...lists) =>
  makeMap({
    elements: Object.fromEntries(
      lists.flatMap((labels, toolbarIndex) =>
        labels.map((label, index) => [
          toolbarButton(toolbarIndex + 1, index + 1),
          {
            tag: 'button',
            cls: 'tool',
            rect: [index * 80, toolbarIndex * 40, 80, 40],
            ownTextLength: label.length,
            text: label,
            style: LABEL_STYLE,
          },
        ]),
      ),
    ),
  });

test('a rename in one toolbar does not cancel a real shift and its restyle in another', () => {
  const before = toolbars(['Cut', 'Copy'], ['Copy']);
  const after = toolbars(['Undo', 'Paste'], ['Hi', 'Copy']);
  after.elements[toolbarButton(2, 2)].style = RESTYLED_LABEL_STYLE;
  assert.deepEqual(certifiedRestyles(before, after), [[toolbarButton(2, 2), ['color']]]);
});

// A group spanning two toolbars can pair across them. A removal in one toolbar must keep that move,
// even when the toolbars' shared ancestor is unchanged, so the shifted sibling still pairs.
const placedSpan = (elementPath, className, text, rect) => [
  elementPath,
  {
    tag: 'span',
    cls: className,
    rect,
    ownTextLength: text.length,
    text,
    style: className.includes('primary') ? RESTYLED_LABEL_STYLE : LABEL_STYLE,
  },
];

test('a rename in one toolbar and a removal in another still certify the shifted sibling restyle', () => {
  // A heading with the same text keeps own-text identity from pairing the shifted label.
  const heading = placedSpan('body > header:nth-child(1) > span:nth-child(1)', 'title', 'Notice', [0, 0, 120, 20]);
  const before = makeMap({
    elements: Object.fromEntries([
      heading,
      placedSpan('body > nav:nth-child(2) > span:nth-child(1)', 'label', 'Overview', [0, 40, 80, 20]),
      placedSpan('body > nav:nth-child(3) > span:nth-child(1)', 'label', 'Load', [300, 80, 60, 20]),
      placedSpan('body > nav:nth-child(3) > span:nth-child(2)', 'label primary', 'Notice', [360, 80, 60, 20]),
    ]),
  });
  const after = makeMap({
    elements: Object.fromEntries([
      heading,
      placedSpan('body > nav:nth-child(2) > span:nth-child(1)', 'label', 'Copy', [0, 40, 80, 20]),
      placedSpan('body > nav:nth-child(3) > span:nth-child(1)', 'label', 'Notice', [360, 80, 60, 20]),
    ]),
  });
  assert.deepEqual(certifiedRestyles(before, after), [['body > nav:nth-child(3) > span:nth-child(1)', ['color']]]);
});

// A same-shape container inserted above the point where two paths diverge renumbers the old
// container; the lists up to the root must be unchanged for a move to read as a rename in place.
const DEFAULT_STYLE = { color: 'rgb(20, 20, 20)' };
const KEPT_STYLE = { color: 'rgb(0, 100, 0)' };
const menu = (menuIndex) => [
  `body > ul:nth-child(${menuIndex})`,
  { tag: 'ul', cls: 'menu', style: DEFAULT_STYLE, ownTextLength: 0 },
];
const menuItem = (menuIndex, itemIndex, text, style = DEFAULT_STYLE, className = 'link') => [
  [
    `body > ul:nth-child(${menuIndex}) > li:nth-child(${itemIndex})`,
    { tag: 'li', cls: 'item', style: DEFAULT_STYLE, ownTextLength: 0 },
  ],
  [
    `body > ul:nth-child(${menuIndex}) > li:nth-child(${itemIndex}) > a:nth-child(1)`,
    { tag: 'a', cls: className, style, ownTextLength: text.length, text },
  ],
];
const page = (...entries) =>
  makeMap({
    elements: Object.fromEntries([
      ['body', { tag: 'body', cls: '', style: DEFAULT_STYLE, ownTextLength: 0 }],
      ...entries,
    ]),
  });

test('a menu inserted before a reworded menu certifies nothing that main does not', () => {
  const before = page(
    menu(1),
    ...menuItem(1, 1, 'Share'),
    ...menuItem(1, 2, 'Code', KEPT_STYLE),
    ...menuItem(1, 3, 'Print'),
  );
  const after = page(
    menu(1),
    ...menuItem(1, 1, 'Edit'),
    ...menuItem(1, 2, 'Close'),
    ...menuItem(1, 3, 'Edit', DEFAULT_STYLE, 'link external'),
    menu(2),
    ...menuItem(2, 1, 'Code', KEPT_STYLE),
    ...menuItem(2, 2, 'Merge'),
  );
  assert.deepEqual(certifiedRestyles(before, after), []);
});

test('renamed labels of equal length with a styled active item certify no restyle of the wrong item', () => {
  const ACTIVE_STYLE = { color: 'rgb(0, 80, 200)' };
  const before = navItems(BASE_LABELS, true);
  const after = navItems(HEAD_LABELS, true);
  before.elements[item(5)].style = ACTIVE_STYLE;
  after.elements[item(5)].style = ACTIVE_STYLE;
  assert.deepEqual(certifiedRestyles(before, after), []);
});

test('an equal-length rename beside an unanchored insert and removal reads as renames in place (#1330, documented limit)', () => {
  const links = (items) =>
    makeMap({
      elements: Object.fromEntries(
        items.map(([text, style], index) => [
          `body > nav:nth-child(1) > a:nth-child(${index + 1})`,
          { tag: 'a', cls: 'label', text, ownTextLength: text.length, style },
        ]),
      ),
    });
  const before = links([
    ['One', DEFAULT_STYLE],
    ['Two', DEFAULT_STYLE],
    ['Three', DEFAULT_STYLE],
    ['Seventh', DEFAULT_STYLE],
    ['Final', KEPT_STYLE],
  ]);
  const after = links([
    ['One', DEFAULT_STYLE],
    ['Two', DEFAULT_STYLE],
    ['Three', DEFAULT_STYLE],
    ['Hi', DEFAULT_STYLE],
    ['Changed', KEPT_STYLE],
  ]);
  // Every position keeps its computed style; the capture cannot tell this from the #1322 renamed-label case.
  assert.deepEqual(certifiedRestyles(before, after), []);
});
