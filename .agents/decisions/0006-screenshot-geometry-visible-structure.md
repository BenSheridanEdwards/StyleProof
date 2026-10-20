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

Extend the 7.5.1 driven-only gate with an either-box rule. After the existing
hidden/opacity checks, an addition/removal is visible if either:

- Its non-zero driven `rect` intersects the original driven bounds: horizontal
  `scrollX` to `scrollX + width`, vertical `min(0, scrollY)` to
  `max(scrollY + height, documentHeight ?? Infinity)`.
- Its non-zero `screenshotRect ?? rect` intersects the same horizontal bounds and
  vertical top, with bottom `screenshotHeight`.

Preserving the driven check makes the gate never laxer than before. Expansion can
move an on-screen box outside screenshot bounds or collapse its size; neither
may turn a previously reviewable addition/removal advisory. The screenshot check
also catches below-fold content exposed by expansion. This is a page-area
intersection rule, not an inference of each ancestor's clipping or PNG width.
Hidden (`display:none` or `visibility:hidden`) and zero-opacity entries remain
advisory. Entries with neither box of non-zero size remain advisory. Pixel
differences do not determine visibility.

Capture records optional `viewport.screenshotHeight`, measured in the same
expanded document state used for screenshots, before restoration. Include `body`
as a vertical overflow scroller candidate only when it scrolls itself: the root's
computed `overflow-y` must not be `visible`, which would propagate body overflow
to the viewport. Preserve `rect` and `documentHeight` in driven coordinates for
their existing consumers. When any scroller is
expanded, all measured entries with `rect` can receive `screenshotRect`, including
elements inside unexpanded scrollers. Without expansion, the screenshot check
falls back to `rect`.

If `screenshotHeight` is missing, non-finite, or non-positive, fail closed with an
unbounded lower extent, including maps that record only `documentHeight`. An old
driven height cannot prove an addition was outside expanded screenshot evidence.
Missing scroll offsets still mean zero; horizontal and above-page clipping remain
enforced.

## Consequences

- This is a breaking gate change for 9.0.0: more visible additions/removals enter
  `reviewableCounts.dom`, and both diff and report CLIs exit 1 for them.
- Recapture affected baselines to record aligned screenshot boxes and height.
  Old maps remain readable and conservatively reviewable below the first window.
- Correspondence and layout comparisons retain driven-state rectangles.
- The recorded height participates in existing serialized-map determinism hashes.
- `screenshotHeight`/`screenshotRect` are measured in a separate evaluate from the
  screenshot's own expansion, so page observers reacting to expansion can make
  them drift. Drift that differs between runs fails the determinism proof, which
  hashes `screenshotHeight`. Drift that repeats can only shift the screenshot
  check, never the driven check kept from 7.5.1.
- Standards and quirks mode body/app-shell fixtures cover capture, PNG height,
  both CLI exits with unchanged negative controls, restoration, and the exact DOM
  review count; pure unit tests cover the either-box rule, height bounds,
  invalid/legacy height fallback, and invisible entries.
