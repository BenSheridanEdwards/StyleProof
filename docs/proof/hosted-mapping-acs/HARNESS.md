# Hosted mapping proof — StyleProof-owned harness stubs

**Soft-pass HOLD.** These stubs prepare StyleProof for a future hosted consumer mapping proof. They do **not** run that proof and do **not** claim Phase 2 mapping is proved.

**Blocked-by:** consumer Visual path + exact tip pin.

## Intent

Provide a StyleProof-owned checklist and interface sketch so a later execution ticket can:

1. Pin a consumer tip
2. Apply controlled CSS / structure / no-op deltas on that Visual path
3. Capture then diff then hosted report
4. Assert the five design ACs in [`README.md`](./README.md)

Use **generic consumer** language only (no private product names).

## Preconditions (execution ticket — not this tracer)

| Precondition | Status for #683 |
| --- | --- |
| Consumer Visual path exists | Blocked — external |
| Exact tip pin recorded | Blocked — external |
| StyleProof ACs written | Done in README.md |
| StyleProof harness stubs | This file |

## Controlled delta classes (stubs)

When unblocked, the execution harness should expose three named delta classes:

| Class | Intent | Expected hosted report |
| --- | --- | --- |
| `known-css` | Controlled CSS change on a known surface | Surfaces the CSS change (gallery / verdict / copy / trust as appropriate) |
| `known-structure` | Controlled structure change on a known surface | Surfaces the structure change correctly |
| `noop-equivalent` | Intentional no-op / equivalent | Invents **no** false change |

Fail-closed: wrong mapping or incomplete evidence → non-zero / fail verdict. No soft-green.

## Interface sketch (not implemented here)

```text
hostedMappingProof({
  consumerTip: <sha>,          // exact pin — required at execution
  visualPath: <generic path>,  // consumer Visual entry — required at execution
  deltas: ['known-css', 'known-structure', 'noop-equivalent'],
})
  -> hosted report artifacts
  -> assert ACs 1–4; soft-pass remains HOLD until Visual+pin present
```

StyleProof may later wire this to existing capture/diff/report seams. This stub does **not** add runtime code.

## Checklist for a future execution ticket

- [ ] Consumer Visual path named (generic)
- [ ] Exact tip pin recorded in the execution PR / receipt
- [ ] `known-css` delta applied and hosted report reviewed
- [ ] `known-structure` delta applied and hosted report reviewed
- [ ] `noop-equivalent` delta applied; report invents no false change
- [ ] Fail-closed proven on incomplete / wrong mapping case
- [ ] Soft-pass HOLD lifted only when ACs 1–4 are evidenced on the pinned tip
- [ ] No claim of Phase 2 mapping proved until that evidence exists

## Privacy

Artifacts and docs use generic consumer language only. No private project names, repos, or URLs.
