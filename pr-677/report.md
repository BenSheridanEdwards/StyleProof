## 🗺️ StyleProof report

**Certification**
- **Coverage** — ✓ complete (all 1 registered surface(s) captured)
- **Determinism** — ✓ proven (base self-checked, head self-checked)
- **Inventory** — ⚠ not checked (no captured map carried an inventory — set `inventory: true` in the capture spec to arm the navigable-removal gate)
- **Confidence** — ✓ complete (1 captured)

⛔ **Integrity repair required** — `CERTIFICATION_FAILED`. Reviewer approval cannot clear this. Repair the evidence, then re-run.

- **`duplicate-id` — Duplicate identity in a style map.**
  - **What broke:** A style map contains a duplicate JSON key or a duplicate inventory identity. JSON.parse would keep only the last value, so correspondence and inventory would silently drop a real element. Affected surface(s): `home@320`.
  - **What to fix:** Give each element or navigable affordance a unique key (stable `id`, `data-testid`, or href). Recapture the surface so the map no longer carries a duplicate identity.
  - **How to verify:** Re-run styleproof-diff (or the Action). The report must no longer name `duplicate-id`, and styleproof-audit.json must show the integrity check clean.

⛔ **Product-state comparison** — unproven; 1 required-unproven paired capture(s). Raw detector evidence is diagnostic only, is not approval evidence, and cannot certify this comparison.

Computed-style scope only: No reviewable computed-style changes among semantically matched elements. Content/structure was not evaluated.

<!-- styleproof-receipt head-sha:60e2f3d9e8dd6e632703aae8705ba4e7f4c5a82c run-id:35121803004 run-attempt:1 -->
