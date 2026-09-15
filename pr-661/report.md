## 🗺️ StyleProof report

**Certification**
- **Coverage** — ⚠ not asserted (no `expected` registry; certifies only the captured surfaces)
- **Determinism** — ✓ proven (base self-checked, head self-checked)
- **Inventory** — ⚠ not checked (no captured map carried an inventory — set `inventory: true` in the capture spec to arm the navigable-removal gate)
- **Failed data request**: ✓ no API failed during capture
- **Confidence** — ⚠ unasserted (no `expected` registry — certifies only the 1 captured surface(s), not that they are all of them)

⚠️ **Product-state comparison** — unproven on 3 undeclared legacy pair(s). Legacy compatibility preserves the existing visual-review path, but this is not proof that both captures reached the same product state.

✓ No reviewable computed-style changes among semantically matched elements. Content/structure was not evaluated.

<!-- styleproof-receipt head-sha:8f3771f27b18a33137d81297ddaab25f365e0c76 run-id:34953591645 run-attempt:1 -->
