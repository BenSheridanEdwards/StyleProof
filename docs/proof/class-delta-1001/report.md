## 🗺️ StyleProof report

⚠️ **Product-state identity unproven** (pair with no product-state declared). Base and head used the same surface key, but product-state identity is unproven — treat the diff as visual-only, not a certified same-state compare.

✓ No reviewable computed-style changes among semantically matched elements. Content/structure was not evaluated.

**Reach incomplete** — no changed CSS rule in any served stylesheet. Not checked: changed stylesheets no capture served (for example a lazy route's or code-split chunk's CSS). These are not held by `changeReach: 'gate'`.

**J2 script reach (warn-only)** — 0 reached, 4 never-rendered, 0 unmeasured, 0 unknown, 0 run-level gap(s) (warn-only). Navigation-window execution includes transient loading code; running a value does not prove rendering.

**J3 class reach (warn-only)** — 0 reached, 4 never-rendered, 0 unknown, 0 unmeasured, 0 run-level gap(s) (warn-only). No per-occurrence render provenance is recorded.

## Script change reach (J2)

_Warn-only under both changeReach levels. Execution is navigation-window block entry, including transient loading code; value rendering requires exact-range J1/J3 corroboration._

**never-rendered**

| Source | Side | Execution | Why |
| --- | --- | --- | --- |
| `app.js:1:0-2:20 (2 units)` | base | ran | value; rendering not proved; J2 block-entry limit: code after a throwing expression is not proved; J3: class token never landed on a captured element |
| `app.js:1:0-2:20 (2 units)` | head | ran | value; rendering not proved; J2 block-entry limit: code after a throwing expression is not proved; J3: class token never landed on a captured element |

## Class change reach (J3)

_Warn-only under both changeReach levels. No per-occurrence render provenance is recorded. Token-name deltas never prove reach; J3 never upgrades J2._

| Source | Side | Token | Status | Why |
| --- | --- | --- | --- | --- |
| `app.js:1:11-1:16` | base | `old` | never-rendered | class token never landed on a captured element |
| `app.js:2:14-2:19` | base | `old` | never-rendered | class token never landed on a captured element |
| `app.js:1:11-1:16` | head | `new` | never-rendered | class token never landed on a captured element |
| `app.js:2:14-2:19` | head | `new` | never-rendered | class token never landed on a captured element |

<details>
<summary>Evidence (warnings & failures)</summary>

**Certification**
- **Inventory** — ⚠ not checked (no captured map carried an inventory — set `inventory: true` in the capture spec to arm the navigable-removal gate)

⚠️ **Product-state comparison** — unproven on 1 paired capture(s) with no product-state declared.

</details>
