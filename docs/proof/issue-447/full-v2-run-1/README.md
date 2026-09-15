# StyleProof issue #447 detection benchmark: full

Complete frozen corpus run for issue #447 (styleproof-issue447-phase0-full@2.0.0). This is still not a class-wide recall measurement or a whole-application coverage claim.

- Source SHA: `3a20e30ee820f86afd67202013402c508893cccd`
- Corpus: `styleproof-issue447-phase0-full@2.0.0` (sha256:`982034eba893238ece57116b0c2ab5939809bec3d337ef6f25335c4724f3439a`)
- Frozen expectation digest: sha256:`a71fb4e21d50b795a9cec26badbbb1738a13842fd1a36b368d2bf4fe75f8dce3`
- Browser: chromium 149.0.7827.55
- OS: 14.4 (23E214)
- Clean-build executable closure: sha256:`3b54f1ccfe621945d9c042bfaec84e3b9156c32455287c90f3e3631aca71d14b`
- Bound source/build-input closure: sha256:`c61da9dff11aba69675548d255d0bc12997f650434b098bec5dc41a7e9ec747c`

## Exact counts

| requested | executed | valid | detected | missed | unsupported | skipped | timeout | invalid | duplicate | no-op false positives | no-op true negatives |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 23 | 23 | 23 | 18 | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 3 |

## Cases

- `computed-rest-background-v2`: **detected**; render proof matched; 1 finding(s)
- `computed-text-color-v2`: **detected**; render proof matched; 1 finding(s)
- `computed-font-size-v2`: **detected**; render proof matched; 1 finding(s)
- `computed-margin-v2`: **detected**; render proof matched; 1 finding(s)
- `computed-border-radius-v2`: **detected**; render proof matched; 1 finding(s)
- `computed-box-shadow-v2`: **detected**; render proof matched; 1 finding(s)
- `computed-transform-v2`: **detected**; render proof matched; 1 finding(s)
- `computed-opacity-v2`: **detected**; render proof matched; 1 finding(s)
- `computed-css-var-color-v2`: **detected**; render proof matched; 1 finding(s)
- `computed-flex-gap-v2`: **detected**; render proof matched; 1 finding(s)
- `computed-grid-columns-v2`: **detected**; render proof matched; 1 finding(s)
- `computed-display-none-v2`: **detected**; render proof matched; 1 finding(s)
- `computed-pseudo-before-color-v2`: **detected**; render proof matched; 1 finding(s)
- `computed-pseudo-marker-color-v2`: **detected**; render proof matched; 1 finding(s)
- `state-hover-background-v2`: **detected**; render proof matched; 1 finding(s)
- `state-focus-outline-v2`: **detected**; render proof matched; 1 finding(s)
- `cross-element-hover-panel-v2`: **detected**; render proof matched; 1 finding(s)
- `structure-sibling-insertion-v2`: **detected**; render proof matched; 3 finding(s)
- `media-image-content-v2`: **missed**; render proof matched; 0 finding(s)
- `noop-color-spelling-v2`: **no-op-true-negative**; render proof matched; 0 finding(s)
- `noop-declaration-order-v2`: **no-op-true-negative**; render proof matched; 0 finding(s)
- `noop-unused-rule-v2`: **no-op-true-negative**; render proof matched; 0 finding(s)
- `noop-zero-width-border-v2`: **no-op-false-positive**; render proof matched; 1 finding(s)

## Excluded / unknown

- This run covers the complete frozen Phase-0 corpus; classes outside it remain unmeasured.
- Unsupported sensor classes and whole-application states: excluded.
- These observations must not be extrapolated beyond the named corpus and bound environment.
