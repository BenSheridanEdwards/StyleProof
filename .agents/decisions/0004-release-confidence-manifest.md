# ADR 0004: Release Confidence Manifest v0.1

- **Status:** proposed for #437 review
- **Date:** 2026-08-30
- **Depends on:** #448 Phase 0 truth contract, #438 product-state comparability, #452 source/evidence binding

## Context

StyleProof 6.2 already emits map manifests, coverage and confidence ledgers, product-state comparability, source-binding receipts, capture-evidence receipts, reports, and Action outputs. Those artifacts were individually useful but had no single canonical exact-source identity. Re-encoding their semantics in a second policy model would allow the manifest to disagree with the existing producers.

## Decision

Introduce `styleproof.release-confidence` version `0.1` as a canonical projection over the approved Phase 0 contract.

The manifest contains producer version, exact after SHA, compatibility key, declared release-scope ID, the six-domain contract projection, derived exclusions and gaps, and `manifestDigest`.

`manifestDigest` is sha256 over canonical manifest payload bytes with `manifestDigest` omitted. The complete serializer inserts that digest and canonicalizes again. This avoids a self-referential hash while binding every other field.

The public object validator snapshots own data descriptors. It rejects Proxies, accessors, sparse or reflective arrays, custom iterator overrides, unknown fields, stale projection summaries, and digest mismatches. The bytes parser additionally bounds input to 16 MiB and 64 JSON levels and rejects duplicate keys, including Unicode-equivalent spellings. Errors and receipts never include attacker-controlled values.

`projectReleaseConfidence` is one-way. It reads production 6.2 artifacts and copies shipped comparability status and reason values without reinterpretation. Missing optional evidence remains explicit and non-certifying. Present malformed ledgers, incompatible source manifests, unreadable evidence objects, and evidence bound to another SHA or compatibility key hard-fail with one bounded projector error.

A certifying v0.1 walking projection is deliberately narrow. It accepts no caller-authored empty-universe override: coverage must declare at least one expected surface. Both before/after confidence ledgers must summarize to `complete`, enumerate exactly the declared and actually captured surface universe, and correspond to each other. Missing, unknown, unasserted, limited, empty-asserted, or wrong-universe confidence remains non-certifying. The supplied producer version must equal the exact after-capture package version:

1. one physical capture surface;
2. matching before/after runtime compatibility;
3. exact expected source binding;
4. valid coverage and confidence artifacts;
5. proven determinism;
6. explicit consumer product-state identity;
7. a verified evidence-store capture bound to the exact after SHA and compatibility key.

The projector emits one consumer product-state assertion. The five StyleProof evidence domains may enumerate an empty assertion universe while their output digests bind actual artifacts, matching the approved #448 semantics. One required obligation joins the physical capture, semantic state, environment digest, sensor contract, source snapshot and verified evidence digest. Artifact closure is exact over all run config/output digests, assertion input/source digests, capture manifest digest and evidence identity digest.

## Consumer boundary

#437 writes and round-trips the canonical sidecar, then proves existing diff, report and the literal Action merge program still operate unchanged. The report does not project manifest content and Action does not gate on it in this issue. #443 owns that consumer policy. This keeps producer contract freeze ahead of consumer implementation.

## Consequences

- One exact byte identity can be reviewed and approved later.
- Legacy or incomplete evidence can be represented without being upgraded to certification.
- Multi-surface certification is intentionally deferred because the #448 v0.1 join contract scopes one capture run to one obligation surface. The manifest can represent broader non-certifying evidence, but it cannot claim a v0.1 certificate for it.
- No generic connector framework, policy engine, report schema rewrite, or Action gate is introduced.
