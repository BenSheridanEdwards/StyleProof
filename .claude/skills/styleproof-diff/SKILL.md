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
(stacked PRs) → `origin/main`/`origin/master`/`main`/`master`. `--json <file>`
writes the full structured diff (findings + coverage/determinism/inventory/
data-residue verdicts + `compared`); `--max <n>` caps lines per surface
(default 40).

## Exit codes — the gate contract

| Code  | Meaning                                                                                                                                                                                                                                                                                         |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0** | certified — identical (`0 changed surfaces across N captured surface(s)`)                                                                                                                                                                                                                       |
| **1** | reviewable diff — style/DOM/state differences, **or a blocked gate**: an unacknowledged inventory removal, an unacknowledged failing data endpoint (`dataResidue`), an incomplete coverage registry, or an unproven-determinism capture                                                         |
| **2** | usage / capture error — including a **manifest-less side** (since v4 a map-bearing dir without `styleproof-manifest.json` is refused; re-capture with current StyleProof) and a **missing map** (a manifest with zero captures, either side), refused loudly rather than mislabelled as all-new |
| **3** | only NEW surfaces present (head-side only) — no baseline for _those_ surfaces (or no base manifest at all: first adoption); approval policy decides if that gates. A surface present only on the base side is a REMOVED surface and exits **1**                                                 |

## The four verdicts behind a zero

A green is qualified by ledgers that travel with the map bundle:

- **Coverage** — the `expected` registry rides along as
  `styleproof-coverage.json`; the gate prints `✓ coverage complete`,
  `✗ INCOMPLETE` (blocks), or `⚠ not asserted` (no registry declared).
- **Determinism** — how the capture proved itself (`self-checked` / `replayed`);
  an `unproven` capture blocks, because a clean diff of two nondeterministic
  reads could just be luck.
- **Inventory** — when maps carry `inventory: true`, a nav item/route that went
  unreachable exits 1 unless acknowledged in `styleproof.inventory.json`
  (`{"<key>": "<why>"}`; path override `STYLEPROOF_INVENTORY`).
- **Data residue** — a data-boundary request that FAILED during capture means
  the fallback branch was captured, not the state its responses drive. Gating
  is the **default since v4** (`dataResidue: 'gate'`): an unacknowledged
  failing endpoint exits 1 until acknowledged in
  `styleproof.data-residue.json` (`{"<surface·endpoint>": "<why>"}`); a stale
  acknowledgement also fails. Opt down with `dataResidue: 'warn'` in the spec;
  pre-v4 bundles (no field in their ledger) never gate retroactively.

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

When certifying "no change," a `0` is only meaningful if the differ _can_ see a
change: sanity-check that two genuinely-different surfaces report non-zero and
that the two capture files are distinct byte streams (not accidentally the same
dir). A false zero is worse than a red.

## Next

`styleproof-report` renders the human-readable before/after; `styleproof-ci-gate`
runs this inside the Action. To prove the diff covered _everything_, see
`styleproof-coverage`.
