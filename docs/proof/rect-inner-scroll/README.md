# Element rects in the full-page screenshot geometry

The `innerScrollFixture` from `test/smoke.e2e.spec.ts`: a fixed 800px shell with an
inner `overflow: auto` scroller holding five 400px bands. The magenta band starts at
800px in the scroller content. The scroller is driven to `scrollTop = 600` before
capture, as a surface's own click can do. The blue outline is the screenshot box of the
magenta band, drawn on the expanded full-page screenshot (800x2000, shown at half
size).

- `before-rects-offset.png` (7.5.0, without this fix): the rect is `y=200`, 600px
  above the band, so a crop of it shows only grey padding.
- `after-rects-aligned.png` (this fix): `screenshotRect` is `y=800` and outlines the band; `rect` remains `y=200`
  for driven-state visibility and layout comparisons.

The generated `report.md` uses two real captures of the same public fixture,
changing the marker from blue to magenta. Its inline crops and highlight overlay
use the expanded screenshot box. The report explicitly marks product-state
identity unproven; this is visual evidence, not a certified same-state comparison.

Review regressions also verify that a driven-state visible marker remains
reviewable, an offscreen marker stays advisory, and inline CSS priorities and
scroll offsets survive capture. Run `test/full-page-geometry.e2e.spec.ts` and
`test/screenshot-rect.test.mjs` for the behavior and legacy fallback checks.
