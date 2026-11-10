<!-- styleproof-report -->

## 🗺️ StyleProof report

**2 changes to review** on `demo-button` at 900px wide: 2 elements.

### Save button

The Save button changes padding from `14px 28px` to `18px 32px` and background from teal to red. It is now 8px taller and 8px wider.

<img src="docs/readme/live-report/crops/demo-button-900-4-where.png" width="320" alt="Where on demo-button @ 900: 1 Save button highlighted"><br><sub>Where: 1 Save button on demo-button @ 900</sub>

| Before                                                                                                           | After                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| <img src="docs/readme/live-report/crops/demo-button-900-4-before.png" width="340" alt="Before: the Save button"> | <img src="docs/readme/live-report/crops/demo-button-900-4-after.png" width="340" alt="After: the Save button"> |

<details>
<summary>Show the CSS</summary>

`button.btn` · 1 element restyled

| Property                | Before      | After       |
| ----------------------- | ----------- | ----------- |
| `padding` (8 longhands) | `14px 28px` | `18px 32px` |
| `background-color`      | `#14b8a6`   | `#dc2626`   |

</details>

### Docs link

On the Docs link, the text colour changes from `#a5f3fc` to `#fca5a5` when hovered, the outline colour changes from `#5eead4` to `#fca5a5` when focused, and the text colour changes from `#2dd4bf` to `#f87171` when pressed. At rest it looks the same.

<img src="docs/readme/live-report/crops/demo-button-900-3-where.png" width="320" alt="Where on demo-button @ 900: 1 Docs link highlighted"><br><sub>Where: 1 Docs link on demo-button @ 900</sub>

**While hovered**

| Before                                                                                                                       | After                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| <img src="docs/readme/live-report/crops/demo-button-900-1-before.png" width="340" alt="Before: the Docs link while hovered"> | <img src="docs/readme/live-report/crops/demo-button-900-1-after.png" width="340" alt="After: the Docs link while hovered"> |

**While focused**

| Before                                                                                                                       | After                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| <img src="docs/readme/live-report/crops/demo-button-900-2-before.png" width="340" alt="Before: the Docs link while focused"> | <img src="docs/readme/live-report/crops/demo-button-900-2-after.png" width="340" alt="After: the Docs link while focused"> |

**While pressed**

| Before                                                                                                                       | After                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| <img src="docs/readme/live-report/crops/demo-button-900-3-before.png" width="340" alt="Before: the Docs link while pressed"> | <img src="docs/readme/live-report/crops/demo-button-900-3-after.png" width="340" alt="After: the Docs link while pressed"> |

<details>
<summary>Show the CSS</summary>

`a.link` · 1 element restyled

**Link** `a.link`

Interactive-state changes:

| State     | Property                                       | Before → After        |
| --------- | ---------------------------------------------- | --------------------- |
| `:hover`  | `color`                                        | `#a5f3fc` → `#fca5a5` |
| `:hover`  | ↳ `caret-color` _(currentColor)_               | `#a5f3fc` → `#fca5a5` |
| `:hover`  | ↳ `outline-color` _(currentColor)_             | `#a5f3fc` → `#fca5a5` |
| `:hover`  | ↳ `column-rule-color` _(currentColor)_         | `#a5f3fc` → `#fca5a5` |
| `:hover`  | ↳ `row-rule-color` _(currentColor)_            | `#a5f3fc` → `#fca5a5` |
| `:hover`  | ↳ `text-decoration-color` _(currentColor)_     | `#a5f3fc` → `#fca5a5` |
| `:hover`  | ↳ `text-emphasis-color` _(currentColor)_       | `#a5f3fc` → `#fca5a5` |
| `:hover`  | ↳ `-webkit-text-fill-color` _(currentColor)_   | `#a5f3fc` → `#fca5a5` |
| `:hover`  | ↳ `-webkit-text-stroke-color` _(currentColor)_ | `#a5f3fc` → `#fca5a5` |
| `:focus`  | `outline-color`                                | `#5eead4` → `#fca5a5` |
| `:active` | `color`                                        | `#2dd4bf` → `#f87171` |
| `:active` | ↳ `caret-color` _(currentColor)_               | `#2dd4bf` → `#f87171` |
| `:active` | ↳ `outline-color` _(currentColor)_             | `#2dd4bf` → `#f87171` |
| `:active` | ↳ `column-rule-color` _(currentColor)_         | `#2dd4bf` → `#f87171` |
| `:active` | ↳ `row-rule-color` _(currentColor)_            | `#2dd4bf` → `#f87171` |
| `:active` | ↳ `text-decoration-color` _(currentColor)_     | `#2dd4bf` → `#f87171` |
| `:active` | ↳ `text-emphasis-color` _(currentColor)_       | `#2dd4bf` → `#f87171` |
| `:active` | ↳ `-webkit-text-fill-color` _(currentColor)_   | `#2dd4bf` → `#f87171` |
| `:active` | ↳ `-webkit-text-stroke-color` _(currentColor)_ | `#2dd4bf` → `#f87171` |

</details>

- [ ] **Approve all changes**

### 📊 [**Open the full visual report →**](docs/readme/live-report/report.md)

---

_Tick **Approve all changes** to turn the **StyleProof** check green — write access required, and not the pull request author. One tick signs it off. A new push that changes styles or surfaces re-opens it._
