import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  correspondBeforeMap,
  correspondenceSignature,
  correspondElementPaths,
  hasMeaningfulSharedPrefix,
  isReNestedPath,
  remapBeforeStyleMap,
  sharedPathPrefix,
} from '../dist/path-correspondence.js';
import { diffStyleMaps, presentationDiffStyleMaps } from '../dist/diff.js';
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
