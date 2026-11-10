# report-state-drivers-shop

A real Chromium capture of a small shop page whose head stylesheet restyles elements through other
controls' states: `.opt:checked + .opt-label`, and two checkboxes on one paragraph
(`.pick:checked ~ .summary { color }`, `.wrap:checked ~ .summary { background }`), beside a label's
own `:hover`. `test/report-state-attribution-oracle.test.mjs` checks that every state finding names
the control the capture recorded for it.

- **State screenshots** byte-identical to the page's resting screenshot were removed; the report reads
  a missing state screenshot the same way.
- **The manifests carry no `compatibilityKey`.** The secret scanner reads that hex value as a possible
  API key, so it is not committed. The test copies the fixture and writes the same key into both
  manifests (`fixtureCompatibilityKey('report-state-drivers-shop')`).
