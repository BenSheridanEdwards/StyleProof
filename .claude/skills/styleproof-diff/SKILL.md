---
name: styleproof-diff
description: Use when diffing two StyleProof captures to certify zero visual change or read exactly what rendered differently — styleproof-diff, its base-ref inference, the two-directory form, and exit codes 0/1/2/3.
---

# StyleProof — diff & certify

One job: compare two computed-style maps and say whether the browser's rendered
styles changed, named down to the property. This is the certify gate.

## Two forms

```bash
styleproof-diff                       # cached maps: current commit vs inferred base
styleproof-diff main                  # pin the base ref
styleproof-diff <beforeDir> <afterDir>   # explicit two-directory form (design-vs-build, CI fallback)
```

With no args it restores base/head from the `styleproof-maps` store and infers
the base: `GITHUB_BASE_REF` → `branch.<name>.gh-merge-base` → `gh pr view`
(stacked PRs) → `origin/main`/`origin/master`/`main`/`master`. Add `--json` for
the structured diff (includes `compared`); `--max <n>` caps lines per surface.

## Exit codes — the gate contract

| Code | Meaning |
|---|---|
| **0** | certified — identical (`0 changed surfaces across N captured surface(s)`) |
| **1** | differences found |
| **2** | usage / capture error |
| **3** | only new surfaces present — no baseline to diff against (approval policy decides if that gates) |

## What it compares (and what it doesn't)

- Elements are keyed by **DOM structure, not class name** — a refactor that
  rewrites every `class` still lines up element-for-element.
- It reads **computed styles** (resolved longhands, pseudo-elements, layout
  boxes, motion longhands, forced `:hover`/`:focus`/`:active` deltas) — never
  source CSS. Tailwind / CSS Modules / Sass / vanilla all resolve to the same
  output.
- **Newly-added elements** report their full resting computed style, not just
  interaction deltas.
- Framework/non-visual noise (`<script>`, `<style>`, route announcers) and
  layout-equivalent auto-margins are normalized out by default.

## Validate the differ before you trust a zero

When certifying "no change," a `0` is only meaningful if the differ *can* see a
change: sanity-check that two genuinely-different surfaces report non-zero and
that the two capture files are distinct byte streams (not accidentally the same
dir). A false zero is worse than a red.

## Next

`styleproof-report` renders the human-readable before/after; `styleproof-ci-gate`
runs this inside the Action. To prove the diff covered *everything*, see
`styleproof-coverage`.
