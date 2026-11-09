## 🗺️ StyleProof report

⚠️ **Product-state identity unproven** (pair with no product-state declared). Base and head used the same surface key, but product-state identity is unproven — treat the diff as visual-only, not a certified same-state compare.

**2 changes need review**

🆕 **1 new surface(s)** captured with no baseline to compare: `pricing @ 900`. These are reviewable first-adoption surfaces; approve them before they become the baseline.

**1 distinct change** (3 computed-style difference(s)) in 1 changed surface base with an existing baseline.

**What changed**

- `pricing @ 900` — 🆕 new surface, no baseline
- `home @ 900` — **`aside.off-canvas-status`** opacity 0.85 → 1 · **`span.caret`** text gray (`#9ca3af`) → blue (`#2563eb`) · **`button.cta`** background blue (`#2563eb`) → red (`#dc2626`)

🧱 **2 visible element addition(s)/removal(s)** need review (STYLE_REVIEW_REQUIRED) — Approve clears them with other reviewable changes.

📝 _3 content/structure change(s) below — visible additions/removals gate the check; text and invisible DOM churn stay advisory._

## One-sided pages, states, or surfaces — review first

### `pricing@900` · new surface <!-- styleproof-new -->

_pricing @ 900_

![new surface — after](crops/pricing-900-1-new.png)

<sub>after · pricing @ 900</sub>

_No baseline to compare against. This is a reviewable first-adoption surface; approve it before it becomes part of the baseline._

## Changes

### **Caret** `span.caret` · 1 element restyled

_home @ 900_

<img src="crops/home-900-2-where.png" width="320" alt="Where on the page: 1 changed element highlighted"><br><sub>Where: 1 changed element on the page</sub>

`color` `#9ca3af` → `#2563eb`

| Before | After |
| --- | --- |
| <img src="crops/home-900-2-before.png" width="340" alt="Before: the span.caret element"> | <img src="crops/home-900-2-after.png" width="340" alt="After: the span.caret element"> |

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

<img src="crops/home-900-3-where.png" width="320" alt="Where on the page: 1 changed element highlighted"><br><sub>Where: 1 changed element on the page</sub>

`background-color` `#2563eb` → `#dc2626`

| Before | After |
| --- | --- |
| <img src="crops/home-900-3-before.png" width="340" alt="Before: the button.cta element"> | <img src="crops/home-900-3-after.png" width="340" alt="After: the button.cta element"> |

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

## 📝 Content and structure changes

_3 content/structure change(s). **Visible element additions/removals (2) are reviewable** and gate the check (STYLE_REVIEW_REQUIRED); Approve clears them with other reviewable changes. Pure text, invisible/zero-size DOM churn, retags, and live/age/clock text stay advisory and do not alone change the verdict._

### `duplicate-insertion@900` · 1 content/structure change(s)

**`button.duplicate-control`**

- element added

<img src="crops/duplicate-insertion-900-content-1-where.png" width="320" alt="Where on the page: 1 changed element highlighted"><br><sub>Where: 1 changed element on the page</sub>

| Before | After |
| --- | --- |
| <img src="crops/duplicate-insertion-900-content-1-before.png" width="340" alt="Before: the changed content"> | <img src="crops/duplicate-insertion-900-content-1-after.png" width="340" alt="After: the changed content"> |

### `home@900` · 1 content/structure change(s)

**`span.content-label`**

- before: `Old`
- after: `New`

<img src="crops/home-900-content-2-where.png" width="320" alt="Where on the page: 1 changed element highlighted"><br><sub>Where: 1 changed element on the page</sub>

| Before | After |
| --- | --- |
| <img src="crops/home-900-content-2-before.png" width="340" alt="Before: the changed content"> | <img src="crops/home-900-content-2-after.png" width="340" alt="After: the changed content"> |

### `sibling-insertion@900` · 1 content/structure change(s)

**`div.scope-switch`**

- element added

<img src="crops/sibling-insertion-900-content-3-where.png" width="320" alt="Where on the page: 1 changed element highlighted"><br><sub>Where: 1 changed element on the page</sub>

| Before | After |
| --- | --- |
| <img src="crops/sibling-insertion-900-content-3-before.png" width="340" alt="Before: the changed content"> | <img src="crops/sibling-insertion-900-content-3-after.png" width="340" alt="After: the changed content"> |

<details>
<summary>Evidence (warnings & failures)</summary>

⚠️ **Product-state comparison** — unproven on 3 paired capture(s) with no product-state declared.

</details>
