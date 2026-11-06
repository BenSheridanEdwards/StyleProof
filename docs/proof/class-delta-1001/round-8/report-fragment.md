## 🗺️ StyleProof report

⚠️ **Product-state identity unproven** (pair with no product-state declared). Base and head used the same surface key, but product-state identity is unproven — treat the diff as visual-only, not a certified same-state compare.

✓ No reviewable computed-style changes among semantically matched elements. Content/structure was not evaluated.

**Reach incomplete** — no changed CSS rule in any served stylesheet. Not checked: changed stylesheets no capture served (for example a lazy route's or code-split chunk's CSS). Class-list deltas are not checked where J3 source, vocabulary or pairing evidence is unavailable; see J3 gaps. These are not held by `changeReach: 'gate'`.

**J2 script reach (warn-only)** — 0 reached, 0 never-rendered, 0 unmeasured, 2 unknown, 0 run-level gap(s) (warn-only). Navigation-window execution includes transient loading code; running a value does not prove rendering.

**J3 class reach (warn-only)** — 0 reached, 0 never-rendered, 0 unknown, 0 unmeasured, 2 run-level gap(s) (warn-only). No per-occurrence render provenance is recorded.

## Script change reach (J2)

_Warn-only under both changeReach levels. Execution is navigation-window block entry, including transient loading code; value rendering requires exact-range J1/J3 corroboration._

**unknown**

| Source | Side | Execution | Why |
| --- | --- | --- | --- |
| `app.ts:2:61-2:70` | base | ran | value; rendering not proved; J2 residual naming skipped for source lines over 128 UTF-16 code units; J2 block-entry limit: code after a throwing expression is not proved |
| `app.ts:2:61-2:70` | head | ran | value; rendering not proved; J2 residual naming skipped for source lines over 128 UTF-16 code units; J2 block-entry limit: code after a throwing expression is not proved |

## Class change reach (J3)

_Warn-only under both changeReach levels. No per-occurrence render provenance is recorded. Token-name deltas never prove reach; J3 never upgrades J2._

| Source | Side | Token | Status | Why |
| --- | --- | --- | --- | --- |
- base: app.ts:2:61: dynamic class template fragment excluded — capture both revisions with captureReach and retain paired maps, served CSS class vocabulary and changed source ranges
- head: app.ts:2:61: dynamic class template fragment excluded — capture both revisions with captureReach and retain paired maps, served CSS class vocabulary and changed source ranges

<details>
<summary>Evidence (warnings & failures)</summary>

**Certification**
- **Inventory** — ⚠ not checked (no captured map carried an inventory — set `inventory: true` in the capture spec to arm the navigable-removal gate)

⚠️ **Product-state comparison** — unproven on 1 paired capture(s) with no product-state declared.

</details>
