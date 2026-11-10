# report-real-shop

A real capture (Chromium, `captureReach` on) of a small three-page shop fixture, base and head, used by
`test/report-rule5-matrix.test.mjs` as its multi-section shape: nine change sections, forced-state pairs
and Change Reach rule names.

- **State screenshots** that are byte-identical to the page's resting screenshot were removed. The report
  reads a missing state screenshot the same way, so report.md and report.json are unchanged.
- **The manifests carry no `compatibilityKey`.** The secret scanner reads that hex value as a possible
  API key, so it is not committed. The matrix test copies the fixture and writes the same key into both
  manifests (`fixtureCompatibilityKey('report-real-shop')`), as two captures from one environment have.
  To use these captures elsewhere, add a matching `compatibilityKey` to both manifests first.
