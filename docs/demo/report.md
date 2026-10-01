## 🗺️ StyleProof report

⚠️ **Product-state identity unproven** (undeclared legacy pair). Base and head used the same surface key, but product-state identity is unproven — treat the diff as visual-only, not a certified same-state compare.

**2 changes need review**

🆕 **1 new surface(s)** captured with no baseline to compare: `pricing @ 900`. These are reviewable first-adoption surfaces; approve them before they become the baseline.

**1 distinct change** (3 computed-style difference(s)) in 1 changed surface base with an existing baseline.

📝 _3 advisory content change(s) below — they don't affect the check._

## One-sided pages, states, or surfaces — review first

### `pricing@900` · new surface <!-- styleproof-new -->

_pricing @ 900_

![new surface — after](crops/pricing-900-1-new.png)

<sub>after · pricing @ 900</sub>

_No baseline to compare against. This is a reviewable first-adoption surface; approve it before it becomes part of the baseline._

## Changes

### **Caret** `span.caret` · 1 element restyled

_home @ 900_

`color` `#9ca3af` → `#2563eb`

![before ◀ │ ▶ after](crops/home-900-2-composite.png)

<sub>◀ before  ·  after ▶ — home @ 900</sub>

<details>
<summary>Show highlight overlay</summary>

![highlighted before ◀ │ ▶ after](crops/home-900-2-annotated.png)

<sub>🔍 magenta boxes mark each change — changed: `span.caret`</sub>

![zoomed before ◀ │ ▶ after](crops/home-900-2-zoom.png)

<sub>🔬 magnified 5× — change too small to see at 1:1 — changed: `span.caret`</sub>

</details>

- **`span.caret`** — text gray (`#9ca3af`) → blue (`#2563eb`)

<details>
<summary>Show the property change</summary>

**Caret** `span.caret`

Style:

| Property | Before | After |
| --- | --- | --- |
| `color` | `#9ca3af` | `#2563eb` |

</details>

### **Cta** `button.cta` · 1 element restyled

_home @ 900_

`background-color` `#2563eb` → `#dc2626`

![before ◀ │ ▶ after](crops/home-900-3-composite.png)

<sub>◀ before  ·  after ▶ — home @ 900</sub>

<details>
<summary>Show highlight overlay</summary>

![highlighted before ◀ │ ▶ after](crops/home-900-3-annotated.png)

<sub>🔍 magenta boxes mark each change — changed: `button.cta`</sub>

</details>

- **`button.cta`** — background blue (`#2563eb`) → red (`#dc2626`)

<details>
<summary>Show the property change</summary>

**Cta** `button.cta`

Style:

| Property | Before | After |
| --- | --- | --- |
| `background-color` | `#2563eb` | `#dc2626` |

</details>

### **Off canvas status** `aside.off-canvas-status` · 1 element restyled

_home @ 900_

`opacity` `0.85` → `1`

_The changed element is not visible in the captured page (it is outside the screenshot canvas, hidden at this breakpoint, or background content behind an active modal), so a before/after crop would be misleading._

- **`aside.off-canvas-status`** — opacity 0.85 → 1

<details>
<summary>Show the property change</summary>

**Off canvas status** `aside.off-canvas-status`

Style:

| Property | Before | After |
| --- | --- | --- |
| `opacity` | `0.85` | `1` |

</details>

---

## 📝 Content and structure changes (advisory)

_3 content/structure change(s). **Advisory only** — content and DOM structure are not part of the computed-style certification and do not affect the check. Surfaced so copy, element, and reflow changes are visible when content comparison is enabled. Live/age/clock text (relative ages, clocks) is labeled below so it cannot be mistaken for a product style regression._

### `duplicate-insertion@900` · 1 content/structure change(s)

**`button.duplicate-control`**

- element added

![before ◀ │ ▶ after](crops/duplicate-insertion-900-content-1-composite.png)

<sub>◀ before  ·  after ▶ — duplicate-insertion@900</sub>

<details>
<summary>Show highlight overlay</summary>

![highlighted before ◀ │ ▶ after](crops/duplicate-insertion-900-content-1-annotated.png)

<sub>🔍 magenta boxes mark the changed content</sub>

</details>

### `home@900` · 1 content/structure change(s)

**`span.content-label`**

- before: `Old`
- after: `New`

![before ◀ │ ▶ after](crops/home-900-content-2-composite.png)

<sub>◀ before  ·  after ▶ — home@900</sub>

<details>
<summary>Show highlight overlay</summary>

![highlighted before ◀ │ ▶ after](crops/home-900-content-2-annotated.png)

<sub>🔍 magenta boxes mark the changed content</sub>

![zoomed before ◀ │ ▶ after](crops/home-900-content-2-zoom.png)

<sub>🔬 magnified 2×: content change too small to read at 1:1</sub>

</details>

### `sibling-insertion@900` · 1 content/structure change(s)

**`div.scope-switch`**

- element added

![before ◀ │ ▶ after](crops/sibling-insertion-900-content-3-composite.png)

<sub>◀ before  ·  after ▶ — sibling-insertion@900</sub>

<details>
<summary>Show highlight overlay</summary>

![highlighted before ◀ │ ▶ after](crops/sibling-insertion-900-content-3-annotated.png)

<sub>🔍 magenta boxes mark the changed content</sub>

</details>

<details>
<summary>Evidence (warnings & failures)</summary>

⚠️ **Product-state comparison** — unproven on 3 undeclared legacy pair(s).

</details>
