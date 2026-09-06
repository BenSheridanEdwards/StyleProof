# StyleProof issue #447 detection benchmark — pilot

Diagnostic pilot only. This is not a full issue #447 run, class-wide recall measurement, or whole-application coverage claim.

- Source SHA: `6747081983f44c632ad1290c18947e8ba3d6710d`
- Corpus: `styleproof-issue447-phase0-pilot@1.0.0` (sha256:`d5204a2c44cb3d92ef10fe819b50b5732fa4ff1ccefd12f9f9022442f584ac27`)
- Browser: chromium 149.0.7827.55
- OS: 26.3 (25D125)
- Sensor executable: `captureStyleMap+diffStyleMaps@1` (sha256:`9d80c53daa0933e3e312ab204ba37ac5444f6196892e8645ea1c961e4671f5fb`)
- Sensor source digest: sha256:`020af8c7aa19e6a2a35f58d4a2d27f3cb5be9311489644753303f96c345097ea`

## Exact counts

| requested | executed | valid | detected | missed | unsupported | skipped | timeout | invalid | duplicate | no-op false positives | no-op true negatives |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 4 | 4 | 4 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |

## Cases

- `computed-rest-background-v1`: **detected**; independent render proof matched (12801 changed pixel(s)); 1 finding(s); screenshots: cases/computed-rest-background-v1/before.png, cases/computed-rest-background-v1/after.png
- `computed-pseudo-color-v1`: **detected**; independent render proof matched (55 changed pixel(s)); 1 finding(s); screenshots: cases/computed-pseudo-color-v1/before.png, cases/computed-pseudo-color-v1/after.png
- `cross-element-hover-panel-v1`: **detected**; independent render proof matched (29530 changed pixel(s)); 1 finding(s); screenshots: cases/cross-element-hover-panel-v1/before.png, cases/cross-element-hover-panel-v1/after.png
- `computed-equivalent-color-noop-v1`: **no-op-true-negative**; independent render proof matched (0 changed pixel(s)); 0 finding(s); screenshots: cases/computed-equivalent-color-noop-v1/before.png, cases/computed-equivalent-color-noop-v1/after.png

## Excluded / unknown

- Full issue #447 corpus: not run.
- Unsupported sensor classes and whole-application states: excluded.
- These observations must not be extrapolated beyond the named corpus and bound environment.
