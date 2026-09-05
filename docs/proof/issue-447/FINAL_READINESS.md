# Issue #447 bounded detection pilot readiness

## Result

The committed corpus remains the fixed four-case `styleproof-issue447-phase0-pilot@1.0.0`. Expectations were frozen and reviewed before any detector result. After merging current main `f3fb86c674b9bc1bc80020d958e8681c1c9fc0e8`, the pilot was rerun from clean source commit `654319ad2422f04f4454656f881bf16b0635862f` under Node `v22.22.2`. The earlier one-case smoke remains historical supporting evidence from source `10b4c090068f05746da02b5c937298f783ac200d`.

- Latest pilot: requested 4, executed 4, valid 4, detected 3, no-op true negatives 1; missed, unsupported, skipped, timeout, invalid, duplicate, and no-op false positives all 0.
- Historical smoke: requested 1, executed 1, valid 1, detected 1; all other counters 0.
- Browser: Chromium 149.0.7827.55.
- OS: macOS 26.3, build 25D125.
- Corpus SHA-256: `d5204a2c44cb3d92ef10fe819b50b5732fa4ff1ccefd12f9f9022442f584ac27`.
- Frozen expectation SHA-256: `e33f69ec9024e09a4e68ae22f4807deedc4daeac03e5cfde7739afd1c0f1ab91`.
- Clean-build executable closure SHA-256: `ea8eaf60d92b0d44cadf23651faf36737a6c01b5da2e0f97b6c87ff7f53981cd`.
- Bound source/build-input closure SHA-256: `360811399da4ab7c39ebdf5c1fe4a0d5ab4641cf91d0e9c34b60f494b8b76e37`.

## Preliminary blocker closure matrix

| Blocker                              | Closure                                                                                                                                                                                                                      | Regression evidence                                                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1 source/dist binding               | Runner rejects dirty build inputs, removes `dist/`, builds from clean HEAD, hashes all emitted JavaScript and independently hashes tracked source/build inputs.                                                              | A stale marker injected into `dist/diff.js` was removed by the final smoke's clean build; substituted digest/sourceDigest receipt test is RED without the repair.           |
| B2 contradictory semantics/artifacts | Validator binds class and complete frozen labels, permits honest positive misses, reconciles expected findings and finding counts, and verifies exact contained screenshot paths, hashes, sizes, and PNG dimensions.         | Sabotage tests reject positive/no-op swaps, invented classes, erased/mismatched findings, altered expectation binding, and unsafe/incomplete/duplicate screenshot metadata. |
| B3 timeout/publication               | Timeout abort closes the per-case browser context and awaits settlement. Hidden staging is validated before one atomic rename; failed staging is removed.                                                                    | Tests prove no late write after timeout return and prove failed staging leaves no final directory while complete staging publishes atomically.                              |
| B4 inert expectation hash            | Manifest expectation digest is recomputed from recursive-key-sorted canonical JSON over `cases[{id,class,expected}]`; review bytes are also hashed and enforced. Both bindings are copied into and validated on the receipt. | Altered expectation digest receipt test fails; final runner accepted only the manifest-bound expectation and review digests.                                                |

## Evidence

- `pilot-654319ad/receipt.json`
- `pilot-654319ad/README.md`
- `pilot-654319ad/cases/*/{before,after}.png`
- `smoke-10b4c090/receipt.json` (historical one-case smoke)

The hover screenshots prove the rendered panel effect only. Trigger/state provenance comes from the computed-style assertion and fresh-page sensor run, not from the screenshot alone.

## Remaining acceptance gaps

This is a bounded pilot, not full issue #447 closure. The full corpus, class-wide recall, whole-application states, and multiple browser/OS environments are not run or claimed. Hosted CI is evaluated separately at the pull-request head and is not part of this source-bound local receipt. Unsupported, timeout, invalid, skipped, duplicate, and no-op false-positive handling is receipt-tested but was not naturally observed in this four-case browser run.
