<!-- styleproof-report -->

## 🗺️ StyleProof report

**1 change needs review**

**1 distinct change** (2 computed-style difference(s) · 3 state-delta difference(s)) in 1 changed surface base with an existing baseline.

**What changed**

- `demo-button @ 900` — **`button.btn`** background teal (`#14b8a6`) → red (`#dc2626`), padding adjusted · **`a.link`** interaction states changed: `:hover`, `:focus`, `:active`

## Changes

### `button.btn` · 1 element restyled

_demo-button @ 900_

![before ◀ │ ▶ after](docs/readme/live-report/crops/demo-button-900-4-composite.png)

<sub>◀ before · after ▶</sub>

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

### `a.link` · 1 element restyled `:hover`

_demo-button @ 900_

![base :hover ◀ │ ▶ head :hover](docs/readme/live-report/crops/demo-button-900-1-composite.png)

<sub>◀ base :hover · head :hover ▶</sub>

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

### `a.link` · 1 element restyled `:focus`

_demo-button @ 900_

![base :focus ◀ │ ▶ head :focus](docs/readme/live-report/crops/demo-button-900-2-composite.png)

<sub>◀ base :focus · head :focus ▶</sub>

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

### `a.link` · 1 element restyled `:active`

_demo-button @ 900_

![base :active ◀ │ ▶ head :active](docs/readme/live-report/crops/demo-button-900-3-composite.png)

<sub>◀ base :active · head :active ▶</sub>

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
