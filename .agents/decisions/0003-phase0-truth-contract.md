# 3. Phase 0 truth contract is a retrospective v0.1 kernel

- Status: accepted
- Date: 2026-08-28
- Issues: #448 (this record), citing shipped #438 and #452

## Context

Issue #448 asked for an assertion/closure/obligation contract before comparability
(#438) and source/evidence binding (#452) were implemented. Those producers already
merged. `docs/product-state-comparability.md` is only the four-valued receipt axiom;
it is not this ontology ADR. Policy, presentation, CLI, Action wiring, and Release
Confidence Manifest emission stay out of this decision. #437 will project trusted
receipts and emit the RCM.

## Decision

Freeze a v0.1 Phase 0 truth-contract kernel (`src/phase0-contract.ts`) that
retrospectively reconciles #438 and #452 without reimplementing them:

1. **Authority.** Source runs carry a closed `authority` of `consumer` or
   `styleproof`. Product-state assertions require consumer authority and modes
   `declared|excluded`. StyleProof evidence domains require `styleproof` authority
   and modes `observed|derived`. This proves _internal_ authority consistency
   inside one document. It does **not** cryptographically authenticate a producer.
   Trusted external authenticity arrives only through #437 projection of
   #452-bound receipts. Raw self-reported JSON is not an authenticity proof.

2. **Layered identity.** Identities are a closed discriminated union:
   product-state `{id, revision}`, source-snapshot `{id, sourceSha}`,
   assertion `{id, assertionId}`, evidence `{id, evidenceDigest}`. Obligation
   `sourceSnapshot` and assertion `validity` reference source-snapshot identity
   IDs, never raw SHAs. Distinct source-snapshot identities may not share
   `sourceSha`. After resolving `assertion.run` and `assertion.validity`, the
   snapshot SHA must equal the producing run SHA. Cross-layer IDs fail closed.

3. **Enumerated denominator and execution.** `factCount` on a complete
   enumerated envelope equals the number of assertions whose `run` is that
   envelope. Zero facts certify only with `emptyUniverseProof: true`, and that
   proof is invalid beside positive facts. Failed, unsupported, not-run,
   partial, partial-closure, and unasserted outcomes remain distinct bounded
   reasons. None can claim enumerated completeness.

4. **Conflicts.** Assertions with the same subject, predicate, scope, and
   validity and a different object coexist. They block only required
   obligations for the same state, surface, and source-snapshot validity. A
   different scope or source-snapshot validity cannot block that obligation.

5. **Migrations.** Relations apply only to logical product-state identities.
   Rename and supersede are 1:1, split is 1:N (N≥2), merge is N:1 onto a new
   identity. Cardinality uses unique endpoints. Duplicate or empty endpoints,
   duplicate relations, cross-layer endpoints, dangling endpoints, and cycles
   are invalid. Similar names never mint a relation.

6. **Integrity join.** Required satisfied obligations have exactly one join
   to a StyleProof `capture-maps` or `evidence-store` run. Coverage-ledger,
   determinism, source-binding, and product-state runs are invalid join
   producers. Non-required and unsatisfied obligations have none. Assertions
   bind to their source-run scope; credited capture evidence binds to the
   obligation surface. Artifact digests are an exact set: manifest, credited
   run outputs and config digests, assertion input/source digests, and evidence
   identity digests. The set of evidence identity digests equals the set of
   join `evidenceDigest` values. Supersets and subsets both fail.

7. **Comparability.** Receipt status/reason/required tuples are the shipped
   #438 lattice. Impossible combinations and incomparable receipts fail closed
   as `comparability-mismatch`. Required obligation surfaces must equal
   comparability receipt surfaces exactly; empty or foreign coverage cannot
   certify. `certifies` means v0.1 contract conformance under internally bound
   authorities. It is not a release decision, an Action verdict, or external
   producer authentication.

8. **Bounded parsing.** Documents are limited to 16 MiB, arrays to 10,000
   entries, and JSON nesting to 64 levels. Invalid UTF-8, malformed JSON syntax,
   oversize bytes, and excessive nesting throw a privacy-safe
   `Phase0ContractError`. The Uint8Array path rejects oversize `byteLength`
   before decode. Parsed JSON with an invalid closed schema returns a
   `present-invalid` receipt. Untrusted object arrays are snapshotted from own
   descriptors only; hostile length, iterator, accessor, and revoked-proxy traps
   return `present-invalid` and never echo trap text. Nested duplicate keys fail
   closed.

## Consequences

- Existing #438 comparability and #452 source-binding producers stay untouched.
- The kernel is a closed parser/oracle only. #437 owns projection, persistence,
  and the RCM.
- Policy and presentation remain excluded. A certifying document is not an
  approval, a merge decision, or a claim that StyleProof witnessed the world.
