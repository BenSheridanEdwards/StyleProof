## 🗺️ StyleProof report

🆕 **1 new surface(s)** captured with no baseline to compare: `pricing @ 900`. Approve them before they become the baseline.

**5 DOM change(s) · 8 computed-style difference(s)** across 3 distinct change(s) in 3 changed surface bases with an existing baseline.
_**Surface base** = one product UI state; capture keys with `@width` or live-state/popup variants are width or state captures of that base._

## 🆕 New pages, states, or surfaces — review first

### `pricing@900` · new surface <!-- styleproof-new -->

_pricing @ 900_

![new surface — after](crops/pricing-900-1-new.png)

<sub>after · pricing @ 900</sub>

_No baseline to compare against — this surface is new. Review and approve it before it becomes part of the baseline._

## Element-level changes

### `button.duplicate-control` · 1 element added

_duplicate-insertion @ 900_

![before ◀ │ ▶ after](crops/duplicate-insertion-900-2-composite.png)

<sub>◀ before  ·  after ▶ — duplicate-insertion @ 900</sub>

![highlighted before ◀ │ ▶ after](crops/duplicate-insertion-900-2-annotated.png)

<sub>🔍 magenta boxes mark each change — changed: `button.duplicate-control`</sub>

- **1** element added

<details>
<summary>Show the property change</summary>

**Added** `button.duplicate-control`

Style:

| Property | Value |
| --- | --- |
| `background-color` | `#2563eb` |

</details>

### `span.caret` · 1 element restyled

_home @ 900_

![before ◀ │ ▶ after](crops/home-900-3-composite.png)

<sub>◀ before  ·  after ▶ — home @ 900</sub>

![highlighted before ◀ │ ▶ after](crops/home-900-3-annotated.png)

<sub>🔍 magenta boxes mark each change — changed: `span.caret`</sub>

![zoomed before ◀ │ ▶ after](crops/home-900-3-zoom.png)

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

![before ◀ │ ▶ after](crops/home-900-4-composite.png)

<sub>◀ before  ·  after ▶ — home @ 900</sub>

![highlighted before ◀ │ ▶ after](crops/home-900-4-annotated.png)

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

### `div.toolbar` + 2 more · 3 elements added, 1 element removed, 2 elements restyled

_sibling-insertion @ 900_

![before ◀ │ ▶ after](crops/sibling-insertion-900-5-composite.png)

<sub>◀ before  ·  after ▶ — sibling-insertion @ 900</sub>

![highlighted before ◀ │ ▶ after](crops/sibling-insertion-900-5-annotated.png)

<sub>🔍 magenta boxes mark each change — changed: `div.scope-switch`</sub>

- **1** element removed
- **3** elements added
- **`div.toolbar`** — background dark green (`#374151`) → dark indigo (`#581c87`)
- **`div.grid`** — background white (`#e5e7eb`) → dark green (`#374151`)

<details>
<summary>Show all 5 property changes</summary>

**`div.toolbar`**

Style:

| Property | Before | After |
| --- | --- | --- |
| `background-color` | `#374151` | `#581c87` |

**`div.grid`**

Style:

| Property | Before | After |
| --- | --- | --- |
| `background-color` | `#e5e7eb` | `#374151` |

**Removed** `article.card`

**Added** `button.filter`

Style:

| Property | Value |
| --- | --- |
| `color` | `#ffffff` |

**Added** `div.grid`

Style:

| Property | Value |
| --- | --- |
| `background-color` | `#e5e7eb` |

**Added** `article.card`

Style:

| Property | Value |
| --- | --- |
| `background-color` | `#ffffff` |

</details>
