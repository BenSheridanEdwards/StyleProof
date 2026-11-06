## 🗺️ StyleProof report

**1 change needs review**

⚠️ **1 baseline capture failure(s)**: these named surface(s) failed on the base SHA and were omitted from the baseline bundle: `about@auto` at `6694a77bb7fa92155df6a62fe8f65116e020a99e`. The base bundle was produced (`base-capture-failed=false`); this is not a base recapture failure. Repair the named surface(s) on that SHA; do not approve indefinitely. Raw exception details stay private.
⚠️ **1 head surface(s)** have no base map because a named baseline surface capture failed (not first adoption, not a base recapture failure): `about @ 320`.

**What changed**

- `about @ 320` — ⚠️ baseline repair needed

### Baseline capture failure receipt

- `about@auto` · `capture_failed` · `6694a77bb7fa92155df6a62fe8f65116e020a99e`

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

<!-- styleproof-receipt head-sha:79e848b7d7ba619ae18ead8c15b4436ee46d4240 run-id:42263115506 run-attempt:1 -->
