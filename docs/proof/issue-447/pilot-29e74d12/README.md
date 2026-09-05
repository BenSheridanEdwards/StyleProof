# StyleProof issue #447 detection benchmark: pilot

Diagnostic pilot only. This is not a full issue #447 run, class-wide recall measurement, or whole-application coverage claim.

- Source SHA: `29e74d12b91c2ba7905d086d3825374ef814f0eb`
- Corpus: `styleproof-issue447-phase0-pilot@1.0.0` (sha256:`d5204a2c44cb3d92ef10fe819b50b5732fa4ff1ccefd12f9f9022442f584ac27`)
- Frozen expectation digest: sha256:`e33f69ec9024e09a4e68ae22f4807deedc4daeac03e5cfde7739afd1c0f1ab91`
- Browser: chromium 149.0.7827.55
- OS: 26.3 (25D125)
- Clean-build executable closure: sha256:`ea8eaf60d92b0d44cadf23651faf36737a6c01b5da2e0f97b6c87ff7f53981cd`
- Bound source/build-input closure: sha256:`360811399da4ab7c39ebdf5c1fe4a0d5ab4641cf91d0e9c34b60f494b8b76e37`

## Exact counts

| requested | executed | valid | detected | missed | unsupported | skipped | timeout | invalid | duplicate | no-op false positives | no-op true negatives |
| --------: | -------: | ----: | -------: | -----: | ----------: | ------: | ------: | ------: | --------: | --------------------: | -------------------: |
|         4 |        4 |     4 |        3 |      0 |           0 |       0 |       0 |       0 |         0 |                     0 |                    1 |

## Cases

- `computed-rest-background-v1`: **detected**; render proof matched; 1 finding(s)
- `computed-pseudo-color-v1`: **detected**; render proof matched; 1 finding(s)
- `cross-element-hover-panel-v1`: **detected**; render proof matched; 1 finding(s)
- `computed-equivalent-color-noop-v1`: **no-op-true-negative**; render proof matched; 0 finding(s)

## Excluded / unknown

- Full issue #447 corpus: not run.
- Unsupported sensor classes and whole-application states: excluded.
- These observations must not be extrapolated beyond the named corpus and bound environment.
