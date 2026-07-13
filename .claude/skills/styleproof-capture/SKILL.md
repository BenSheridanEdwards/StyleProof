---
name: styleproof-capture
description: Use when capturing the computed-style map of any URL you point at — a design mockup, a deployed page, a static export — for a one-shot diff, with styleproof-capture and its widths/wait/ignore flags. The ad-hoc counterpart to the spec-driven styleproof-map.
---

# StyleProof — capture any URL (one-shot)

One job: record the browser's computed styles for a page you just point at, with
no spec. `styleproof-capture` writes the same map shape any capture writes
(`<dir>/<key>@<width>.json.gz` + `.png`), so `styleproof-diff` can compare it
against anything. Use it for **matching a design** or capturing a third-party
page you don't own a spec for.

(For your own app's surfaces with the coverage guard + map store + record/replay,
use the spec-driven `styleproof-map` — the `styleproof-baseline` skill.)

## Point, capture, diff

```bash
styleproof-capture https://example.com/pricing --key pricing --widths 1440,1024,768 --out design
styleproof-diff design .styleproof/maps/current   # design vs your build
```

Flags:

- `--key <name>` — surface key / capture file prefix (default `page`).
- `--widths 1440,1024,768` — **omit** to auto-detect the page's own `@media`
  bands; pin them for a page with a cross-origin sheet (detection reads every
  sheet and fails loudly rather than guess).
- `--wait <selector>` — hold until the intended state is on screen.
- `--ignore <selector>` — skip a live region.
- `--out <dir>` — output directory.
- `--no-screenshots` — maps only (faster; no report crops).

## The one rule that makes "identical" mean something

**Capture both sides in the same browser build + fonts.** Computed styles resolve
differently across Chromium versions and installed fonts; that's the yardstick
"identical" is measured against. Same box, same browser, both captures — the
full same-environment rule is the `styleproof-baseline` skill's.

## Beyond the landing state

A single capture sees only what's on screen at load. To map what's behind clicks
(modals, drawers, tabs), data states (loading/error), or input gates (login), use
the crawler and setup steps — the `styleproof-coverage` skill (`--crawl`,
`--setup`, data-states).

## Next

`styleproof-diff` to compare; `styleproof-report` for the visual before/after;
the README's _Match a design pixel-for-pixel_ section is the full design→build
flow.
