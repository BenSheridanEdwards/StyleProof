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
- `styleproof.product-state.json` (`{"<surface>": "<why>"}`) is the inventory/residue twin for **known-legacy** pairs. When that file is present — or passed as `--legacy-pairs` / `$STYLEPROOF_PRODUCT_STATE` / `productState.legacyPairs` — undeclared unproven pairs fail closed. Declared pairs stay advisory and **never certify**. A stale declaration fails like an inventory acknowledgement. Matching `productState {id, revision}` remains the only certifying declare path.
- New or removed surfaces remain `not-required` for pairwise comparison, while existing new/removal gates still apply.
- CLI, JSON, report, composite Action, commit status, and exit code must use the same comparison truth.
- Approval can clear `STYLE_REVIEW_REQUIRED`; it cannot clear `CERTIFICATION_FAILED`.

## Compatibility and migration

StyleProof 6.2 remains the stable migration line. The 6.x-compatible path is opt-in:

1. Add `productState` to each declared surface and state variant.
2. Capture base and head using the same consumer-owned fixture revision.
3. Run diff/report with `--require-state-identity`, or set `productState.requireIdentity: true` in `styleproof.config.ts`, or set composite Action input `require-state-identity: true`.
4. Repair every `unproven` or `incomparable` receipt before treating the run as certifying.

StyleProof-on-StyleProof (this repository) arms that ledger: root
`styleproof.config.ts` and `styleproof.config.json` set `productState.legacyPairs` to
`example/styleproof.product-state.json` (declares `home`; resolved from the
discovered config directory), and
`.github/workflows/styleproof-dogfood.yml` sets `$STYLEPROOF_PRODUCT_STATE`
so the live advisory Action cannot stay green over undeclared `home@*` pairs.
The path is beside the example spec so the synthetic `action-dogfood.yml`
suite is not auto-armed from the default cwd filename. That suite sets
`$STYLEPROOF_PRODUCT_STATE` to `action-dogfood/legacy-pairs-empty.json` so
upward config discovery cannot inherit the live `home` ledger and
stale-fail identity-stamped contract maps. It still proves undeclared →
`CERTIFICATION_FAILED` and declared → advisory.

To inventory known-legacy pairs **without** claiming identity yet (the large-undeclared-pair case):

1. Add `styleproof.product-state.json` at the repo root:

   ```json
   {
     "home": "known marketing shell; fixture revision pending"
   }
   ```

   A surface-base key (`home`) covers every width (`home@1280`, `home@768`). An exact capture key covers only that pair.

2. Capture and diff as usual. Declared pairs are named as advisory and `certifiesFully` stays false. Any **new** unproven pair that is not on the ledger fails closed (`CERTIFICATION_FAILED`).
3. Stamp `productState {id, revision}` when a pair is ready to certify, then prune its declaration so the ledger cannot rot.

A future major version may make explicit state identity mandatory by default if mutation benchmarks and real release pilots show a measurable reduction in wrong-state approvals. Backward compatibility must not preserve a false-certification path.

## Deliberate non-claims

This contract does not prove that all product states were declared, that fixtures are semantically correct, or that all visual regression classes are detectable. It proves only whether the two supplied captures carry matching explicit product-state identity within the declared comparison scope.
