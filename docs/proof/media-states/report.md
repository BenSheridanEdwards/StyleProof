## 🗺️ StyleProof report

⚠️ **Product-state identity unproven** (pair with no product-state declared). Base and head used the same surface key, but product-state identity is unproven — treat the diff as visual-only, not a certified same-state compare.

**1 change needs review**

**1 distinct change** (1 computed-style difference(s)) in 1 changed surface base (3 variants) with an existing baseline.

**What changed**

- `home-contrast @ 1280` +2 more surface(s) — **`button.subject`** border 2px → 7px

**Reach incomplete** — base: missing base ledger on 3 capture(s); changed rules cannot be listed; head: missing head ledger on 3 capture(s); changed rules cannot be listed. Fix: recapture with `captureReach`. Not checked: changed stylesheets no capture served (for example a lazy route's or code-split chunk's CSS), render-code reach and class-list deltas.

## Changes

### **Subject** `button.subject` · 1 element restyled

_Identical across 3 surfaces: home-contrast · variant -contrast- @ 1280 · home-dark · variant -dark- @ 1280 · home-print · variant -print- @ 1280_

`border-width` `2px` → `7px`

![before ◀ │ ▶ after](crops/home-contrast-1280-1-composite.png)

<sub>◀ before  ·  after ▶ — home-contrast @ 1280 · variant `contrast`</sub>

<details>
<summary>Show highlight overlay</summary>

![highlighted before ◀ │ ▶ after](crops/home-contrast-1280-1-annotated.png)

<sub>🔍 magenta boxes mark each change — changed: `button.subject`</sub>

</details>

- **`button.subject`** — border 2px → 7px

<details>
<summary>Show the property change</summary>

**Subject** `button.subject`

Style:

| Property | Before | After |
| --- | --- | --- |
| `border-width` | `2px` | `7px` |

</details>

## Changed but never matched

_Changed CSS rules no captured state matched, so the diff above cannot show them. Add a surface or state that matches each one. Source is the served stylesheet; the ledger does not record source maps yet. Reach findings do not change the verdict._

| Rule | Change | Gated by | Source | Why |
| --- | --- | --- | --- | --- |

**Reach evidence gaps** — changed rules here cannot be listed

- base: missing base ledger on 3 capture(s); changed rules cannot be listed — recapture with `captureReach`
- head: missing head ledger on 3 capture(s); changed rules cannot be listed — recapture with `captureReach`

**Not checked**

- changed stylesheets no capture served: StyleProof does not yet join the pull request's changed stylesheets with the sheets captures served, so a lazy route's or code-split chunk's changed CSS is not listed here — add a surface that loads each changed stylesheet; a later Change Reach phase (#934) adds the join

<details>
<summary>Evidence (warnings & failures)</summary>

⚠️ **Product-state comparison** — unproven on 3 paired capture(s) with no product-state declared.

</details>
