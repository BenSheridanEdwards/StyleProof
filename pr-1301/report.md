## 🗺️ StyleProof report

**1 change needs review**

⚠️ **1 baseline capture failure(s)**: these named surface(s) failed on the base SHA and were omitted from the baseline bundle: `about@auto` at `67eb3a6df6ed6c2ef288c2d11973dbc1ac8c4d70`. The base bundle was produced (`base-capture-failed=false`); this is not a base recapture failure. Repair the named surface(s) on that SHA; do not approve indefinitely. Raw exception details stay private.
⚠️ **1 head surface(s)** have no base map because a named baseline surface capture failed (not first adoption, not a base recapture failure): `about @ 320`.

**What changed**

- `about @ 320` — ⚠️ baseline repair needed

### Baseline capture failure receipt

- `about@auto` · `capture_failed` · `67eb3a6df6ed6c2ef288c2d11973dbc1ac8c4d70`

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

<!-- styleproof-receipt head-sha:1668bf8b1192fe490b87dc2dd95f5d4e772f4e14 run-id:42047139810 run-attempt:1 -->
