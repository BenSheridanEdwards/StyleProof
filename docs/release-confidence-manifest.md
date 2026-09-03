# Release Confidence Manifest (v0.1)

The Release Confidence Manifest (RCM) is StyleProof's canonical, exact-source projection of the evidence it already owns. It wraps the Phase 0 truth contract with producer identity, source SHA, compatibility key, declared release scope, derived exclusions and gaps, and a content digest.

It is not by itself a release verdict. In v0.1, `certifies: true` means the manifest and its inner evidence contract are internally closed and mutually bound. The report projects that validated result, and the Action hard-blocks missing, invalid, or non-certifying evidence. The manifest does not authenticate the producer, record human approval, or replace Action policy.

## Public API

- `createReleaseConfidenceManifest(...)` projects a Phase 0 contract into one canonical manifest.
- `validateReleaseConfidenceManifest(value)` never throws. It distinguishes `absent-legacy`, `present-invalid`, and present but non-certifying evidence.
- `serializeReleaseConfidenceManifest(manifest)` emits deterministic canonical JSON.
- `parseReleaseConfidenceManifest(bytes)` accepts bounded UTF-8 JSON and throws only `ReleaseConfidenceManifestError` for unreadable or present-invalid bytes.
- `digestReleaseConfidenceManifest(manifest)` computes sha256 over canonical manifest payload bytes with `manifestDigest` omitted, avoiding a self-referential hash.
- `projectReleaseConfidence(...)` projects real 6.2 capture directories into the kernel. A certifying v0.1 projection requires one physical surface, matching source-bound manifests, valid coverage and confidence artifacts, an explicit product-state pin, and a verified evidence-store capture bound to the exact after SHA and compatibility key. Missing evidence remains present but non-certifying; malformed or wrong-source evidence throws the bounded `ReleaseConfidenceProjectError`. The error carries a fixed `reason` literal (`ReleaseConfidenceProjectReason`: `head-manifest-unreadable`, `head-manifest-unbound`, `spec-hash-unbound`, `producer-version-mismatch`, `coverage-ledger-invalid`, `confidence-ledger-invalid`, `capture-records-invalid`, `surface-alias-conflict`, `evidence-capture-unbound`, `source-binding-failed`, `projection-failed`); `describeReleaseConfidenceProjectReason(reason)` renders one fixed sentence per literal and `releaseConfidenceProjectReason(value)` narrows an untrusted value to a known literal. `styleproof-report` passes a refused projection's reason to the report as `releaseConfidenceProjectionFailure`, so `report.md` opens with `**Release confidence** — ⚠ not evaluated (projection refused — …)` instead of a bare `✗ blocked`; the `report.json` summary stays `absent-legacy` / `blocking: true`.

The 16 MiB byte bound and 64-level JSON-depth bound apply before certification. Duplicate JSON keys, including Unicode-equivalent keys, fail closed. Unknown fields, future enums, stale digests, projection mismatches, Proxies, accessors, and hostile reflective arrays cannot certify and never leak attacker-controlled text.

## Canonical identity

The manifest binds:

- one full lowercase 40-hex source SHA,
- one 16-hex capture compatibility key,
- the exact six Phase 0 source-run domains,
- assertions, obligation tuples, product-state/source/assertion/evidence identities,
- shipped product-state comparability receipts,
- integrity joins and exact artifact-digest closure,
- a declared release-scope ID and its exact obligated surfaces,
- derived exclusions and unresolved source-run, obligation, and comparability gaps.

Semantically unordered collections are canonicalized, so producer scheduling and insertion order do not alter manifest bytes or digest. Duplicate derived IDs are invalid rather than silently deduplicated.

## Truth boundaries

- Missing, failed, partial, unsupported, unasserted, excluded, proved-empty, and satisfied remain distinct.
- Missing coverage, confidence, product-state, evidence-store, or trusted source binding never becomes proof of an empty universe.
- `expected: []` is not evidence unless an explicit empty-universe proof exists. The v0.1 projector accepts no user-supplied empty-universe override, so an empty registry remains non-certifying.
- Both before/after confidence ledgers must summarize to `complete`, contain a non-empty exact surface universe equal to their declared coverage and actual captured map surfaces, and correspond to each other. Missing, `unknown`, `unasserted`, `limited`, empty-asserted, or wrong-universe confidence remains non-certifying.
- A physical capture may equal its semantic product surface or be a generated `surface-*` expansion. Unrelated aliases are invalid. Scope, confidence, comparability, and obligations use the semantic surface; `physicalCaptureKey` retains the concrete artifact identity.
- Projector `producerVersion` must equal the exact after-capture manifest `packageVersion`; caller metadata cannot relabel artifact-producing bytes.
- Product-state comparability is copied from StyleProof's existing receipt. It is never inferred from CSS, DOM, route names, or labels.
- Required satisfied obligations receive join credit only from `capture-maps` or `evidence-store` evidence.
- A legacy manifest may be present and non-certifying. It is not malformed, and it never strengthens into certification.

## Digest rule

`manifestDigest` is:

```text
sha256(canonical-json(manifest without manifestDigest))
```

The serializer then inserts that digest and canonicalizes the complete manifest. Any edit to bound content invalidates the digest.

## Walking slice

The release-confidence walking slice uses production StyleProof artifact shapes:

```text
capture maps + manifests + ledgers
  → diff and comparability receipt
  → RCM projection
  → canonical sidecar
  → bounded Markdown + report.json summary
  → literal Action sidecar/report validation
  → non-approvable certification gate
  → exact-commit publication readback
```

The report CLI projects one RCM from the same capture directories it reports,
writes `styleproof-release-confidence.json`, and rechecks the capture receipts
after writing all artifacts. The report summary is a bounded projection of the
shipped validator, not a second truth engine.

The Action independently parses the sidecar, recomputes its bounded summary,
binds the manifest source SHA to the trusted head SHA, and requires exact
summary equality before copying it into the canonical diff receipt. Missing,
invalid, stale, incompatible, partial, non-certifying, or future evidence maps
to `CERTIFICATION_FAILED` before visual approval. Publication then reads
`report.md`, `report.json`, and the canonical sidecar back from the exact
advertised report commit and requires the digest established by the merge step.
