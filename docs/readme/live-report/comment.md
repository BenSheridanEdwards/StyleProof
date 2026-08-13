<!-- styleproof-report -->

## 🗺️ StyleProof report

**2 computed-style difference(s) · 3 state-delta difference(s)** across 1 distinct change(s) in 1 changed surface base with an existing baseline.
_**Surface base** = one product UI state; capture keys with `@width` or live-state/popup variants are width or state captures of that base._

## Element-level changes

### `button.btn` · 1 element restyled

_demo-button @ 900_

`padding` `14px 28px` → `18px 32px`<br>
`background-color` `#14b8a6` → `#dc2626`

![before ◀ │ ▶ after](docs/readme/live-report/crops/demo-button-900-4-composite.png)

<sub>◀ before · after ▶ — demo-button @ 900</sub>

![highlighted before ◀ │ ▶ after](docs/readme/live-report/crops/demo-button-900-4-annotated.png)

<sub>🔍 magenta boxes mark each change — changed: `button.btn`</sub>

**`button.btn`**

Style:

| Property           | Before      | After       |
| ------------------ | ----------- | ----------- |
| `padding`          | `14px 28px` | `18px 32px` |
| `background-color` | `#14b8a6`   | `#dc2626`   |

### `a.link` · 1 element restyled `:hover`

_demo-button @ 900_

_Both sides are :hover. Left is the old :hover. Right is the new :hover._

`:hover` `color` `#a5f3fc` → `#fca5a5`

![base :hover ◀ │ ▶ head :hover](docs/readme/live-report/crops/demo-button-900-1-composite.png)

<sub>◀ base :hover · head :hover ▶ — both sides are :hover</sub>

![highlighted base :hover ◀ │ ▶ head :hover](docs/readme/live-report/crops/demo-button-900-1-annotated.png)

<sub>🔍 magenta boxes mark each change — changed: `a.link`</sub>

**`a.link`**

Interactive-state changes:

| State    | Property | Before → After        |
| -------- | -------- | --------------------- |
| `:hover` | `color`  | `#a5f3fc` → `#fca5a5` |

### `a.link` · 1 element restyled `:focus`

_demo-button @ 900_

_Both sides are :focus. Left is the old :focus. Right is the new :focus._

`:focus` `outline-color` `#5eead4` → `#fca5a5`

![base :focus ◀ │ ▶ head :focus](docs/readme/live-report/crops/demo-button-900-2-composite.png)

<sub>◀ base :focus · head :focus ▶ — both sides are :focus</sub>

![highlighted base :focus ◀ │ ▶ head :focus](docs/readme/live-report/crops/demo-button-900-2-annotated.png)

<sub>🔍 magenta boxes mark each change — changed: `a.link`</sub>

**`a.link`**

Interactive-state changes:

| State    | Property        | Before → After        |
| -------- | --------------- | --------------------- |
| `:focus` | `outline-color` | `#5eead4` → `#fca5a5` |

### `a.link` · 1 element restyled `:active`

_demo-button @ 900_

_Both sides are :active. Left is the old :active. Right is the new :active._

`:active` `color` `#2dd4bf` → `#f87171`

![base :active ◀ │ ▶ head :active](docs/readme/live-report/crops/demo-button-900-3-composite.png)

<sub>◀ base :active · head :active ▶ — both sides are :active</sub>

![highlighted base :active ◀ │ ▶ head :active](docs/readme/live-report/crops/demo-button-900-3-annotated.png)

<sub>🔍 magenta boxes mark each change — changed: `a.link`</sub>

**`a.link`**

Interactive-state changes:

| State     | Property | Before → After        |
| --------- | -------- | --------------------- |
| `:active` | `color`  | `#2dd4bf` → `#f87171` |

- [ ] **Approve all changes**

---

_Tick **Approve all changes** to turn the **StyleProof** check green — write access required, one tick signs it off. A new push that changes styles or surfaces re-opens it._
