## 🗺️ StyleProof report

**3 changes to review** on `index` at 1280px wide: 9 elements, 4 changed CSS rules.

### Cards

All 3 cards change padding from `16px` to `24px`. Each is now 16px taller.

<img src="https://github.com/BenSheridanEdwards/StyleProof/blob/feat/report-visual-first/docs/proof/report-visual-first/crops/index-1280-1-where.png?raw=1" width="320" alt="Where on index @ 1280: 3 cards highlighted"><br><sub>Where: 3 cards on index @ 1280</sub>

| Before                                                                                                                                                                                                 | After                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <img src="https://github.com/BenSheridanEdwards/StyleProof/blob/feat/report-visual-first/docs/proof/report-visual-first/crops/index-1280-1-before.png?raw=1" width="340" alt="Before: the first card"> | <img src="https://github.com/BenSheridanEdwards/StyleProof/blob/feat/report-visual-first/docs/proof/report-visual-first/crops/index-1280-1-after.png?raw=1" width="340" alt="After: the first card"> |

<details>
<summary>Show the CSS</summary>

`article.card` · 3 elements restyled · changed rule `.card` in `/styles.css`

| Property                | Before | After  |
| ----------------------- | ------ | ------ |
| `padding` (8 longhands) | `16px` | `24px` |

</details>

### Card titles

All 3 card titles (Lamp, Chair, Rug) change text colour from dark indigo to dark red.

<img src="https://github.com/BenSheridanEdwards/StyleProof/blob/feat/report-visual-first/docs/proof/report-visual-first/crops/index-1280-2-where.png?raw=1" width="320" alt="Where on index @ 1280: 3 card titles highlighted"><br><sub>Where: 3 card titles on index @ 1280</sub>

| Before                                                                                                                                                                                                       | After                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <img src="https://github.com/BenSheridanEdwards/StyleProof/blob/feat/report-visual-first/docs/proof/report-visual-first/crops/index-1280-2-before.png?raw=1" width="340" alt="Before: the first card title"> | <img src="https://github.com/BenSheridanEdwards/StyleProof/blob/feat/report-visual-first/docs/proof/report-visual-first/crops/index-1280-2-after.png?raw=1" width="340" alt="After: the first card title"> |

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

<img src="https://github.com/BenSheridanEdwards/StyleProof/blob/feat/report-visual-first/docs/proof/report-visual-first/crops/index-1280-4-where.png?raw=1" width="320" alt="Where on index @ 1280: 3 Add to basket buttons highlighted"><br><sub>Where: 3 Add to basket buttons on index @ 1280</sub>

**While hovered**

| Before                                                                                                                                                                                                                               | After                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <img src="https://github.com/BenSheridanEdwards/StyleProof/blob/feat/report-visual-first/docs/proof/report-visual-first/crops/index-1280-3-before.png?raw=1" width="340" alt="Before: the first Add to basket button while hovered"> | <img src="https://github.com/BenSheridanEdwards/StyleProof/blob/feat/report-visual-first/docs/proof/report-visual-first/crops/index-1280-3-after.png?raw=1" width="340" alt="After: the first Add to basket button while hovered"> |

**While focused**

| Before                                                                                                                                                                                                                               | After                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <img src="https://github.com/BenSheridanEdwards/StyleProof/blob/feat/report-visual-first/docs/proof/report-visual-first/crops/index-1280-4-before.png?raw=1" width="340" alt="Before: the first Add to basket button while focused"> | <img src="https://github.com/BenSheridanEdwards/StyleProof/blob/feat/report-visual-first/docs/proof/report-visual-first/crops/index-1280-4-after.png?raw=1" width="340" alt="After: the first Add to basket button while focused"> |

<details>
<summary>Show the CSS</summary>

`button.btn` · 3 elements restyled · changed rules `.btn:focus-visible`, `.btn:hover` in `/styles.css`

**Btn** `button.btn`

| Property                  | Before    | After     |
| ------------------------- | --------- | --------- |
| `:hover background-color` | `#1e46aa` | `#c82828` |
| `:focus outline-color`    | `#faa000` | `#00a050` |

</details>

### 📊 [**Open the full visual report →**](report.md)
