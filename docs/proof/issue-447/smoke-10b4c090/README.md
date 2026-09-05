# StyleProof issue #447 detection benchmark: smoke

Diagnostic smoke only. This is not a full issue #447 run, class-wide recall measurement, or whole-application coverage claim.

- Source SHA: `10b4c090068f05746da02b5c937298f783ac200d`
- Corpus: `styleproof-issue447-phase0-pilot@1.0.0` (sha256:`d5204a2c44cb3d92ef10fe819b50b5732fa4ff1ccefd12f9f9022442f584ac27`)
- Frozen expectation digest: sha256:`e33f69ec9024e09a4e68ae22f4807deedc4daeac03e5cfde7739afd1c0f1ab91`
- Browser: chromium 149.0.7827.55
- OS: 26.3 (25D125)
- Clean-build executable closure: sha256:`12a9bb245b3228171d809ac63218a0d63fa8cd33d465f24da3ebdbc33d2ce7a9`
- Bound source/build-input closure: sha256:`34f791d485954008f5b86f1bc006824c07c7d2cd3b1d5ed0977b829e058011e9`

## Exact counts

| requested | executed | valid | detected | missed | unsupported | skipped | timeout | invalid | duplicate | no-op false positives | no-op true negatives |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Cases

- `cross-element-hover-panel-v1`: **detected**; render proof matched; 1 finding(s)

## Excluded / unknown

- Full issue #447 corpus: not run.
- Unsupported sensor classes and whole-application states: excluded.
- These observations must not be extrapolated beyond the named corpus and bound environment.
