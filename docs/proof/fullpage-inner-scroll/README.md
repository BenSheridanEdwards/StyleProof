# Proof: full-page capture includes nested overflow scrollers

Fixture: a fixed-height shell (`800px`, `overflow: hidden`) with an inner
`overflow: auto` scroller holding `2000px` of bands. The magenta
"BELOW THE FOLD" band starts at `800px` — outside the shell viewport.

| File | How it was produced | Size |
| --- | --- | --- |
| `before-unexpanded.png` | Playwright `page.screenshot({ fullPage: true })` alone | 800×800 |
| `after-expanded.png` | `captureSurfaceScreenshots` (StyleProof full-page path) | 800×2000 |

The unexpanded shot never paints the magenta band. The expanded shot does.
Document-scrolling pages are covered by the companion e2e and stay `2000px`
tall with or without the expand step.
