## 🗺️ StyleProof report

**5 computed-style difference(s) · 3 state-delta difference(s)** across 1 distinct change(s) in 1 changed surface base with an existing baseline.
_**Surface base** = one product UI state; capture keys with `@width` or live-state/popup variants are width or state captures of that base._

## Element-level changes

### `button.btn` · style and size

_demo-button @ 900_

`padding` `14px 28px` → `18px 32px`<br>
`border-color` `#38d6c6` → `#f87171`<br>
`background-color` `#14b8a6` → `#dc2626`<br>
`font-size` `13px` → `16px`<br>
`letter-spacing` `1.56px` → `1.92px`

![before ◀ │ ▶ after](crops/demo-button-900-2-composite.png)

<sub>◀ before  ·  after ▶ — Save at rest</sub>

![highlighted before ◀ │ ▶ after](crops/demo-button-900-2-annotated.png)

<sub>🔍 magenta boxes mark each change — changed: `button.btn`</sub>

### `a.link` `:hover`

_demo-button @ 900 · forced state_

`:hover` `color` `#a5f3fc` → `#fca5a5`

![before ◀ │ ▶ after](crops/docs-hover-composite.png)

<sub>◀ before  ·  after ▶ — Docs :hover</sub>

### `a.link` `:focus`

_demo-button @ 900 · forced state_

`:focus` `outline-color` `#5eead4` → `#fca5a5`

![before ◀ │ ▶ after](crops/docs-focus-composite.png)

<sub>◀ before  ·  after ▶ — Docs :focus</sub>

### `a.link` `:active`

_demo-button @ 900 · forced state_

`:active` `color` `#2dd4bf` → `#f87171`

![before ◀ │ ▶ after](crops/docs-active-composite.png)

<sub>◀ before  ·  after ▶ — Docs :active</sub>
