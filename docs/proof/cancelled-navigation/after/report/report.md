## 🗺️ StyleProof report

⚠️ **Product-state identity unproven** (undeclared legacy pair). Base and head used the same surface key, but product-state identity is unproven — treat the diff as visual-only, not a certified same-state compare.

✓ No reviewable computed-style changes among semantically matched elements. Content/structure was not evaluated.

<details>
<summary>Evidence (warnings & failures)</summary>

**Certification**
- **Coverage** — ⚠ not asserted (no `expected` registry; certifies only the captured surfaces)
- **Inventory** — ⚠ not checked (no captured map carried an inventory — set `inventory: true` in the capture spec to arm the navigable-removal gate)
- **Failed data request**: ✗ this page called an API that failed, so the screenshot is the fallback UI, not the real data. dashboard called `/api/probe` (HTTP 503). Fixture the API, or declare why the fallback is the intended capture.
- **Confidence** — ⚠ unasserted (no `expected` registry — certifies only the 1 captured surface(s), not that they are all of them)

⚠️ **Product-state comparison** — unproven on 1 undeclared legacy pair(s).

</details>
