# Product-state comparability contract

Status: active contract for issue #438. This file is the four-valued comparability clause that `styleproof-diff`, the report and the Action gate all read. The assertion/closure/obligation kernel that once cited it (ADR [0003](../.agents/decisions/0003-phase0-truth-contract.md)) was deleted in #475; this clause is independent of it and unchanged.

StyleProof may only describe a base/head style delta as reviewable evidence when both captures represent the same consumer-declared product state.

## Rendering boundary

A rendered surface depends on code, product state, data, viewport, browser, environment, and time. Matching file names or DOM shape does not prove matching product state. StyleProof therefore accepts an explicit, consumer-owned identity:

```ts
productState: {
  id: 'checkout-ready',
  revision: 'fixture-v2',
}
```

`id` names the logical state. `revision` names the fixture/state contract that produced it. Both are bounded opaque identifiers. They must not contain rendered text, selectors, routes, labels, roles, secrets, exceptions, or user data. StyleProof never infers either value from the page.

## Four-valued receipt

Every surface receives one comparison receipt:

- `comparable`: both sides declare exactly the same valid `id` and `revision`.
- `incomparable`: both sides declare valid but different identities.
- `unproven`: identity is missing or malformed on at least one required side.
- `not-required`: no base/head comparison exists because the surface is one-sided.

Receipts contain only the capture key, status, required bit, and a bounded reason enum. They never retain rejected values.

## Certification rules

- Comparable findings may become reviewable evidence.
- Incomparable findings remain raw diagnostic evidence but are not approvable.
- If either side declares identity, missing identity on the other side is required-unproven and non-certifying.
- `--require-state-identity` makes undeclared legacy pairs globally required-unproven.
- New or removed surfaces remain `not-required` for pairwise comparison, while existing new/removal gates still apply.
- CLI, JSON, report, composite Action, commit status, and exit code must use the same comparison truth.
- Approval can clear `STYLE_REVIEW_REQUIRED`; it cannot clear `CERTIFICATION_FAILED`.

## Selective required state comparisons

Consumers can make one state mandatory on one width-normalized surface in `styleproof.config.json`:

```json
{
  "requiredStateComparisons": [
    {
      "surface": "agents",
      "productState": {
        "id": "client:jake:hunter",
        "revision": "fleet-fixture-v1"
      },
      "owner": "fleet-hud",
      "reason": "Prove the external client is visible before approving the agents surface"
    }
  ]
}
```

A requirement is satisfied only when a shared base/head capture carries the exact declared `metadata.surfaceKey` and matching valid product-state identity on both sides. Width suffixes belong to capture keys, not `surface`. Missing surface metadata, wrong surface or revision, one-sided evidence, and existing pairwise comparability failures all block certification. Diff JSON, report JSON, Markdown, Action trust state, and exit code carry the same bounded receipt. This gate is checked-in policy, not a workflow input, so a caller cannot waive it by omitting a flag.

`owner` and `reason` are bounded public metadata intended for repair routing. They must not contain secrets or personal data. StyleProof does not inspect application semantics: the consumer must still create the fixture and assert that the claimed state is visibly active before capture.

## Compatibility and migration

StyleProof 6.2 remains the stable migration line. The 6.x-compatible path is opt-in:

1. Add `productState` to each declared surface and state variant.
2. Capture base and head using the same consumer-owned fixture revision.
3. Run diff/report with `--require-state-identity`, or set composite Action input `require-state-identity: true`.
4. Repair every `unproven` or `incomparable` receipt before treating the run as certifying.

A future major version may make explicit state identity mandatory by default if mutation benchmarks and real release pilots show a measurable reduction in wrong-state approvals. Backward compatibility must not preserve a false-certification path.

## Deliberate non-claims

This contract does not prove that all product states were declared, that fixtures are semantically correct, or that all visual regression classes are detectable. `requiredStateComparisons` closes only consumer-declared omissions; it cannot detect an undeclared obligation or a dishonest fixture. It proves only whether the two supplied captures carry matching explicit product-state identity within the declared comparison scope.

## Config trust

`styleproof-diff` and `styleproof-report` load policy from the invocation root only when that root contains both capture directories and `styleproof.config.json`; otherwise they discover the nearest config shared by both capture directories. `--config-root <package>` pins an explicit package root. Policy adjacent to only one capture is not trusted. A missing explicit root, divergent capture roots, symlink, hard link, FIFO, duplicate key, or unknown top-level key is a usage error and cannot certify. Caller-supplied report API obligations are additive and cannot replace checked-in policy.
