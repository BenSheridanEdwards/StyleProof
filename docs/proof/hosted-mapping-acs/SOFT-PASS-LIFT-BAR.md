# Soft-pass lift bar — go / no-go decision

**Decision:** **HOLD-continue** (no-go on lift).  
**Date:** 1 Oct 2026 ~22:40 BST (UTC+1).  
**AC5 Soft-pass:** remains **HOLD** — this doc does not clear it.  
**Ben escalate:** **No** (unless a later flip path below is chosen).

PM accepted HOLD-continue. Do not reopen this decision without new buyer-promise input.

---

## Decision

**HOLD-continue Soft-pass / AC5.** Do **not** lift Soft-pass. Do **not** invent Soft-pass green. Do **not** merge Soft-pass dogfood “as proved.” Do **not** edit [`RECEIPT.md`](./RECEIPT.md) AC5 status wording.

This is a documented **no-go on lifting**, not a product go.

---

## Why (primary evidence)

1. **RECEIPT + #750 kept HOLD on purpose** — [`RECEIPT.md`](./RECEIPT.md) records AC1–4 as **Evidenced** and AC5 as **HOLD**. StyleProof #750 landed that receipt as Soft-pass HOLD **with** evidence, not Phase 2 buyer-proved. Lift is not automatic when AC1–4 exist.
2. **HARNESS lift ticks still open** — [`HARNESS.md`](./HARNESS.md) still has unchecked:
   - Soft-pass HOLD lifted only when ACs 1–4 are evidenced on the pinned tip
   - No claim of Phase 2 mapping proved until that evidence exists
3. **Step 2 out of Soft-pass scope** — Consumer PR **#66** (pin-bump to 7.2.1 / `@v7`) and consumer PR **#67** (7.2.1 re-dogfood for StyleProof #752–#756) were mandated **not** to clear Soft-pass. #67 body: evidence only — do not merge for Soft-pass AC5.
4. **Consumer PR #67 Visual red** — review-gate failure (changes need review); product-state undeclared / visual-only. Bug-fix dogfood, not Soft-pass AC clearance.
5. **#754 partial** — Inventory id-less nav landed, but “one Global chrome element-added” grouping is incomplete (per-surface advisories remain). Partial fix dogfood ≠ Soft-pass green.

Mandate: AC5 stays HOLD unless primary evidence says otherwise — it does not.

---

## Ben escalate?

| Path | Escalate? |
| --- | --- |
| Document HOLD-continue; leave AC5 HOLD; keep Soft-pass dogfood unmerged | **No** |
| Lift Soft-pass / claim Phase 2 proved / soft-green / merge Soft-pass dogfood as proved | **Yes** (Ben / CTO buyer-promise) |
| Weaken fail-closed (AC4) / approve-away incomplete evidence | **Yes** (hard escalate; not a flip path) |

**Escalate only if** Phase-2-proved, soft-green, or merge Soft-pass dogfood is proposed.

---

## What would flip HOLD → go later

Only with an explicit bar met:

1. **Ben/CTO buyer-promise** that RECEIPT AC1–4 pins are sufficient to claim Phase 2 hosted mapping proved.
2. **CoS amends** [`RECEIPT.md`](./RECEIPT.md) AC5 + [`HARNESS.md`](./HARNESS.md) lift ticks citing that decision (not invent).
3. Optionally (hygiene, not a substitute): re-dogfood Soft-pass AC1–4 on current `@v7` / 7.2.1 pins **without** merging dogfood “as proved,” then cite new run IDs / blobs in a receipt amendment **after** the buyer-promise call.
4. Fail-closed (AC4) stays unchanged — soft-green incomplete evidence is never a flip path.

---

## What not to do now

- Do **not** invent Soft-pass green or clear AC5 in RECEIPT / marketing / buyer copy.
- Do **not** merge Soft-pass dogfood for AC5 (#29–#31 stay closed-unmerged evidence).
- Do **not** merge consumer PR **#67** *to prove Soft-pass* (#67 stays open as 7.2.1 bug-fix evidence).
- Do **not** treat #66 / #67 / #752–#756 as Soft-pass clearance.
- Do **not** soft-pass pin-skew, `CERTIFICATION_FAILED`, or product-state-unproven into green.

---

## Related

- Execution receipt (AC5 HOLD): [`RECEIPT.md`](./RECEIPT.md)
- Harness lift checklist: [`HARNESS.md`](./HARNESS.md)
- Design ACs: [`README.md`](./README.md)
- Receipt PR: StyleProof #750
