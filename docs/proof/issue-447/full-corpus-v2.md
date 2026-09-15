# Issue #447 Phase-0 full-corpus detection result

This is the complete frozen Phase-0 corpus run for issue #447 — the corpus the
issue's reopened acceptance requires beyond the four-case diagnostic pilot. It
is still **not** a class-wide recall measurement, a whole-application
state-coverage claim, or a cross-browser/cross-OS claim.

## Run binding

- Corpus: `styleproof-issue447-phase0-full@2.0.0`, 23 mutants
- Corpus SHA-256: `982034eba893238ece57116b0c2ab5939809bec3d337ef6f25335c4724f3439a`
- Frozen expectation SHA-256: `a71fb4e21d50b795a9cec26badbbb1738a13842fd1a36b368d2bf4fe75f8dce3`
- Pre-result review SHA-256: `a55a2b8436a4b09e50e7c5f7145ec17cf6f805faa8c2a526a43d66bacc0f4eb7`
- Source SHA measured: `3a20e30ee820f86afd67202013402c508893cccd`
- Clean-build executable closure SHA-256: `3b54f1ccfe621945d9c042bfaec84e3b9156c32455287c90f3e3631aca71d14b`
- Bound source/build-input closure SHA-256: `c61da9dff11aba69675548d255d0bc12997f650434b098bec5dc41a7e9ec747c`
- Browser: Chromium 149.0.7827.55
- Runner: Node v26.7.0, darwin/arm64, macOS 14.4 (23E214)
- Receipt: [`full-v2-run-1/receipt.json`](full-v2-run-1/receipt.json)

## Exact counts

| requested | executed | valid | detected | missed | unsupported | skipped | timeout | invalid | duplicate | no-op false positives | no-op true negatives |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 23 | 23 | 23 | 18 | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 3 |

## What was measured

- **18/18 detectable mutants detected.** Every mutant whose intended rendered
  change has a computed-style correspondence produced the expected finding —
  resting colors, typography, spacing, borders, effects, transforms, layout
  (flex gap, grid tracks, display), CSS-variable-driven color, two
  pseudo-element changes, two forced-state changes (`:hover`, `:focus`), one
  cross-element forced-state change, and one sibling-insertion structural
  change.
- **1 honest miss, by design.** `media-image-content-v2` swaps an image's pixel
  content with every computed style identical; the sensor produced no matching
  finding, and the receipt records `missed`. This is the known boundary of a
  computed-style detector and is counted, not hidden.
- **No-op controls behaved as expected.** Equivalent-color spelling, declaration
  order, and an unmatched rule produced zero findings (3 true negatives).
  `noop-zero-width-border-v2` changed a `0px`-wide border's computed color —
  rendered nothing, but the sensor honestly reported the computed delta it saw,
  landing as the single counted no-op false positive.

## Harness corrections the full run exposed

The first v2 run failed closed before publication and surfaced three defects the
pilot never reached (commit `3a20e30e`):

1. Element-box proof screenshots clipped every change painted outside the
   element's own box (margin, outline, `::marker`, box-shadow, transform) and
   could not capture a `display:none` side at all. Proof screenshots now cover
   the `main` container that roots every corpus body.
2. A failed render proof attached scored-case fields to an `invalid` outcome,
   which the validator correctly rejects — the runner now emits clean
   non-scored outcomes with a `reason`.
3. Mid-case exceptions orphaned undeclared PNGs in staging; non-scored outcomes
   now remove their case directory before publication.

## What is not claimed

- Recall beyond this named frozen corpus.
- Whole-application state coverage or route coverage.
- Non-Chromium engines or non-macOS runners.
- Detection of rendered changes with no computed-style correspondence — the one
  such mutant is the measured miss above.
