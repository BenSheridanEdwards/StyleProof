# Visual-first report proof

A real StyleProof run, not a mockup: a small shop page captured twice in Chromium (base and head
builds, with Change Reach), then `styleproof-report` on the two map directories.

- `html-desktop-light.png`, `html-desktop-dark.png`, `html-phone-light.png`, `html-phone-dark.png`:
  report.html at 1280px and 390px wide, light and dark, with every fold open.
- `comment-public.md`: the change content the Action posts on a public repository with
  `report-storage: branch`, built by `reportCommentSummary` from that run's report.md. Its image
  URLs point at this folder on the branch, in the same `/blob/<ref>/…?raw=1` form the Action uses
  with the report's publication SHA.
- `comment-text-only.md`: the same content as a private repository or artifact storage gets it,
  with no images.
- `crops/`: the clean crops and Where maps those files reference, unedited.

Both comment files end with the report link; the Action also adds its marker, approval box,
receipts and footer around them.
