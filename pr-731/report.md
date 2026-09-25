## 🗺️ StyleProof report

**Certification**
- **Coverage** — ✓ complete (all 2 registered surface(s) captured)
- **Determinism** — ✓ proven (base self-checked, head self-checked)
- **Inventory** — ⚠ not checked (no captured map carried an inventory — set `inventory: true` in the capture spec to arm the navigable-removal gate)
- **Confidence** — ✓ complete (2 captured)

**Product-state comparison** — ✓ comparable on 1 paired capture(s) using explicit consumer-owned identity.

⚠️ **1 baseline capture failure(s)**: these named surface(s) failed on the base SHA and were omitted from the baseline bundle: `about@auto` at `08a3c97c443ad73f8337f30d7bbcad2768b31309`. The base bundle was produced (`base-capture-failed=false`); this is not a base recapture failure. Repair the named surface(s) on that SHA; do not approve indefinitely. Raw exception details stay private.
⚠️ **1 head surface(s)** have no base map because a named baseline surface capture failed (not first adoption, not a base recapture failure): `about @ 320`.


### Baseline capture failure receipt

- `about@auto` · `capture_failed` · `08a3c97c443ad73f8337f30d7bbcad2768b31309`

_Named surface+SHA above. This is not a base recapture failure (`base-capture-failed=false`)._


## One-sided pages, states, or surfaces — review first

### `about@320` · baseline repair needed ⚠️

_about @ 320_

![baseline repair needed — after](crops/about-320-1-new.png)

<sub>after · about @ 320</sub>

_The matching baseline surface capture failed. This is **baseline repair needed**, not first adoption and not a base recapture failure; repair `about@320` on the named SHA in the receipt above._

<!-- styleproof-receipt head-sha:f43e1ceea0ed9871325463433801447098842bb9 run-id:36129574324 run-attempt:1 -->
