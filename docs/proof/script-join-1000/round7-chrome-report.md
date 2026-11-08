## 🗺️ StyleProof report

⚠️ **Product-state identity unproven** (pair with no product-state declared). Base and head used the same surface key, but product-state identity is unproven — treat the diff as visual-only, not a certified same-state compare.

**1 visible element addition/removal needs review**

_Approve all changes clears STYLE_REVIEW_REQUIRED for these structure elevations (with other reviewable changes)._

🧱 **1 global chrome element change(s)** — added or removed on every surface base that renders its container; listed once under Global chrome below. Visible additions/removals need review (STYLE_REVIEW_REQUIRED) — Approve clears them with other reviewable changes.

**Reach incomplete** — no changed CSS rule in any served stylesheet. Not checked: changed stylesheets no capture served (for example a lazy route's or code-split chunk's CSS) and class-list deltas.

**J2 script reach (warn-only)** — 0 reached, 0 never-rendered, 2 unmeasured, 0 unknown, 1 run-level gap(s) (warn-only). Navigation-window execution includes transient loading code; running a value does not prove rendering.

---

## 🧱 Global chrome — 1 element change on every surface base that renders its container

_Each element below was added or removed identically on every captured surface base that renders its container (inside a nav, header or footer), so it is listed once here instead of once per surface — review it once. Visible element additions/removals are reviewable and gate the check (STYLE_REVIEW_REQUIRED); Approve clears them with other reviewable changes. Navigable Global chrome additions (1) elevate via #766; other invisible/zero-size chrome structure stays advisory._

**`a`** — element added on all 2 surface bases that render its container (2 captures)

<sub>home @ 1280 · status @ 1280</sub>

## Script change reach (J2)

_Warn-only under both changeReach levels. Execution is navigation-window block entry, including transient loading code; value rendering requires exact-range J1/J3 corroboration._

**unmeasured**

| Source | Side | Execution | Why |
| --- | --- | --- | --- |
| `app.tsx:4:16-4:22` | base | unmeasured | no mapped anchor inside the changed range; the preceding anchor ran but cannot prove this code ran (it may have been removed by the bundler); preceding-anchor evidence (nearest mapped start at or before the changed range) |
| `app.tsx:4:16-4:20` | head | unmeasured | no mapped anchor inside the changed range; the preceding anchor ran but cannot prove this code ran (it may have been removed by the bundler); preceding-anchor evidence (nearest mapped start at or before the changed range) |

**J2 run-level gaps (unmeasured)**

- changed files J2 does not judge: 1 path(s); first: index.html — capture both revisions with \`captureScriptReach\` and source maps, retaining their git SHAs and sourcesContent
- `index.html`

<details>
<summary>Evidence (warnings & failures)</summary>

**Certification**
- **Inventory** — ⚠ not checked (no captured map carried an inventory — set `inventory: true` in the capture spec to arm the navigable-removal gate)

⚠️ **Product-state comparison** — unproven on 2 paired capture(s) with no product-state declared.

</details>
