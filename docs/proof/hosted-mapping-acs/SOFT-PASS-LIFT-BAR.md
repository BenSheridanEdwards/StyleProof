# Soft-pass lift bar — go / no-go decision

**Decision:** **HOLD-continue** (no-go on lift).  
**Date:** 2 Oct 2026 ~09:00 BST (UTC+1).  
**AC5 Soft-pass:** remains **HOLD** — this doc does not clear it.  
**Ben escalate:** **No** (unless a later flip path below is chosen).  
**Post-wave assess:** `research/soft-pass-ac5-post-wave-assess.md` @ tip `1104d0b` — HOLD-continue reaffirmed.

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
3. **Step 2 archive merges — Soft-pass still HOLD** — Consumer PR **#66** (pin-bump to 7.2.1 / `@v7`) already merged (pin). Consumer PR **#67** merged `4100838` and consumer PR **#68** merged `e2ed688` as **evidence archive only** at Action pin `StyleProof@1104d0b`; merge language keeps Soft-pass / RECEIPT AC5 HOLD. Archive ≠ Soft-pass go.
4. **Tip-pin archive Visuals remain review-gate failure** — runs `36981209109` (#67 @ `b054949`) and `36981181737` (#68 @ `5a69c4b`) fail review-gate by design (deliberate #752–#756 diffs). #68 stamped path is comparable + Approve-honest under Soft-pass HOLD — still not Soft-pass AC clearance.
5. **Global chrome grouping (supporting-facts refresh)** — #754 Inventory id-less nav landed; tip **#768** (paired-only hosting residual from #767) + consumer PR **#68** dogfood show **1×** Global chrome element-added. StyleProof **#779** elevates navigable Global chrome additions into reviewable counts on tip-pin reports. **Facts refresh ≠ Soft-pass go** — this does not lift Soft-pass, clear RECEIPT AC5, or treat #67/#68 archive merges as Soft-pass clearance. HOLD-continue still stands on reasons 1–4, no Ben buyer-promise, and archive-only merges.

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
- Do **not** treat merged consumer PR **#67** / **#68** archive as Soft-pass AC5 clearance (merge comments already HOLD).
- Do **not** treat #66 / #67 / #68 / #752–#756 as Soft-pass clearance.
- Do **not** soft-pass pin-skew, `CERTIFICATION_FAILED`, or product-state-unproven into green.

---

## Related

- Post-wave assess (HOLD-continue reaffirmed @ tip `1104d0b`): `research/soft-pass-ac5-post-wave-assess.md`
- Execution receipt (AC5 HOLD): [`RECEIPT.md`](./RECEIPT.md)
- Harness lift checklist: [`HARNESS.md`](./HARNESS.md)
- Design ACs: [`README.md`](./README.md)
- Receipt PR: StyleProof #750
- Trust/Opening honesty (Soft-pass HOLD sacred): StyleProof #778 (`94aab66`), #779 (`1104d0b`)
- Consumer archive merges (evidence only — Soft-pass HOLD): #67 → `4100838`, #68 → `e2ed688`
