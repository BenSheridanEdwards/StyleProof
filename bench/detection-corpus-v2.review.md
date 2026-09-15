# Issue #447 corpus-v2 pre-result expectation review

Status: **APPROVED before detector execution**.

Reviewer: parent task owner (pre-result review supplied 2026-09-15).

Scope: this is the full Phase-0 corpus for issue #447 — computed-style mutation
classes, forced-state divergence (#438), structural mutation, one
rendered-no-computed mutant expected to miss, and no-op controls. It is still
not class-wide recall, whole-application coverage, or a cross-browser claim.

## Expected outcomes (frozen before any detector result)

Expected **detected** (rendered change, computed-style correspondence):

- `computed-rest-background-v2`: `background-color` style finding.
- `computed-text-color-v2`: `color` style finding.
- `computed-font-size-v2`: `font-size` style finding.
- `computed-margin-v2`: `margin-top` style finding.
- `computed-border-radius-v2`: `border-top-left-radius` style finding.
- `computed-box-shadow-v2`: `box-shadow` style finding.
- `computed-transform-v2`: `transform` style finding.
- `computed-opacity-v2`: `opacity` style finding.
- `computed-css-var-color-v2`: `background-color` style finding via `var(--accent)`.
- `computed-flex-gap-v2`: `column-gap` style finding.
- `computed-grid-columns-v2`: `grid-template-columns` style finding.
- `computed-display-none-v2`: `display` style finding.
- `computed-pseudo-before-color-v2`: pseudo `color` style finding.
- `computed-pseudo-marker-color-v2`: pseudo `color` style finding on `::marker`.
- `state-hover-background-v2`: forced-`hover` `background-color` state finding.
- `state-focus-outline-v2`: forced-`focus` `outline-color` state finding.
- `cross-element-hover-panel-v2`: forced-`hover` `background-color` state finding
  on the sibling panel.
- `structure-sibling-insertion-v2`: a `dom` finding from the inserted sibling and
  shifted `nth-child` paths.
- `media-image-content-v2`: an honest expected **miss** — the image's pixel
  content changes with every computed style identical. The label says a detector
  *should* flag a real rendered change; the computed-style sensor is expected to
  produce no matching finding, which records `missed` rather than flattering the
  score.

Expected **no rendered change** (no-op controls; `detected: false`):

- `noop-color-spelling-v2`: `#c8c8c8` ≡ `rgb(200,200,200)`; expect zero findings.
- `noop-declaration-order-v2`: reordered declarations, identical computed values;
  expect zero findings.
- `noop-unused-rule-v2`: a rule matching no element changes; expect zero findings.
- `noop-zero-width-border-v2`: a `0px`-width border's computed color changes but
  paints nothing. The sensor honestly reports the computed delta it sees, so
  this case is expected to land as a `no-op-false-positive` — a counted,
  classified non-rendered report, not a detection.

## Honesty rules

- A `missed` outcome on a positive mutant is a valid, reportable result — it is
  what this benchmark exists to measure.
- No case may be dropped, edited, or relabeled after results are observed; the
  frozen manifest digests make any post-hoc change detectable.
- These labels are grounded in fixture mutations and CSS semantics, not in
  observed detector output.
