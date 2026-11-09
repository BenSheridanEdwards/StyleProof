## 🗺️ StyleProof report

**3 changes to review** on `index` at 1280px wide: 9 elements, 4 changed CSS rules.

### Cards

All 3 cards change padding from `16px` to `24px`. Each is now 16px taller.

<sub>Where: 3 cards on index @ 1280</sub>

<details>
<summary>Show the CSS</summary>

`article.card` · 3 elements restyled · changed rule `.card` in `/styles.css`

| Property                | Before | After  |
| ----------------------- | ------ | ------ |
| `padding` (8 longhands) | `16px` | `24px` |

</details>

### Card titles

All 3 card titles (Lamp, Chair, Rug) change text colour from dark indigo to dark red.

<sub>Where: 3 card titles on index @ 1280</sub>

<details>
<summary>Show the CSS</summary>

`h2.card-title` · 3 elements restyled · changed rule `.card-title` in `/styles.css`

| Property                                      | Before    | After     |
| --------------------------------------------- | --------- | --------- |
| `color`                                       | `#1e3c78` | `#961e3c` |
| `border-color` (8 longhands)                  | `#1e3c78` | `#961e3c` |
| `caret-color` (follows `color`)               | `#1e3c78` | `#961e3c` |
| `outline-color` (follows `color`)             | `#1e3c78` | `#961e3c` |
| `column-rule-color` (follows `color`)         | `#1e3c78` | `#961e3c` |
| `row-rule-color` (follows `color`)            | `#1e3c78` | `#961e3c` |
| `text-decoration-color` (follows `color`)     | `#1e3c78` | `#961e3c` |
| `text-emphasis-color` (follows `color`)       | `#1e3c78` | `#961e3c` |
| `-webkit-text-fill-color` (follows `color`)   | `#1e3c78` | `#961e3c` |
| `-webkit-text-stroke-color` (follows `color`) | `#1e3c78` | `#961e3c` |

</details>

### Add to basket buttons

On all 3 Add to basket buttons, the background changes from dark indigo to red when hovered, and the outline colour changes from `#faa000` to `#00a050` when focused. At rest they look the same.

<sub>Where: 3 Add to basket buttons on index @ 1280</sub>

<details>
<summary>Show the CSS</summary>

`button.btn` · 3 elements restyled · changed rules `.btn:focus-visible`, `.btn:hover` in `/styles.css`

| Property                  | Before    | After     |
| ------------------------- | --------- | --------- |
| `:hover background-color` | `#1e46aa` | `#c82828` |
| `:focus outline-color`    | `#faa000` | `#00a050` |

</details>

### 📊 [**Open the full visual report →**](report.md)
