## 🗺️ StyleProof report

**Certification**
- **Coverage** — ✓ complete (all 1 registered surface(s) captured)
- **Determinism** — ✓ proven (base self-checked, head self-checked)
- **Inventory** — ⚠ not checked (no captured map carried an inventory — set `inventory: true` in the capture spec to arm the navigable-removal gate)
- **Confidence** — ✓ complete (1 captured)

⛔ **Integrity repair required** — `CERTIFICATION_FAILED`. Reviewer approval cannot clear this. Repair the evidence, then re-run.

- **`integrity-mismatch` — Claimed evidence digest does not match the bytes.**
  - **What broke:** A source SHA or content digest declared by the connector or integrity receipt does not match the bytes on disk. The comparison would be bound to the wrong capture.
  - **What to fix:** Restore or recapture from the exact claimed SHA, then republish the bundle. Do not reuse a map that failed digest verification.
  - **How to verify:** Re-run styleproof-diff (or the Action) against the republished bundle. Claimed and actual digests must match, and the integrity repair block must disappear.

**Product-state comparison** — ✓ comparable on 1 paired capture(s) using explicit consumer-owned identity.

✓ No reviewable computed-style changes among semantically matched elements. Content/structure was not evaluated.

<!-- styleproof-receipt head-sha:a4f548737f348adcd713bb6236552517815d3b59 run-id:35131382140 run-attempt:1 -->
