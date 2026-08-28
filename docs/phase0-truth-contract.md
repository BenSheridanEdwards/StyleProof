# Phase 0 truth contract (v0.1)

StyleProof's Phase 0 truth contract is a closed document kernel. It says whether
one JSON document is internally consistent under v0.1 rules. It does **not**
decide a release, authenticate an external producer, or replace the shipped
product-state comparability and source-binding producers.

`certifies: true` means the document conforms to this contract under internally
bound authorities. Trusted external authenticity arrives only when a later
Release Confidence Manifest (#437) projects #452-bound receipts. Raw
self-reported JSON is not a cryptographic authenticity proof.

The four-valued comparability receipt remains
[product-state comparability](./product-state-comparability.md). This page does
not restate that lattice as a second decision.

## What the kernel checks

- **Presence.** Absent bytes are `absent-legacy`. Unreadable or oversize bytes
  throw. Present but malformed JSON is `present-invalid`.
- **Closed fields.** Unknown fields, unknown enums, and nested duplicate JSON
  keys fail closed. Hostile values are never echoed.
- **Required domains.** Exactly one source-run envelope per domain:
  `capture-maps`, `coverage-ledger`, `determinism`, `product-state`,
  `evidence-store`, `source-binding`.
- **Authority.** `product-state` runs are `consumer` with modes
  `declared|excluded`. Evidence domains are `styleproof` with modes
  `observed|derived`. Assertion producer, version, and run must match the run.
- **Layered identity.** Product-state identities carry a revision. Source
  snapshots bind a 40-hex SHA. Assertion identities bijection with assertions.
  Evidence identities bind a sha256 digest. Obligation `sourceSnapshot` and
  assertion `validity` name snapshot identities, not raw SHAs.
- **Denominator.** Enumerated `factCount` equals assertions for that run.
  Complete enumerated zero-fact runs require `emptyUniverseProof: true`.
- **Conflicts.** Same subject, predicate, scope, and validity with a different
  object blocks a required obligation. Different scope or snapshot do not.
- **Joins.** Each required satisfied obligation has exactly one integrity join
  to a StyleProof evidence/capture run. Artifact digests are an exact closure.
- **Comparability.** Only the shipped #438 status/reason/required combinations
  are valid. Style, DOM, and copy never mint comparability.

## What this contract does not do

- It does not wire capture producers, `diff`, `report`, the GitHub Action, or
  CLI.
- It does not emit a Release Confidence Manifest. That is #437.
- It does not infer product state from the page.
- It does not treat `certifies` as merge policy or human approval.

See ADR [0003](../.agents/decisions/0003-phase0-truth-contract.md) for the
retrospective reconciliation with #438 and #452.
