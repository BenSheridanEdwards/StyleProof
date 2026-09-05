# Issue #447 bounded-pilot final blocker closure

This closes only the final timeout/non-scored artifact-publication blocker in the four-case bounded pilot. It is not a full issue #447 run, class-wide recall claim, whole-application claim, hosted-CI claim, or release claim.

## Source and proof binding

- Measured source commit: `654319ad2422f04f4454656f881bf16b0635862f` (merge parents `ecc779a65c36856b94653ac401d950759aa45455` and current main `f3fb86c674b9bc1bc80020d958e8681c1c9fc0e8`)
- Pilot receipt: [`pilot-654319ad/receipt.json`](pilot-654319ad/receipt.json)
- Bound 70-file source/build-input digest: `360811399da4ab7c39ebdf5c1fe4a0d5ab4641cf91d0e9c34b60f494b8b76e37`
- Bound 63-file clean-build executable digest: `ea8eaf60d92b0d44cadf23651faf36737a6c01b5da2e0f97b6c87ff7f53981cd`
- Independent recomputation matched the receipt for source SHA, both digests, and the exact 10-file publication inventory.

## Blocker closure

- Every non-scored outcome (`unsupported`, `skipped`, `timeout`, `invalid`, and `duplicate`) now requires zero findings, zero screenshots, and no render proof.
- Artifact-root validation rejects undeclared regular files, symbolic links, and non-regular entries.
- Publication requires `receipt.json` and `README.md`, revalidates the receipt against the staging root immediately before the atomic rename, and refuses a partial/orphan staging tree.
- Timeout settlement remains abort-and-await; the integration regression proves a pre-timeout partial plus a detached delayed write cannot reach a final publication.

## RED/GREEN evidence

The final regression tests were copied onto pinned unfixed source `69a6cd5113b15afc6ecdc31ddb9d313adfefd596` and run independently. All three focused RED commands exited 1:

- non-scored retained-data test: validator incorrectly returned `ok: true`;
- undeclared-artifact test: no undeclared-artifact reason was emitted;
- timed-out partial-publication test: publication did not throw.

On the pre-integration repair source `29e74d12b91c2ba7905d086d3825374ef814f0eb`:

- `node --test test/detection-benchmark.test.mjs`: 22 passed, 0 failed;
- adapted final-review adversarial probe: 16 passed, including rejection of timeout + retained finding + `../../outside.png`;
- full unit suite: 1,185 passed, 0 failed;
- full E2E suite: 221 passed, 1 skipped, 0 failed;
- build, typecheck, lint, format check, privacy check, and high-severity dependency audit passed under Node `v22.22.2`.

## Measured four-case pilot

The exact frozen four-case corpus produced 4 requested, 4 executed, and 4 valid cases: 3 detected and 1 no-op true negative, with zero misses and zero non-scored outcomes. Validation returned `{ "ok": true, "reasons": [] }`. All eight PNGs independently matched their receipt SHA-256, byte count, and dimensions.

Visual inspection of the latest eight screenshots found every benchmark image visible, legible, nonblank, and materially uncropped. The resting box changed gray to blue, the pseudo marker green to red, the hover panel blue to green, and the equivalent-color no-op remained unchanged.
