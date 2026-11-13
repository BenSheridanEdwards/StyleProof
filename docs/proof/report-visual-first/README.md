# Visual-first report proof

A real StyleProof run, not a mockup: a small shop page captured twice in Chromium (base and head
builds, with Change Reach), then `styleproof-report` on the two map directories.

- `html-desktop-light.png`, `html-desktop-dark.png`, `html-phone-light.png`, `html-phone-dark.png`:
  report.html at 1280px and 390px wide, light and dark, with every fold open.
- `comment-public.md`: the change content the Action posts on a public repository with
  `report-storage: branch`, built by `reportCommentSummary` from that run's report.md. Its image
  URLs point at this folder at commit `3edd599b9`, the last commit that changed its images (each linked
  image there is byte-identical to this one), in the same
  `/blob/<sha>/…?raw=1` form the Action uses with the report's publication SHA. A commit URL keeps
  working after the branch is deleted; a rebase gives that commit a new SHA, so the URLs then need
  pinning again.
- `comment-text-only.md`: the same content as a private repository or artifact storage gets it,
  with no images.
- `crops/`: the clean crops and Where maps those files reference, unedited.
- `anonymous-blob-raw.txt`: an anonymous `curl -sIL` of a commit-bound `blob/<sha>/…?raw=1` image URL on this
  public repository: 302, 302, then `200 image/png`. That is why a public repository's comment embeds images.

Both comment files end with the report link; the Action also adds its marker, approval box,
receipts and footer around them.
