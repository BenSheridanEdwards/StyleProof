# Element rects in the full-page screenshot geometry

Fleet Access, roles mode (`access-classic-roles@1280`). The surface's mode toggle
scrolls the board's inner scroller by about 307px before capture. Magenta boxes are
the mapped rects of the two newly added "Claude Code Oauth" chips, drawn on the
full-page screenshot.

- `before-rects-offset.png` (7.4.0): rects sit about 320px above the chips, on the
  KARPATHY / TORVALDS card headers, so the report said the added chips "render
  identically before and after".
- `after-rects-aligned.png` (this fix): rects land on the chips.
