// Every wrong-control case from QA11 (RV11-01), QA12-01 and QA13-01/02/03 as a synthetic capture.
// From the round-13 diagnosis (check/round-13/diag/scripts/cases.mjs). Test-only.
const G = 'rgb(20, 120, 60)',
  R = 'rgb(160, 40, 40)',
  W = 'rgb(255, 255, 255)',
  I = 'rgb(40, 40, 120)';
const C = (b, x, y) => (b ? x : y);
const p = (tag, n) => `body > ${tag}:nth-child(${n})`;
const inp = (n, cls = 'opt', tag = 'input', text) => ({
  tag,
  cls,
  rect: [20, 20 + n * 40, 20, 20],
  ...(text ? { text } : {}),
});
const lab = (n, cls = 'opt-label', text = `Option ${n}`) => ({
  tag: 'label',
  cls,
  text,
  rect: [60, 20 + n * 40, 100, 20],
});
const st = (owner, state, sub, props) => ({ [owner]: { [state]: { [sub]: props } } });
const merge = (...xs) => {
  const o = {};
  for (const x of xs)
    for (const [k, v] of Object.entries(x)) {
      o[k] ??= {};
      for (const [s, t] of Object.entries(v)) o[k][s] = { ...(o[k][s] ?? {}), ...t };
    }
  return o;
};
export const cases = {
  // RV11-01 (round-11 review; QA11 passed it): label's own :hover + input.opt:checked restyling the label.
  'RV11-01 own-hover+checkbox-checked': (b) => ({
    elements: { [p('input', 1)]: inp(0), [p('label', 2)]: lab(0) },
    states: merge(
      st(p('label', 2), 'hover', p('label', 2), { 'background-color': C(b, W, I) }),
      st(p('input', 1), 'checked', p('label', 2), { color: C(b, G, R) }),
    ),
  }),
  // QA12-01(a): input.opt:checked colour + button.toggle:focus background on one label.
  'QA12-01a two-controls-two-states': (b) => ({
    elements: { [p('input', 1)]: inp(0), [p('button', 2)]: inp(1, 'toggle', 'button'), [p('label', 3)]: lab(2) },
    states: merge(
      st(p('input', 1), 'checked', p('label', 3), { color: C(b, G, R) }),
      st(p('button', 2), 'focus', p('label', 3), { 'background-color': C(b, W, I) }),
    ),
  }),
  // QA12-01(b): input.opt:checked colour + input.other:checked background (different selectors, same state).
  'QA12-01b two-controls-same-state': (b) => ({
    elements: { [p('input', 1)]: inp(0), [p('input', 2)]: inp(1, 'other'), [p('label', 3)]: lab(2) },
    states: merge(
      st(p('input', 1), 'checked', p('label', 3), { color: C(b, G, R) }),
      st(p('input', 2), 'checked', p('label', 3), { 'background-color': C(b, W, I) }),
    ),
  }),
  // QA12-01(c): label's own :hover background + input.opt:hover colour.
  'QA12-01c own-hover+control-hover': (b) => ({
    elements: { [p('input', 1)]: inp(0), [p('label', 2)]: lab(0) },
    states: merge(
      st(p('label', 2), 'hover', p('label', 2), { 'background-color': C(b, W, I) }),
      st(p('input', 1), 'hover', p('label', 2), { color: C(b, G, R) }),
    ),
  }),
  // QA13-01: two input.opt (same selector) restyle different props of one element in :checked.
  'QA13-01 same-selector-different-props': (b) => ({
    elements: { [p('input', 1)]: inp(0), [p('input', 2)]: inp(1), [p('label', 3)]: lab(2) },
    states: merge(
      st(p('input', 1), 'checked', p('label', 3), { color: C(b, G, R) }),
      st(p('input', 2), 'checked', p('label', 3), { 'background-color': C(b, W, I) }),
    ),
  }),
  // QA13-02: input.pickr:focus colour + select.pickr:focus background (same noun, different tags).
  'QA13-02 same-noun-different-tags': (b) => ({
    elements: {
      [p('input', 1)]: inp(0, 'pickr'),
      [p('select', 2)]: inp(1, 'pickr', 'select'),
      [p('label', 3)]: lab(2),
    },
    states: merge(
      st(p('input', 1), 'focus', p('label', 3), { color: C(b, G, R) }),
      st(p('select', 2), 'focus', p('label', 3), { 'background-color': C(b, W, I) }),
    ),
  }),
  // QA13-03: three input.opt :checked each restyle the label's colour identically (rows repeat).
  'QA13-03 three-same-selector-one-change': (b) => ({
    elements: { [p('input', 1)]: inp(0), [p('input', 2)]: inp(1), [p('input', 3)]: inp(2), [p('label', 4)]: lab(3) },
    states: merge(...[1, 2, 3].map((n) => st(p('input', n), 'checked', p('label', 4), { color: C(b, G, R) }))),
  }),
  // QA13-03 / break-attr #5: label 2 driven by opt#1, label 4 by opt#1 and opt#3 (identical change).
  'QA13-03b shared-control-plus-own-control': (b) => ({
    elements: { [p('input', 1)]: inp(0), [p('label', 2)]: lab(0), [p('input', 3)]: inp(1), [p('label', 4)]: lab(1) },
    states: merge(
      st(p('input', 1), 'checked', p('label', 2), { color: C(b, G, R) }),
      st(p('input', 1), 'checked', p('label', 4), { color: C(b, G, R) }),
      st(p('input', 3), 'checked', p('label', 4), { color: C(b, G, R) }),
    ),
  }),
  // QA14-01: two pairs of identical `input.opt2` (one pair the colour, the other the background).
  // Main heads both blocks `input.opt2` ×2: the report has nothing that tells the pairs apart.
  'QA14-01 two-pairs-same-selector': (b) => ({
    elements: {
      [p('input', 1)]: inp(0, 'opt2'),
      [p('input', 2)]: inp(1, 'opt2'),
      [p('input', 3)]: inp(2, 'opt2'),
      [p('input', 4)]: inp(3, 'opt2'),
      [p('label', 5)]: lab(4),
    },
    states: merge(
      ...[1, 2].map((n) => st(p('input', n), 'checked', p('label', 5), { color: C(b, G, R) })),
      ...[3, 4].map((n) => st(p('input', n), 'checked', p('label', 5), { 'background-color': C(b, W, I) })),
    ),
  }),
  // QA14-01: three `input.chip`, each restyling one property; main shows three identical headings.
  'QA14-01 three-chips-three-props': (b) => ({
    elements: {
      [p('input', 1)]: inp(0, 'chip'),
      [p('input', 2)]: inp(1, 'chip'),
      [p('input', 3)]: inp(2, 'chip'),
      [p('label', 4)]: lab(3),
    },
    states: merge(
      st(p('input', 1), 'checked', p('label', 4), { color: C(b, G, R) }),
      st(p('input', 2), 'checked', p('label', 4), { 'background-color': C(b, W, I) }),
      st(p('input', 3), 'checked', p('label', 4), { 'outline-color': C(b, G, R) }),
    ),
  }),
  // QA14-01: two `input.opt`, one checked, one hovered: different owners in different states.
  'QA14-01 same-selector-different-states': (b) => ({
    elements: { [p('input', 1)]: inp(0), [p('input', 2)]: inp(1), [p('label', 3)]: lab(2) },
    states: merge(
      st(p('input', 1), 'checked', p('label', 3), { color: C(b, G, R) }),
      st(p('input', 2), 'hover', p('label', 3), { 'background-color': C(b, W, I) }),
    ),
  }),
  // QA14-06: one identical change from two differently-labelled owners: said once.
  'QA14-06 identical-change-two-selectors': (b) => ({
    elements: {
      [p('input', 1)]: inp(0, 'pickr'),
      [p('select', 2)]: inp(1, 'pickr', 'select'),
      [p('label', 3)]: lab(2),
    },
    states: merge(
      st(p('input', 1), 'focus', p('label', 3), { color: C(b, G, R) }),
      st(p('select', 2), 'focus', p('label', 3), { color: C(b, G, R) }),
    ),
  }),
  // QA14-06: the element's own hover and a control's hover make one identical change.
  'QA14-06 identical-own-and-control-change': (b) => ({
    elements: { [p('input', 1)]: inp(0), [p('label', 2)]: lab(0) },
    states: merge(
      st(p('label', 2), 'hover', p('label', 2), { color: C(b, G, R) }),
      st(p('input', 1), 'hover', p('label', 2), { color: C(b, G, R) }),
    ),
  }),
  // QA14-04: the owner is not in the map's elements; it is still a control, never the label's own.
  'QA14-04 owner-missing-from-elements': (b) => ({
    elements: { [p('label', 2)]: lab(0) },
    states: merge(st(p('input', 1), 'checked', p('label', 2), { color: C(b, G, R) })),
  }),
  // QA14-05: a control restyles the label's ::before.
  'QA14-05 control-restyles-pseudo-element': (b) => ({
    elements: { [p('input', 1)]: inp(0), [p('label', 2)]: lab(0) },
    states: merge(st(p('input', 1), 'checked', `${p('label', 2)}::before`, { 'background-color': C(b, W, I) })),
  }),
  // QA14-07 / QA14-01: two `button.btn` the report names apart by their text ("the Save button").
  'QA14-07 two-buttons-different-text': (b) => ({
    elements: {
      [p('button', 1)]: inp(0, 'btn', 'button', 'Save'),
      [p('button', 2)]: inp(1, 'btn', 'button', 'Cancel'),
      [p('div', 3)]: { tag: 'div', cls: 'panel', text: 'Panel', rect: [60, 100, 200, 60] },
    },
    states: merge(
      st(p('button', 1), 'hover', p('div', 3), { color: C(b, G, R) }),
      st(p('button', 2), 'hover', p('div', 3), { 'background-color': C(b, W, I) }),
    ),
  }),
  // QA14-07: a button and a link named by their text.
  'QA14-07 button-and-link-text-owners': (b) => ({
    elements: {
      [p('button', 1)]: inp(0, 'tgl', 'button', 'Dark mode'),
      [p('a', 2)]: inp(1, 'lnk', 'a', 'Help'),
      [p('div', 3)]: { tag: 'div', cls: 'panel', text: 'Panel', rect: [60, 100, 200, 60] },
    },
    states: merge(
      st(p('button', 1), 'focus', p('div', 3), { color: C(b, G, R) }),
      st(p('a', 2), 'hover', p('div', 3), { 'background-color': C(b, W, I) }),
    ),
  }),
  // QA14-05: one owner restyles the label and its ::before in one state: one clause, not two alike.
  'QA14-05 owner-restyles-label-and-pseudo': (b) => ({
    elements: { [p('input', 1)]: inp(0), [p('label', 2)]: lab(0) },
    states: merge(
      st(p('input', 1), 'checked', p('label', 2), { color: C(b, G, R) }),
      st(p('input', 1), 'checked', `${p('label', 2)}::before`, { 'background-color': C(b, W, I) }),
    ),
  }),
  // QA14-01: two `input.opt`, one changes the colour, the other the colour and the background.
  'QA14-01 overlap-subset-props': (b) => ({
    elements: { [p('input', 1)]: inp(0), [p('input', 2)]: inp(1), [p('label', 3)]: lab(2) },
    states: merge(
      st(p('input', 1), 'checked', p('label', 3), { color: C(b, G, R) }),
      st(p('input', 2), 'checked', p('label', 3), { color: C(b, G, R), 'background-color': C(b, W, I) }),
    ),
  }),
  // QA14-04: a hidden owner (no entry) beside a captured owner of the same selector.
  'QA14-04 hidden-owner-plus-visible-owner': (b) => ({
    elements: { [p('input', 2)]: inp(1), [p('label', 3)]: lab(2) },
    states: merge(
      st(p('input', 1), 'checked', p('label', 3), { color: C(b, G, R) }),
      st(p('input', 2), 'checked', p('label', 3), { 'background-color': C(b, W, I) }),
    ),
  }),
  // QA16-01 (live, site-r16 section 1): both controls turn the text red; the first also turns the
  // label's visible 2px border red. Said once, the border never dropped.
  'QA16-01 visible-border-same-as-colour': (b) => ({
    elements: {
      [p('input', 1)]: inp(0),
      [p('input', 2)]: inp(1),
      [p('label', 3)]: {
        ...lab(2),
        style: {
          color: C(b, G, G),
          'border-top-style': 'solid',
          'border-top-width': '2px',
          ...Object.fromEntries(['top', 'right', 'bottom', 'left'].map((side) => [`border-${side}-color`, G])),
        },
      },
    },
    states: merge(
      st(p('input', 1), 'checked', p('label', 3), {
        color: C(b, G, R),
        ...Object.fromEntries(['top', 'right', 'bottom', 'left'].map((side) => [`border-${side}-color`, C(b, G, R)])),
      }),
      st(p('input', 2), 'checked', p('label', 3), { color: C(b, G, R) }),
    ),
  }),
  // QA16-02 (live, site-r16 section 2): the link's own hover and the first control's hover turn its
  // text red; the second control's hover changes its background. The own hover is its own clause.
  'QA16-02 own-hover-plus-two-control-hovers': (b) => ({
    elements: {
      [p('input', 1)]: inp(0, 'pick'),
      [p('input', 2)]: inp(1, 'pick'),
      [p('a', 3)]: { tag: 'a', cls: 'chip', text: 'Chip', rect: [60, 100, 80, 24] },
    },
    states: merge(
      st(p('a', 3), 'hover', p('a', 3), { color: C(b, G, R) }),
      st(p('input', 1), 'hover', p('a', 3), { color: C(b, G, R) }),
      st(p('input', 2), 'hover', p('a', 3), { 'background-color': C(b, W, I) }),
    ),
  }),
  // QA16-04: a counted clause after a resting change.
  'QA16-04 counted-after-resting-change': (b) => ({
    elements: {
      [p('input', 1)]: inp(0),
      [p('input', 2)]: inp(1),
      [p('label', 3)]: { ...lab(2), style: { 'font-size': b ? '12px' : '16px' } },
    },
    states: merge(
      st(p('input', 1), 'checked', p('label', 3), { color: C(b, G, R) }),
      st(p('input', 2), 'checked', p('label', 3), { 'background-color': C(b, W, I) }),
    ),
  }),
  // QA16-01: two owners whose changes differ only by an echo the label does not draw (no border):
  // the stated changes match, so the line says one change, "when either of the 2 opts is checked".
  'QA16-01 echo-only-difference': (b) => ({
    elements: { [p('input', 1)]: inp(0), [p('input', 2)]: inp(1), [p('label', 3)]: lab(2) },
    states: merge(
      st(p('input', 1), 'checked', p('label', 3), {
        color: C(b, G, R),
        ...Object.fromEntries(['top', 'right', 'bottom', 'left'].map((side) => [`border-${side}-color`, C(b, G, R)])),
      }),
      st(p('input', 2), 'checked', p('label', 3), { color: C(b, G, R) }),
    ),
  }),
  // QA17 live shapes (check/round-17/qa/site-r17, site-r17c). A border, outline the element draws.
  // QA17-01: three controls, one each: text colour, background, the drawn border's colour.
  'QA17-01 three-owners-drawn-border': (b) => ({
    elements: {
      [p('input', 1)]: inp(0, 'tri'),
      [p('input', 2)]: inp(1, 'tri'),
      [p('input', 3)]: inp(2, 'tri'),
      [p('p', 4)]: {
        tag: 'p',
        cls: 'chips',
        text: 'Chip result',
        rect: [60, 140, 200, 30],
        style: { 'border-top-style': 'solid', 'border-top-width': '2px' },
      },
    },
    states: merge(
      st(p('input', 1), 'checked', p('p', 4), { color: C(b, G, R) }),
      st(p('input', 2), 'checked', p('p', 4), { 'background-color': C(b, W, I) }),
      st(p('input', 3), 'checked', p('p', 4), {
        ...Object.fromEntries(['top', 'right', 'bottom', 'left'].map((side) => [`border-${side}-color`, C(b, G, I)])),
      }),
    ),
  }),
  // QA17-02: two controls both turn the text red; the first also the drawn border, the second the background.
  'QA17-02 two-owners-overlapping-drawn': (b) => ({
    elements: {
      [p('input', 1)]: inp(0, 'duo'),
      [p('input', 2)]: inp(1, 'duo'),
      [p('label', 3)]: {
        tag: 'label',
        cls: 'pill',
        text: 'Pill',
        rect: [60, 100, 80, 24],
        style: { 'border-top-style': 'solid', 'border-top-width': '2px' },
      },
    },
    states: merge(
      st(p('input', 1), 'checked', p('label', 3), {
        color: C(b, G, R),
        ...Object.fromEntries(['top', 'right', 'bottom', 'left'].map((side) => [`border-${side}-color`, C(b, G, R)])),
      }),
      st(p('input', 2), 'checked', p('label', 3), { color: C(b, G, R), 'background-color': C(b, W, I) }),
    ),
  }),
  // QA17-03: one control turns the text red, and the drawn 3px outline follows it.
  'QA17-03 drawn-outline-one-owner': (b) => ({
    elements: {
      [p('input', 1)]: inp(0, 'ringon'),
      [p('span', 2)]: {
        tag: 'span',
        cls: 'ring',
        text: 'Ring',
        rect: [60, 20, 80, 24],
        style: { 'outline-style': 'solid', 'outline-width': '3px' },
      },
    },
    states: merge(st(p('input', 1), 'checked', p('span', 2), { color: C(b, G, R), 'outline-color': C(b, G, R) })),
  }),
  // QA17-03: both controls turn the text red; only the first also turns the drawn outline red.
  'QA17-03 drawn-outline-two-owners': (b) => ({
    elements: {
      [p('input', 1)]: inp(0, 'rg'),
      [p('input', 2)]: inp(1, 'rg'),
      [p('span', 3)]: {
        tag: 'span',
        cls: 'ring2',
        text: 'Ring two',
        rect: [60, 100, 80, 24],
        style: { 'outline-style': 'solid', 'outline-width': '3px' },
      },
    },
    states: merge(
      st(p('input', 1), 'checked', p('span', 3), { color: C(b, G, R), 'outline-color': C(b, G, R) }),
      st(p('input', 2), 'checked', p('span', 3), { color: C(b, G, R) }),
    ),
  }),
  // QA17-04: the link's own hover and both controls' hovers make one identical change.
  'QA17-04 own-plus-two-identical': (b) => ({
    elements: {
      [p('input', 1)]: inp(0, 'twin'),
      [p('input', 2)]: inp(1, 'twin'),
      [p('a', 3)]: { tag: 'a', cls: 'twinlink', text: 'Twin', rect: [60, 100, 80, 24] },
    },
    states: merge(
      st(p('a', 3), 'hover', p('a', 3), { 'background-color': C(b, W, I) }),
      st(p('input', 1), 'hover', p('a', 3), { 'background-color': C(b, W, I) }),
      st(p('input', 2), 'hover', p('a', 3), { 'background-color': C(b, W, I) }),
    ),
  }),
};
