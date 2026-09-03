## 🗺️ StyleProof report

**Release confidence** — ⚠ not evaluated (no release-confidence manifest accompanied this comparison). The style comparison below stands on its own; release certification stays withheld.

⚠️ **Product-state comparison** — unproven on 3 undeclared legacy pair(s). Legacy compatibility preserves the existing visual-review path, but this is not proof that both captures reached the same product state.

🆕 **1 new surface(s)** captured with no baseline to compare: `pricing @ 900`. Approve them before they become the baseline.

**3 computed-style difference(s)** across 1 distinct change(s) in 1 changed surface base with an existing baseline.
_**Surface base** = one product UI state; capture keys with `@width` or live-state/popup variants are width or state captures of that base._

## 🆕 New pages, states, or surfaces — review first

### `pricing@900` · new surface <!-- styleproof-new -->

_pricing @ 900_

![new surface — after](crops/pricing-900-1-new.png)

<sub>after · pricing @ 900</sub>

_No baseline to compare against — this surface is new. Review and approve it before it becomes part of the baseline._

## Element-level changes

### `span.caret` · 1 element restyled

_home @ 900_

`color` `#9ca3af` → `#2563eb`

![before ◀ │ ▶ after](crops/home-900-2-composite.png)

<sub>◀ before  ·  after ▶ — home @ 900</sub>

![highlighted before ◀ │ ▶ after](crops/home-900-2-annotated.png)

<sub>🔍 magenta boxes mark each change — changed: `span.caret`</sub>

![zoomed before ◀ │ ▶ after](crops/home-900-2-zoom.png)

<sub>🔬 magnified 5× — change too small to see at 1:1 — changed: `span.caret`</sub>

- **`span.caret`** — text gray (`#9ca3af`) → blue (`#2563eb`)

<details>
<summary>Show the property change</summary>

**`span.caret`**

Style:

| Property | Before | After |
| --- | --- | --- |
| `color` | `#9ca3af` | `#2563eb` |

</details>

### `button.cta` · 1 element restyled

_home @ 900_

`background-color` `#2563eb` → `#dc2626`

![before ◀ │ ▶ after](crops/home-900-3-composite.png)

<sub>◀ before  ·  after ▶ — home @ 900</sub>

![highlighted before ◀ │ ▶ after](crops/home-900-3-annotated.png)

<sub>🔍 magenta boxes mark each change — changed: `button.cta`</sub>

- **`button.cta`** — background blue (`#2563eb`) → red (`#dc2626`)

<details>
<summary>Show the property change</summary>

**`button.cta`**

Style:

| Property | Before | After |
| --- | --- | --- |
| `background-color` | `#2563eb` | `#dc2626` |

</details>

### `aside.off-canvas-status` · 1 element restyled

_home @ 900_

`opacity` `0.85` → `1`

_The changed element is not visible in the captured page (it is outside the screenshot canvas, hidden at this breakpoint, or background content behind an active modal), so a before/after crop would be misleading._

- **`aside.off-canvas-status`** — opacity 0.85 → 1

<details>
<summary>Show the property change</summary>

**`aside.off-canvas-status`**

Style:

| Property | Before | After |
| --- | --- | --- |
| `opacity` | `0.85` | `1` |

</details>
