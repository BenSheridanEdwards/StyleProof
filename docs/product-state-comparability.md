# Product-state comparability contract

Status: Phase 0 decision record for issues #448 and #438

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

## Compatibility and migration

StyleProof 6.2 remains the stable migration line. The 6.x-compatible path is opt-in:

1. Add `productState` to each declared surface and state variant.
2. Capture base and head using the same consumer-owned fixture revision.
3. Run diff/report with `--require-state-identity`, or set composite Action input `require-state-identity: true`.
4. Repair every `unproven` or `incomparable` receipt before treating the run as certifying.

A future major version may make explicit state identity mandatory by default if mutation benchmarks and real release pilots show a measurable reduction in wrong-state approvals. Backward compatibility must not preserve a false-certification path.

## Deliberate non-claims

This contract does not prove that all product states were declared, that fixtures are semantically correct, or that all visual regression classes are detectable. It proves only whether the two supplied captures carry matching explicit product-state identity within the declared comparison scope.
