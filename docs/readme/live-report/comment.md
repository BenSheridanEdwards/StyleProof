<!-- styleproof-report -->

## 🗺️ StyleProof report

**1 change needs review**

**2 computed-style difference(s) · 3 state-delta difference(s)** across 1 distinct change(s) in 1 changed surface base with an existing baseline.

## Changes

### **Btn** `button.btn` · 1 element restyled

_demo-button @ 900_

`padding` `14px 28px` → `18px 32px`<br>
`background-color` `#14b8a6` → `#dc2626`

![before ◀ │ ▶ after](docs/readme/live-report/crops/demo-button-900-4-composite.png)

<sub>◀ before · after ▶ — demo-button @ 900</sub>

<details>
<summary>Show highlight overlay</summary>

![highlighted before ◀ │ ▶ after](docs/readme/live-report/crops/demo-button-900-4-annotated.png)

<sub>🔍 magenta boxes mark each change — changed: `button.btn`</sub>

</details>

**Btn** `button.btn`

Style:

| Property           | Before      | After       |
| ------------------ | ----------- | ----------- |
| `padding`          | `14px 28px` | `18px 32px` |
| `background-color` | `#14b8a6`   | `#dc2626`   |

### **Link** `a.link` · 1 element restyled `:hover`

_demo-button @ 900_

_Both sides are :hover. Left is the old :hover. Right is the new :hover._

`:hover` `color` `#a5f3fc` → `#fca5a5`

![base :hover ◀ │ ▶ head :hover](docs/readme/live-report/crops/demo-button-900-1-composite.png)

<sub>◀ base :hover · head :hover ▶ — both sides are :hover</sub>

<details>
<summary>Show highlight overlay</summary>

![highlighted base :hover ◀ │ ▶ head :hover](docs/readme/live-report/crops/demo-button-900-1-annotated.png)

<sub>🔍 magenta boxes mark each change — changed: `a.link`</sub>

</details>

**Link** `a.link`

Interactive-state changes:

| State    | Property                                       | Before → After        |
| -------- | ---------------------------------------------- | --------------------- |
| `:hover` | `color`                                        | `#a5f3fc` → `#fca5a5` |
| `:hover` | ↳ `caret-color` _(currentColor)_               | `#a5f3fc` → `#fca5a5` |
| `:hover` | ↳ `outline-color` _(currentColor)_             | `#a5f3fc` → `#fca5a5` |
| `:hover` | ↳ `column-rule-color` _(currentColor)_         | `#a5f3fc` → `#fca5a5` |
| `:hover` | ↳ `row-rule-color` _(currentColor)_            | `#a5f3fc` → `#fca5a5` |
| `:hover` | ↳ `text-decoration-color` _(currentColor)_     | `#a5f3fc` → `#fca5a5` |
| `:hover` | ↳ `text-emphasis-color` _(currentColor)_       | `#a5f3fc` → `#fca5a5` |
| `:hover` | ↳ `-webkit-text-fill-color` _(currentColor)_   | `#a5f3fc` → `#fca5a5` |
| `:hover` | ↳ `-webkit-text-stroke-color` _(currentColor)_ | `#a5f3fc` → `#fca5a5` |

### **Link** `a.link` · 1 element restyled `:focus`

_demo-button @ 900_

_Both sides are :focus. Left is the old :focus. Right is the new :focus._

`:focus` `outline-color` `#5eead4` → `#fca5a5`

![base :focus ◀ │ ▶ head :focus](docs/readme/live-report/crops/demo-button-900-2-composite.png)

<sub>◀ base :focus · head :focus ▶ — both sides are :focus</sub>

<details>
<summary>Show highlight overlay</summary>

![highlighted base :focus ◀ │ ▶ head :focus](docs/readme/live-report/crops/demo-button-900-2-annotated.png)

<sub>🔍 magenta boxes mark each change — changed: `a.link`</sub>

</details>

**Link** `a.link`

Interactive-state changes:

| State    | Property        | Before → After        |
| -------- | --------------- | --------------------- |
| `:focus` | `outline-color` | `#5eead4` → `#fca5a5` |

### **Link** `a.link` · 1 element restyled `:active`

_demo-button @ 900_

_Both sides are :active. Left is the old :active. Right is the new :active._

`:active` `color` `#2dd4bf` → `#f87171`

![base :active ◀ │ ▶ head :active](docs/readme/live-report/crops/demo-button-900-3-composite.png)

<sub>◀ base :active · head :active ▶ — both sides are :active</sub>

<details>
<summary>Show highlight overlay</summary>

![highlighted base :active ◀ │ ▶ head :active](docs/readme/live-report/crops/demo-button-900-3-annotated.png)

<sub>🔍 magenta boxes mark each change — changed: `a.link`</sub>

</details>

**Link** `a.link`

Interactive-state changes:

| State     | Property                                       | Before → After        |
| --------- | ---------------------------------------------- | --------------------- |
| `:active` | `color`                                        | `#2dd4bf` → `#f87171` |
| `:active` | ↳ `caret-color` _(currentColor)_               | `#2dd4bf` → `#f87171` |
| `:active` | ↳ `outline-color` _(currentColor)_             | `#2dd4bf` → `#f87171` |
| `:active` | ↳ `column-rule-color` _(currentColor)_         | `#2dd4bf` → `#f87171` |
| `:active` | ↳ `row-rule-color` _(currentColor)_            | `#2dd4bf` → `#f87171` |
| `:active` | ↳ `text-decoration-color` _(currentColor)_     | `#2dd4bf` → `#f87171` |
| `:active` | ↳ `text-emphasis-color` _(currentColor)_       | `#2dd4bf` → `#f87171` |
| `:active` | ↳ `-webkit-text-fill-color` _(currentColor)_   | `#2dd4bf` → `#f87171` |
| `:active` | ↳ `-webkit-text-stroke-color` _(currentColor)_ | `#2dd4bf` → `#f87171` |

_Nothing else — no other element or inventory changes in this compare._

- [ ] **Approve all changes**

---

_Tick **Approve all changes** to turn the **StyleProof** check green — write access required, and not the pull request author. One tick signs it off. A new push that changes styles or surfaces re-opens it._
