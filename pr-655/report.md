## 🗺️ StyleProof report

**Certification**
- **Coverage** — ✓ complete (all 1 registered surface(s) captured)
- **Determinism** — ✓ proven (base self-checked, head self-checked)
- **Inventory** — ⚠ not checked (no captured map carried an inventory — set `inventory: true` in the capture spec to arm the navigable-removal gate)
- **Confidence** — ✓ complete (1 captured)

⛔ **Integrity repair required** — `CERTIFICATION_FAILED`. Reviewer approval cannot clear this. Repair the evidence, then re-run.

- **`connector-partial` — Map connector returned a partial bundle.**
  - **What broke:** The map-store or evidence connector restored only some of the expected surfaces. Certification cannot compare a partial restore as if it were a complete pair. Affected surface(s): `home`.
  - **What to fix:** Re-run the connector restore for the missing surfaces, or recapture those surfaces and republish the bundle. Do not tick visual approval — the missing maps are not a style delta.
  - **How to verify:** Re-run styleproof-diff (or the Action). The connector receipt must read `complete`, every expected surface must have a map on both sides, and the integrity repair block must disappear.

**Product-state comparison** — ✓ comparable on 1 paired capture(s) using explicit consumer-owned identity.

✓ No reviewable computed-style changes among semantically matched elements. Content/structure was not evaluated.

<!-- styleproof-receipt head-sha:37719204bdfb024b5eb16223a0a438b25ce3b29b run-id:34883152058 run-attempt:1 -->
