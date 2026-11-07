## 🗺️ StyleProof report

⚠️ **Product-state identity unproven** (pair with no product-state declared). Base and head used the same surface key, but product-state identity is unproven — treat the diff as visual-only, not a certified same-state compare.

**1 change needs review**

**1 distinct change** (2 computed-style difference(s)) in 1 changed surface base with an existing baseline.

**What changed**

- `no-cdp @ 1000` — **`div.a`** +2 more

## Changes

### **A** `div.a` · 1 element restyled

_no-cdp @ 1000_

`animation-name` `spin` → `wobble`<br>
`transition-duration` `1s` → `3s`

![before ◀ │ ▶ after](crops/no-cdp-1000-1-composite.png)

<sub>◀ before · after ▶ — no-cdp @ 1000</sub>

<details>
<summary>Show highlight overlay</summary>

![highlighted before ◀ │ ▶ after](crops/no-cdp-1000-1-annotated.png)

<sub>🔍 magenta boxes mark each change — changed: `div.a`</sub>

</details>

- **`div.a`** — +2 more

<details>
<summary>Show all 2 property changes</summary>

**A** `div.a`

Style:

| Property              | Before | After    |
| --------------------- | ------ | -------- |
| `animation-name`      | `spin` | `wobble` |
| `transition-duration` | `1s`   | `3s`     |

</details>

_Nothing else — no other element or inventory changes in this compare._

<details>
<summary>Evidence (warnings & failures)</summary>

**Visual channel evidence limits and recommendations**

- `no-cdp@1000`: animation keyframes `spin` unknown; not compared (keyframes resolution ambiguous: unreadable, untraversed or unavailable engine/source evidence).
- `no-cdp@1000`: animation keyframes `wobble` unknown; not compared (keyframes resolution ambiguous: unreadable, untraversed or unavailable engine/source evidence).
- `shadow@1000`: animation keyframes `pulse` unknown; not compared (keyframes resolution ambiguous: unreadable, untraversed or unavailable engine/source evidence).

⚠️ **Product-state comparison** — unproven on 2 paired capture(s) with no product-state declared.

</details>
