## 🗺️ StyleProof report

⚠️ **Product-state identity unproven** (pair with no product-state declared). Base and head used the same surface key, but product-state identity is unproven — treat the diff as visual-only, not a certified same-state compare.

**1 change needs review**

**1 distinct change** (2 computed-style difference(s)) in 1 changed surface base with an existing baseline.

**What changed**

- `home @ 1280` — **`main.steady`** recoloured red (`#ff0000`) → dark blue (`#0000ff`)

**Reach incomplete** — no changed CSS rule in any served stylesheet. Not checked: changed stylesheets no capture served (for example a lazy route's or code-split chunk's CSS). These are not held by `changeReach: 'gate'`.

**J2 script reach (warn-only)** — 0 reached, 0 never-rendered, 3 unmeasured, 0 unknown, 0 run-level gap(s) (warn-only). Navigation-window execution includes transient loading code; running a value does not prove rendering.

**J3 class reach (warn-only)** — 0 reached, 0 never-rendered, 0 unknown, 0 unmeasured, 0 run-level gap(s) (warn-only). No per-occurrence render provenance is recorded.

## Changes

### **Steady** `main.steady` · 1 element restyled

_home @ 1280_

`border-color` `#ff0000` → `#0000ff`<br>
`color` `#ff0000` → `#0000ff`

_No screenshots in these capture sets (run captures with `screenshots: true` for side-by-side crops)._

- **`main.steady`** — recoloured red (`#ff0000`) → dark blue (`#0000ff`)

<details>
<summary>Show all 2 property changes</summary>

**Steady** `main.steady`

Style:

| Property | Before | After |
| --- | --- | --- |
| `border-color` | `#ff0000` | `#0000ff` |
| `color` | `#ff0000` | `#0000ff` |
| ↳ `caret-color` _(currentColor)_ | `#ff0000` | `#0000ff` |
| ↳ `outline-color` _(currentColor)_ | `#ff0000` | `#0000ff` |
| ↳ `column-rule-color` _(currentColor)_ | `#ff0000` | `#0000ff` |
| ↳ `row-rule-color` _(currentColor)_ | `#ff0000` | `#0000ff` |
| ↳ `text-decoration-color` _(currentColor)_ | `#ff0000` | `#0000ff` |
| ↳ `text-emphasis-color` _(currentColor)_ | `#ff0000` | `#0000ff` |
| ↳ `-webkit-text-fill-color` _(currentColor)_ | `#ff0000` | `#0000ff` |
| ↳ `-webkit-text-stroke-color` _(currentColor)_ | `#ff0000` | `#0000ff` |

</details>

## Script change reach (J2)

_Warn-only under both changeReach levels. Execution is navigation-window block entry, including transient loading code; value rendering requires exact-range J1/J3 corroboration._

**unmeasured**

| Source | Side | Execution | Why |
| --- | --- | --- | --- |
| `app.ts:1:0-1:39` | base | unmeasured | script token without an execution start, including leading text, retains negative or missing preceding-anchor evidence; preceding-anchor evidence (nearest mapped start at or before the changed range) |
| `app.ts:2:0-2:138` | base | unmeasured | changed script token has no mapped anchor at its start; the preceding anchor ran but cannot prove this code ran (it may have been removed by the bundler); preceding-anchor evidence (nearest mapped start at or before the changed range) |
| `app.ts:1:0-1:165` | head | unmeasured | changed script token has no mapped anchor at its start; the preceding anchor ran but cannot prove this code ran (it may have been removed by the bundler); preceding-anchor evidence (nearest mapped start at or before the changed range) |

<details>
<summary>Evidence (warnings & failures)</summary>

**Certification**
- **Inventory** — ⚠ not checked (no captured map carried an inventory — set `inventory: true` in the capture spec to arm the navigable-removal gate)

⚠️ **Product-state comparison** — unproven on 1 paired capture(s) with no product-state declared.

</details>
