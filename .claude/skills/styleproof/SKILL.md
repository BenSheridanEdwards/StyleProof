---
name: styleproof
description: Use when standing up StyleProof end-to-end in a repo or running it as a whole — the full workflow tying install, surfaces, baseline, CI gate, capture, diff, and coverage together, and choosing between its two modes (certify a refactor / match a design).
---

# StyleProof — the full workflow

StyleProof is a **PR gate for visual CSS changes**: it opens the app states you
declare in a real browser, records the browser's _computed_ styles, diffs head
vs base, and reports exactly which rendered styles changed. It's not a screenshot
diff — screenshots are in the report for humans; the gate compares resolved CSS,
keyed by DOM structure so a class rewrite still lines up.

This skill is the map. Each step has its own skill; follow them in order.

## Stand it up (once per repo)

1. **`styleproof-install`** — `npm i -D styleproof @playwright/test`,
   `playwright install chromium`, `npx styleproof-init` (scaffolds spec + a
   production-build Playwright config + cache-first CI workflow).
2. **`styleproof-surfaces`** — declare the states that matter (`surfaces`,
   `variants`, `liveStates`, `popups`) and the `expected`/`exclude` coverage
   guard. This is the only part you own; auto-discovery handles the inventory.
3. **`styleproof-baseline`** — `styleproof-map` captures the commit and publishes
   maps to the `styleproof-maps` store the gate diffs against.
4. **`styleproof-ci-gate`** — wire `BenSheridanEdwards/StyleProof@v4` as the PR
   gate; pick review-gate or certify mode; add the approve workflow + fork split.
5. **`styleproof-prepush`** _(optional)_ — capture locally at pre-push so CI is
   report-only.

## Use it (every PR / every check)

- **`styleproof-capture`** — one-shot capture of any URL you point at.
- **`styleproof-diff`** — the gate: 0 = certified identical, 1 = changed (or a
  blocked gate: unacknowledged inventory removal, unacknowledged failing data
  endpoint, incomplete coverage, unproven determinism), 3 = new surface.
  Validate the differ before trusting a 0.
- **`styleproof-report`** — the before/after visual review artifact.
- **`styleproof-coverage`** — `--crawl` + `--require-full-coverage` + `--setup`;
  prove no surface/state was missed (the captures can't catch an un-taken
  capture).

## Two modes — pick by intent

- **Certify a refactor** (`fail-on-diff: true`) — the job StyleProof was born
  for: prove a change touched _nothing_ visual (CSS-Modules→Tailwind, a
  design-system swap, a dependency/build bump). Zero diff is the contract; one
  drifting longhand is a regression to investigate.
- **Match a design pixel-for-pixel** (`styleproof-capture` design vs build) —
  point at the design and the build, diff, watch the number shrink to zero
  (README: _Match a design pixel-for-pixel_).

## What's automatic vs what you set

Almost everything is handled: network-aware settle, frozen clock, self-check,
record/replay, framework-noise skipping, breakpoint auto-detection. The few knobs
exist only for what StyleProof can't know about your app — chiefly
`STYLEPROOF_REPLAY_FROM` (pin head to base's data) and `liveStates`/`variants`
(app-specific states). Reach for a knob only when a skill above says to.

## The boundary to remember

StyleProof only certifies states it **reaches**. A surface nobody declared or
crawled is invisible — no base map, no head map, green having never looked. The
coverage guard (`styleproof-coverage`) is what keeps that honest.
