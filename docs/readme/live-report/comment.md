<!-- styleproof-report -->
## 🗺️ StyleProof report

**5 computed-style difference(s) · 4 state-delta difference(s)** across 1 distinct change(s) in 1 changed surface base with an existing baseline.
_**Surface base** = one product UI state; capture keys with `@width` or live-state/popup variants are width or state captures of that base._

- [ ] **Approve all changes**

### `button.btn` · 1 element restyled

_demo-button @ 900_

![before ◀ │ ▶ after](docs/readme/live-report/crops/demo-button-900-1-composite.png)

<sub>◀ before  ·  after ▶ — demo-button @ 900</sub>

![highlighted before ◀ │ ▶ after](docs/readme/live-report/crops/demo-button-900-1-annotated.png)

<sub>🔍 magenta boxes mark each change — changed: `button.btn`</sub>

**`button.btn`**

Style:

| Property | Before | After |
| --- | --- | --- |
| `padding` | `14px 28px` | `18px 32px` |
| `border-color` | `#38d6c6` | `#f87171` |
| `background-color` | `#14b8a6` | `#dc2626` |
| `font-size` | `13px` | `16px` |
| `letter-spacing` | `1.56px` | `1.92px` |

Interactive-state changes:

| State | Property | Before → After |
| --- | --- | --- |
| `:hover` | `color` | `#5eead4` → `#fecaca` |
| `:hover` | `row-rule-color` | `#5eead4` → `#fecaca` |
| `:focus` | `outline-color` | `#5eead4` → `#fca5a5` |
| `:active` | `box-shadow` | — → `rgb(127, 29, 29) 0px 0px 0px 4px` |

---
_Tick **Approve all changes** to turn the **StyleProof** check green — write access required, one tick signs off every changed or new surface. A new push that changes styles or surfaces re-opens it._
