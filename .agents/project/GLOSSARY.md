# Glossary

Domain terms as StyleProof uses them. Definitions are drawn from the README and
`src/`.

- **Surface** — one UI state to certify: a route, tab, modal-open state,
  dropdown-open state, toast-visible state, loading state, etc. You list or
  auto-discover surfaces in a Playwright-style spec.
- **Variant** — an open/alternate state of a surface (e.g. a menu open). Declared
  in `variants` or harvested by the variant crawler.
- **Popup** — an overlay state (dialog, dropdown, listbox, popover, sheet, toast)
  captured with its open state.
- **Live state** — loading / loaded / empty / error states, declared in
  `liveStates`.
- **Style map** — the recorded computed styles for every captured element on a
  surface at a given breakpoint width, stored as JSON.
- **Computed styles** — the browser's resolved CSS (longhands, pseudo-elements,
  layout boxes, motion longhands, forced `:hover`/`:focus`/`:active` deltas).
  StyleProof compares these, **not** pixels — this is the core design decision
  (see `decisions/0001-computed-styles-over-pixels.md`).
- **Breakpoint** — a viewport width at which a surface is captured; widths can be
  detected automatically from media-query boundaries (`breakpoints.ts`).
- **Coverage / `expected`** — the guard that turns the surface inventory into a
  contract: a key listed in `expected` that is neither captured nor explicitly
  excluded fails as missing coverage instead of silently passing.
- **Finding** — a single detected computed-style change on an element, grouped
  into surface diffs and change groups for the report.
- **New surface** — a surface that exists only on the PR head; reviewable and, in
  review-gate mode, held red until approved (`🆕 new surface` in the report).
- **Global chrome change** — a change on shared frame elements (nav, header,
  footer) that moved on every surface hosting them, promoted to one report
  callout instead of repeating per surface.
- **Review-gate mode** — the Action posts a status that stays red until
  intentional changes are approved. **Certification mode** fails CI on any diff.
- **Dogfood** — running StyleProof (or the Action) against the repo's own
  fixtures to prove the current code produces the shipped output.
