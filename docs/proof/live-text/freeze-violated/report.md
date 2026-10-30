## 🗺️ StyleProof report


⚠ **Live/age freeze violated** — fail closed (`CERTIFICATION_FAILED`). A freeze was declared but captured age/clock text still drifted. This is not a stylesheet regression and cannot be approved as one. Fixture timestamps so ages use the frozen clock, or declare `liveText` without `freeze` so age-only drift stays advisory.

- `dashboard@1280`: `open 102.1d` → `open 103.1d`

_styleproof: live/age text drifted after a freeze was declared — captured text is not pinned. Fixture timestamps so ages use the frozen clock, or declare liveText without freeze so age-only drift stays advisory. Drift: `open 102.1d` → `open 103.1d` on dashboard@1280._

⚠️ **Product-state comparison** — unproven on 1 undeclared legacy pair(s). Legacy compatibility preserves the existing visual-review path, but this is not proof that both captures reached the same product state.

✗ Live/age freeze violated — captured age/clock text drifted after a freeze was declared. Fail closed (`CERTIFICATION_FAILED`); not a style review.

---

## 📝 Content and structure changes (advisory)

_1 content/structure change(s). **Advisory only** — content and DOM structure are not part of the computed-style certification and do not affect the check. Surfaced so copy, element, and reflow changes are visible when content comparison is enabled. Live/age/clock text (relative ages, clocks) is labeled below so it cannot be mistaken for a product style regression._

### `dashboard@1280` · 1 content/structure change(s)

**`span.age.age`**

- **live/age/clock text** (advisory — clock or relative-age data, not a stylesheet edit)
- before: `open 102.1d`
- after: `open 103.1d`

![before ◀ │ ▶ after](crops/dashboard-1280-content-1-composite.png)

<sub>◀ before  ·  after ▶ — dashboard@1280</sub>

![highlighted before ◀ │ ▶ after](crops/dashboard-1280-content-1-annotated.png)

<sub>🔍 magenta boxes mark the changed content</sub>
