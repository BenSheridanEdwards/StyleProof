## 🗺️ StyleProof report

⚠️ **Product-state identity unproven** (pair with no product-state declared). Base and head used the same surface key, but product-state identity is unproven — treat the diff as visual-only, not a certified same-state compare.

✓ No reviewable computed-style changes among semantically matched elements. Content/structure was not evaluated.

**Reach incomplete** — no changed CSS rule in any served stylesheet. Not checked: changed stylesheets no capture served (for example a lazy route's or code-split chunk's CSS) and class-list deltas.

**J2 script reach (warn-only)** — 0 reached, 0 never-rendered, 2 unmeasured, 0 unknown, 0 run-level gap(s) (warn-only). Navigation-window execution includes transient loading code; running a value does not prove rendering.

## Script change reach (J2)

_Warn-only under both changeReach levels. Execution is navigation-window block entry, including transient loading code; value rendering requires exact-range J1/J3 corroboration._

**unmeasured**

| Source | Side | Execution | Why |
| --- | --- | --- | --- |
| `app.tsx:4:16-4:22` | base | unmeasured | no mapped anchor inside the changed range; the preceding anchor ran but cannot prove this code ran (it may have been removed by the bundler); preceding-anchor evidence (nearest mapped start at or before the changed range) |
| `app.tsx:4:16-4:20` | head | unmeasured | no mapped anchor inside the changed range; the preceding anchor ran but cannot prove this code ran (it may have been removed by the bundler); preceding-anchor evidence (nearest mapped start at or before the changed range) |

<details>
<summary>Evidence (warnings & failures)</summary>

**Certification**
- **Inventory** — ⚠ not checked (no captured map carried an inventory — set `inventory: true` in the capture spec to arm the navigable-removal gate)

⚠️ **Product-state comparison** — unproven on 1 paired capture(s) with no product-state declared.

</details>
