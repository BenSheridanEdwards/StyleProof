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

- **Presence.** An omitted document is `absent-legacy`. Invalid UTF-8,
  malformed JSON syntax, oversize bytes, or excessive nesting throw a
  privacy-safe `Phase0ContractError`. Parsed JSON with an invalid closed schema
  is `present-invalid`.
- **Closed fields.** Unknown fields, unknown enums, and nested duplicate JSON
  keys fail closed. Hostile values are never echoed. The public object path
  snapshots untrusted arrays from own length and index descriptors only;
  length, iterator, accessor, revoked-proxy, and same-class secret traps return
  `present-invalid` and never throw trap text. JSON bytes cannot produce those
  traps and stay on the ordinary parser.
- **Required domains.** Exactly one source-run envelope per domain:
  `capture-maps`, `coverage-ledger`, `determinism`, `product-state`,
  `evidence-store`, `source-binding`.
- **Authority.** `product-state` runs are `consumer` with modes
  `declared|excluded`. Evidence domains are `styleproof` with modes
  `observed|derived`. Assertion producer, version, and run must match the run.
- **Layered identity.** Product-state identities carry a revision. Source
  snapshots bind a 40-hex SHA; distinct snapshot identities may not share a
  SHA. Assertion identities bijection with assertions. Evidence identities bind
  a sha256 digest. Obligation `sourceSnapshot` and assertion `validity` name
  snapshot identities, not raw SHAs. An assertion's validity snapshot SHA must
  equal its producing run SHA.
- **Denominator and execution.** Enumerated `factCount` equals assertions for
  that run. Complete enumerated zero-fact runs require
  `emptyUniverseProof: true`; positive facts forbid it. Failed, unsupported,
  not-run, partial, partial-closure, and unasserted outcomes stay distinct and
  cannot claim enumerated completeness.
- **Conflicts.** Same subject, predicate, scope, and validity with a different
  object blocks only a required obligation for the same state, surface, and
  source snapshot. Different scope or snapshot do not block it.
- **Migrations.** Rename, split, merge, and supersede relations accept only
  product-state identity endpoints. Cross-layer, duplicate, dangling, and
  cyclic relations fail closed.
- **Joins.** Each required satisfied obligation has exactly one integrity join
  to a StyleProof `capture-maps` or `evidence-store` run in the obligation
  scope. Coverage-ledger, determinism, source-binding, and product-state runs
  cannot be `join.run`. Artifact digests are an exact closure including credited
  run config digests. The set of evidence identity digests must equal the set of
  integrity join `evidenceDigest` values.
- **Comparability.** Only the shipped #438 status/reason/required combinations
  are valid. Required obligation surfaces must equal comparability receipt
  surfaces exactly, and the matching receipts must remain `required: true` and
  must not claim `not-required`. Invalid combinations and incomparable receipts return
  bounded `comparability-mismatch`. Style, DOM, and copy never mint
  comparability. Kernel `certifies` is not proof that obligated pins exist.
- **Bounds.** Documents are limited to 16 MiB, arrays to 10,000 entries, and
  JSON nesting to 64 levels. Nested duplicate keys fail closed. The Uint8Array
  path rejects `byteLength` above 16 MiB before `TextDecoder`.

## What this contract does not do

- It does not wire capture producers, `diff`, `report`, the GitHub Action, or
  CLI.
- It does not emit a Release Confidence Manifest. That is #437.
- It does not infer product state from the page.
- It does not treat `certifies` as merge policy or human approval.

See ADR [0003](../.agents/decisions/0003-phase0-truth-contract.md) for the
retrospective reconciliation with #438 and #452.
