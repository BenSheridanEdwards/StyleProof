## 🗺️ StyleProof report

**1 change needs review**

⚠️ **1 baseline capture failure(s)**: these named surface(s) failed on the base SHA and were omitted from the baseline bundle: `about@auto` at `d6c4bdf18be844c6105b237bc9246bf620b8286e`. The base bundle was produced (`base-capture-failed=false`); this is not a base recapture failure. Repair the named surface(s) on that SHA; do not approve indefinitely. Raw exception details stay private.
⚠️ **1 head surface(s)** have no base map because a named baseline surface capture failed (not first adoption, not a base recapture failure): `about @ 320`.

**What changed**

- `about @ 320` — ⚠️ baseline repair needed

### Baseline capture failure receipt

- `about@auto` · `capture_failed` · `d6c4bdf18be844c6105b237bc9246bf620b8286e`

_Named surface+SHA above. This is not a base recapture failure (`base-capture-failed=false`)._


## One-sided pages, states, or surfaces — review first

### `about@320` · baseline repair needed ⚠️

_about @ 320_

![baseline repair needed — after](crops/about-320-1-new.png)

<sub>after · about @ 320</sub>

_The matching baseline surface capture failed. This is **baseline repair needed**, not first adoption and not a base recapture failure; repair `about@320` on the named SHA in the receipt above._

<details>
<summary>Evidence (warnings & failures)</summary>

**Certification**
- **Inventory** — ⚠ not checked (no captured map carried an inventory — set `inventory: true` in the capture spec to arm the navigable-removal gate)

</details>

<!-- styleproof-receipt head-sha:57ba0e5860fb4f658f988eb3f1b1551708fe1ee2 run-id:41051564027 run-attempt:1 -->
