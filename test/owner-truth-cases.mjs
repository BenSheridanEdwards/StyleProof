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
};
