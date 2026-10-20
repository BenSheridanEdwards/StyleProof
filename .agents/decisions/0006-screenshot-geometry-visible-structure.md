# ADR 0006: Full-page screenshot geometry for visible structure

- **Status:** accepted (2026-10-20), targeting 9.0.0
- **Date:** 2026-10-20
- **Depends on:** #920 nested-scroller visibility, #913 full-page structure gating

## Context

Version 7.5.1 preserved driven-state `rect` for visibility, correspondence, and
layout comparisons, reserving `screenshotRect` for expanded screenshot crops.
That separation fixed crop alignment but left the gate in a different coordinate
system from the review evidence. Body-as-scroller and app-shell layouts can have
a 720px driven document height while their expanded screenshots show 3000px of
content. An added banner at y=2000 appears in the screenshot yet passes the gate.

## Decision

Reverse the 7.5.1 visibility-coordinate decision. Visible-structure additions and
removals use `screenshotRect ?? rect`, intersected horizontally with the captured
viewport origin and width and vertically with the full-page screenshot height.
Capture records that height as optional `viewport.screenshotHeight`, measured in
the same expanded document state used for screenshots, before restoration.
Include `body` when identifying vertical overflow scrollers. Preserve `rect` and
`documentHeight` in driven coordinates for their existing layout consumers.

If capture does not expand a scroller, its entries keep `rect` and have no
`screenshotRect`; judge that box against the recorded screenshot height. This is
a page-area intersection rule, not an inference of each ancestor's clipping.
Hidden (`display:none` or `visibility:hidden`), zero-size, and zero-opacity
entries remain advisory. Pixel differences do not determine visibility.

If `screenshotHeight` is absent, fail closed with an unbounded lower extent,
including maps that record only `documentHeight`. An old driven height cannot
prove an addition was outside expanded screenshot evidence. Missing scroll
offsets still mean zero; horizontal and above-page clipping remain enforced.

## Consequences

- This is a breaking gate change for 9.0.0: more visible additions/removals enter
  `reviewableCounts.dom`, and both diff and report CLIs exit 1 for them.
- Recapture affected baselines to record aligned screenshot boxes and height.
  Old maps remain readable and conservatively reviewable below the first window.
- Correspondence and layout comparisons retain driven-state rectangles.
- The recorded height participates in existing serialized-map determinism hashes.
- Standards and quirks mode body/app-shell fixtures cover capture, PNG height,
  both CLI exits, and the exact DOM review count; pure unit tests cover coordinate
  preference, the height bound, legacy fallback, and invisible entries.
