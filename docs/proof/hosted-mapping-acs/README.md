# Hosted mapping proof — design ACs (soft-pass HOLD)

Parent: Phase 2 prep (#681). Tracer: #683.

## Soft-pass HOLD

This document **designs** acceptance criteria and StyleProof-owned harness stubs for a future hosted mapping proof. It does **not** execute that proof, and it does **not** claim Phase 2 mapping is proved.

**Blocked-by:** execution awaits a consumer Visual path **and** an exact tip pin. Until those exist, treat any soft-pass as **HOLD**.

## Why these ACs exist

Phase 2 must eventually prove that hosted StyleProof reports reflect real consumer code, CSS, and structure changes. Specifying the ACs now lets StyleProof prepare harness stubs and docs without waiting on consumer Visual — and without claiming proof early.

## Acceptance criteria (design only)

When a consumer Visual path exists and pins tip:

1. **Known CSS** — A controlled, known CSS change surfaces in the hosted StyleProof report (gallery / verdict / copy / trust as appropriate for the change class).
2. **Known structure** — A controlled, known structure change surfaces correctly in the hosted report.
3. **No-op / equivalent** — An intentional no-op or equivalent change invents **no** false change in the report.
4. **Fail closed** — If mapping is wrong or evidence incomplete, the gate fails closed (no soft-green).
5. **Soft-pass HOLD** — Until consumer Visual + tip pin exist, soft-pass remains **HOLD**; closing this design tracer does not mean Phase 2 mapping is proved.

## Explicitly out of scope for closing #683

- Executing or asserting proof against a live consumer Visual before Visual is present
- Claiming Phase 2 mapping proved
- Soft-pass / soft-green while evidence is incomplete
- SPA / zero-glue Mission C work

## Related StyleProof proof (local Phase 1 — not a substitute)

Local Phase 1 harnesses (`phase1-foundation-harness`, `phase1-structure-harness`, `phase1-noop-equivalent`) demonstrate StyleProof-owned mapping fail-closed behaviour in-repo. They are **not** the hosted consumer mapping proof described above.

## Harness stubs

See [`HARNESS.md`](./HARNESS.md) for StyleProof-owned stubs that prepare for hosted proof without requiring consumer Visual green.
