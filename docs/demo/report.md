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

### Caret

<!-- styleproof-section %7B%22v%22%3A1%2C%22id%22%3A%22caret%22%2C%22paths%22%3A%5B%22body%20%3E%20header%3Anth%2Dchild(1)%20%3E%20span%3Anth%2Dchild(1)%22%5D%2C%22more%22%3A0%2C%22pairs%22%3A%5B%7B%22state%22%3A%22rest%22%2C%22before%22%3A%22crops%2Fhome%2D900%2D2%2Dbefore.png%22%2C%22after%22%3A%22crops%2Fhome%2D900%2D2%2Dafter.png%22%2C%22w%22%3A320%2C%22h%22%3A180%2C%22what%22%3A%22the%20caret%22%7D%5D%2C%22where%22%3A%5B%7B%22image%22%3A%22crops%2Fhome%2D900%2D2%2Dwhere.png%22%2C%22side%22%3A%22after%22%2C%22page%22%3A%5B900%2C600%5D%2C%22view%22%3A%5B0%2C0%2C900%2C239%5D%2C%22boxes%22%3A%5B%5B150%2C40%2C12%2C16%5D%5D%7D%5D%2C%22pages%22%3A%5B%7B%22state%22%3A%22rest%22%2C%22before%22%3A%22crops%2Fhome%2D900%2Dpage%2Dbase.png%22%2C%22after%22%3A%22crops%2Fhome%2D900%2Dpage%2Dhead.png%22%2C%22w%22%3A900%2C%22h%22%3A600%7D%5D%7D -->

The caret changes text colour from gray to blue.

<img src="crops/home-900-2-where.png" width="320" alt="Where on home @ 900: 1 caret highlighted"><br><sub>Where: 1 caret on home @ 900</sub>

| Before | After |
| --- | --- |
| <img src="crops/home-900-2-before.png" width="340" alt="Before: the caret"> | <img src="crops/home-900-2-after.png" width="340" alt="After: the caret"> |

<details>
<summary>Show the CSS</summary>

`span.caret` · 1 element restyled

| Property | Before | After |
| --- | --- | --- |
| `color` | `#9ca3af` | `#2563eb` |

</details>

<!-- styleproof-section-end -->

### Cta

<!-- styleproof-section %7B%22v%22%3A1%2C%22id%22%3A%22cta%22%2C%22paths%22%3A%5B%22body%20%3E%20main%3Anth%2Dchild(2)%20%3E%20button%3Anth%2Dchild(1)%22%5D%2C%22more%22%3A0%2C%22pairs%22%3A%5B%7B%22state%22%3A%22rest%22%2C%22before%22%3A%22crops%2Fhome%2D900%2D3%2Dbefore.png%22%2C%22after%22%3A%22crops%2Fhome%2D900%2D3%2Dafter.png%22%2C%22w%22%3A320%2C%22h%22%3A180%2C%22what%22%3A%22the%20cta%22%7D%5D%2C%22where%22%3A%5B%7B%22image%22%3A%22crops%2Fhome%2D900%2D3%2Dwhere.png%22%2C%22side%22%3A%22after%22%2C%22page%22%3A%5B900%2C600%5D%2C%22view%22%3A%5B0%2C17%2C900%2C239%5D%2C%22boxes%22%3A%5B%5B40%2C110%2C180%2C52%5D%5D%7D%5D%2C%22pages%22%3A%5B%7B%22state%22%3A%22rest%22%2C%22before%22%3A%22crops%2Fhome%2D900%2Dpage%2Dbase.png%22%2C%22after%22%3A%22crops%2Fhome%2D900%2Dpage%2Dhead.png%22%2C%22w%22%3A900%2C%22h%22%3A600%7D%5D%7D -->

The cta changes background from blue to red.

<img src="crops/home-900-3-where.png" width="320" alt="Where on home @ 900: 1 cta highlighted"><br><sub>Where: 1 cta on home @ 900</sub>

| Before | After |
| --- | --- |
| <img src="crops/home-900-3-before.png" width="340" alt="Before: the cta"> | <img src="crops/home-900-3-after.png" width="340" alt="After: the cta"> |

<details>
<summary>Show the CSS</summary>

`button.cta` · 1 element restyled

| Property | Before | After |
| --- | --- | --- |
| `background-color` | `#2563eb` | `#dc2626` |

</details>

<!-- styleproof-section-end -->

### Off canvas status

<!-- styleproof-section %7B%22v%22%3A1%2C%22id%22%3A%22off%2Dcanvas%2Dstatus%22%2C%22paths%22%3A%5B%22body%20%3E%20aside%3Anth%2Dchild(3)%22%5D%2C%22more%22%3A0%2C%22pairs%22%3A%5B%5D%2C%22where%22%3A%5B%5D%2C%22pages%22%3A%5B%7B%22state%22%3A%22rest%22%2C%22before%22%3A%22crops%2Fhome%2D900%2Dpage%2Dbase.png%22%2C%22after%22%3A%22crops%2Fhome%2D900%2Dpage%2Dhead.png%22%2C%22w%22%3A900%2C%22h%22%3A600%7D%5D%7D -->

The off canvas status changes opacity from `0.85` to `1`.

_On home @ 900_

_The changed element is not visible in the captured page (it is outside the screenshot canvas, hidden at this breakpoint, or background content behind an active modal), so a before/after crop would be misleading._

<details>
<summary>Show the CSS</summary>

`aside.off-canvas-status` · 1 element restyled

| Property | Before | After |
| --- | --- | --- |
| `opacity` | `0.85` | `1` |

</details>

<!-- styleproof-section-end -->

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
