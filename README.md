# StyleProof

**Know exactly what every PR changes visually, and sign it off.** StyleProof captures the browser's _computed_ styles (not pixels), diffs your PR's HEAD against its base branch, and posts a per-change report on the PR, so a styling change never ships without someone confirming it was intended.

[![npm version](https://img.shields.io/npm/v/styleproof.svg)](https://www.npmjs.com/package/styleproof)
[![CI](https://github.com/BenSheridanEdwards/StyleProof/actions/workflows/ci.yml/badge.svg)](https://github.com/BenSheridanEdwards/StyleProof/actions)
[![license](https://img.shields.io/npm/l/styleproof.svg)](https://github.com/BenSheridanEdwards/StyleProof/blob/main/LICENSE)

## Why

Pixel-snapshot tools miss most CSS regressions: they can't force `:hover` / `:focus` / `:active`, can't see hidden or off-screen elements, can't reach between-breakpoint rules, and blur away sub-pixel drift. StyleProof reads the **computed style** of every element instead — every resolved longhand, every pseudo-element, the deltas `:hover` / `:focus` / `:active` apply (forced via CDP, no mouse), swept across each `@media` breakpoint.

## What the gate does

On every PR, StyleProof captures a `StyleMap` from the HEAD and from the base branch, diffs them, and posts a Markdown comment:

- A summary line, then **one section per distinct change**, with a side-by-side before/after cropped screenshot (both sides cropped from the same rectangle, so they line up exactly) and **plain-English bullets that tell you what to look for** (`columns: 2 → 3`, `recoloured cyan → amber`) above the exact property changes, folded under a toggle.
- An **approval checkbox per change**, driving a `StyleProof` commit status: red until every change is signed off, green when there are none.
- **New surfaces don't block.** A surface that exists only on the PR head (no baseline to diff — e.g. the bootstrap PR that first adds the capture spec, or a brand-new page) is shown with its screenshot under a `🆕 new surface` heading and an _optional_ approval box, but it never holds the status red. It becomes part of the baseline once merged.
- No committed baseline to maintain — the diff is HEAD-vs-base, so the report is _exactly what this PR changes_.

## What a report looks like

One change — the hero CTA recoloured cyan → amber — posts as a single section: a side-by-side before/after cropped screenshot, a one-line summary, then the exact property change folded under a toggle.

![A StyleProof report: the CTA button before (cyan) and after (amber), side by side](https://raw.githubusercontent.com/BenSheridanEdwards/StyleProof/main/docs/demo-composite.png)

As it renders in the PR comment (a plain-English bullet first — naming the theme token and showing the hex with a live colour swatch — then the exact table inside the toggle):

```text
### `a.btn-solid` · 1 element restyled
_landing @ 1280_

- **`a.btn-solid`** — background `brand-cyan` (`#5fcadb`) → `brand-amber` (`#f59e0b`)

▾ Show the property change
   | Property         | Before    | After     |
   | background-color | #5fcadb   | #f59e0b   |
```

## Works with any styling system

StyleProof reads the browser's **computed styles** — the values it actually resolves — never your source CSS. Tailwind, CSS Modules, styled-components, Sass, vanilla CSS, inline styles: all produce the same computed output, and that's what it diffs. Elements are keyed by **DOM structure, not class name**, so a refactor that rewrites every `class` still lines up element-for-element.

## Certify a refactor

The same engine has a second mode that proves a change touched _nothing_ visual: with `fail-on-diff: true`, any difference at all fails the job. It's the job StyleProof was born for — certifying a CSS-to-Tailwind migration rendered byte-for-byte identical. Reach for it on any change whose whole promise is "the output is unchanged": a utility-class migration, a design-system swap, a dependency or build-tooling bump. Zero diff is the contract; one drifting longhand is a regression to investigate, not a change to approve.

## Install

```bash
npm install -D styleproof @playwright/test
npx playwright install chromium
```

Requires **Node ≥ 18** (ESM), **`@playwright/test` ≥ 1.40** (peer dep). Forced states are Chromium-only.

## Quickstart

**1. Scaffold the capture spec** (`npx styleproof-init` writes `e2e/styleproof.spec.ts`), then describe your surfaces:

```ts
import { defineStyleMapCapture } from 'styleproof';

defineStyleMapCapture({
  dir: process.env.STYLEMAP_DIR, // inert until set, so it lives safely beside other tests
  surfaces: [
    {
      key: 'landing',
      go: async (page) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        await page.evaluate(() => document.fonts.ready);
      },
      widths: [1280, 768, 390], // one viewport per @media band
    },
  ],
});
```

**2. Wire CI to capture base and head, then hand both to the Action:**

```yaml
# .github/workflows/styleproof.yml
name: StyleProof
on: pull_request

jobs:
  styleproof:
    runs-on: ubuntu-latest
    permissions:
      contents: write # push the report branch
      pull-requests: write # post/update the comment
      statuses: write # set the StyleProof status
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # need the base branch too

      # capture the base branch
      - run: git checkout ${{ github.event.pull_request.base.sha }}
      - run: npm ci && npm run build && (npm run serve &) # your framework's build + serve
      - run: npx wait-on http://localhost:3000
      - run: STYLEMAP_DIR=base npx playwright test e2e/styleproof.spec.ts

      # capture the PR head — replay the base's recorded data so the diff is
      # code, not live-data drift (see "Deterministic by default" below)
      - run: git checkout ${{ github.event.pull_request.head.sha }}
      - run: npm ci && npm run build && (npm run serve &)
      - run: npx wait-on http://localhost:3000
      - run: STYLEMAP_DIR=head STYLEPROOF_REPLAY_FROM=__stylemaps__/base npx playwright test e2e/styleproof.spec.ts

      # report + gate
      - uses: BenSheridanEdwards/StyleProof@v1
        with:
          baseline-dir: __stylemaps__/base # captures land under baseDir (default __stylemaps__)
          fresh-dir: __stylemaps__/head
          require-approval: true # review-gate mode (omit / use fail-on-diff: true to certify)
```

**3. Copy [`example/styleproof-approve.yml`](https://github.com/BenSheridanEdwards/StyleProof/blob/main/example/styleproof-approve.yml) to `.github/workflows/` on your default branch** — GitHub only runs `issue_comment` workflows from there, so the checkboxes do nothing until it's merged.

**4. Require the `StyleProof` status** in branch protection. Now an unsigned visual change can't merge.

## Forks and Dependabot

The single-workflow setup above runs the whole gate in one `pull_request` job — which needs a **write** token to push the report branch, post the comment, and set the `StyleProof` status. That's fine for same-repo PRs, but **fork and Dependabot PRs run with a read-only `GITHUB_TOKEN`** (GitHub's security default for untrusted PRs). So the job can't post the status — and a required `StyleProof` check then sits `pending` forever, blocking the PR even though a dependency or fork change usually touches no UI at all.

Fix it by splitting capture from reporting, the way the approve workflow is already split out:

- **[`example/styleproof-capture.yml`](example/styleproof-capture.yml)** runs `on: pull_request` with a **read-only** token and no secrets — safe to run untrusted PR code. It only builds, captures the style maps, and uploads them as an artifact.
- **[`example/styleproof-report.yml`](example/styleproof-report.yml)** runs `on: workflow_run` (after capture finishes) from your **default branch** with a write token. It downloads the artifact and does the diff, comment, and status — but **never checks out or runs the PR's code**, only the trusted style-map data.

That last point is why this works where `pull_request_target` does not: StyleProof builds and serves the PR's head, so running it under `pull_request_target` would hand a write token (and your secrets) to untrusted code — the exact supply-chain risk StyleProof exists to help you catch. The `workflow_run` split keeps the privileged half away from PR code entirely.

**Where the PR identity comes from.** The report stage comments on the PR and sets the `StyleProof` status against a specific PR number and head commit, so those values have to be trustworthy. It takes them from the trusted `workflow_run` event — `head_sha`, then the event's `pull_requests`, with a commit→PR lookup against that **same trusted head SHA** for fork PRs (whose association the event doesn't carry directly) — and **never** from the downloaded artifact. The artifact is produced by the untrusted capture job, so treating anything in it as identity would let a malicious PR point the privileged comment and status at a victim PR or an arbitrary commit (a confused-deputy attack). The artifact therefore carries only the style-map captures, consumed purely as diff input.

Copy both `capture` and `report` files to `.github/workflows/` (the `report` one must be on your default branch, like `styleproof-approve.yml`), then require the `StyleProof` status as in step 4. The single-job `styleproof.yml` above remains fine for repos that never see fork or bot PRs.

**Deterministic by default — no fixtures required.** A style diff only means something if both sides saw the same inputs; otherwise live-data drift (a backend blip, a `5m ago` timestamp, a status chip that flips) reads as a style change on a PR that touched no CSS. StyleProof handles this for you:

- **Record / replay.** The base capture records each surface's data responses (anything matching `**/api/**`) to a HAR; the head capture replays them, so the head renders _its_ code against the _base's_ data — the app's own JS/CSS still load live. Backend down during a run? Both sides replay the same recording, so there's no phantom diff. Point the head capture at the base's recording with `STYLEPROOF_REPLAY_FROM=<base dir>` (see the CI step above); tune the data boundary with `STYLEPROOF_REPLAY_URL` / `replayUrl` if your API isn't under `/api`.
- **Frozen clock.** `Date.now()` / `new Date()` are pinned to a fixed instant, so time-derived styling (`stale > 1h → red`) can't drift. Timers keep running, so settling still works.
- **Self-check** (`STYLEPROOF_SELFCHECK=1`). Captures each surface twice and fails if they differ — a replay gap or unseeded randomness surfaces as a clear _"non-deterministic capture"_ error, never as a phantom change on an unrelated PR.
- **Framework noise is skipped by default.** Non-visual and framework-injected elements never count as a change — `<meta>`/`<title>`/`<script>`/`<style>`/… (which Next.js streams into the body then hoists) and live regions like Next's `next-route-announcer`. A real stylesheet change still shows up in the affected elements' computed styles, not in the `<style>` tag. Add your own selectors with `ignore` — they extend this default, they don't replace it.

> Replay covers data the page _fetches_. If your app **server-renders** differently per environment (SSR feature flags, locale), still capture both sides with the same server env so the rendered HTML matches.

**Live pages just work.** Before each capture, StyleProof settles the page — it waits until the computed-style map stops changing, so async content (a fetch, an SSE/WebSocket stream backfilling a grid) is captured loaded, not mid-load. Anything still moving on its own after that is detected as a live region and excluded from the diff, so a stream or ticker never reads as a change — no manual `ignore` needed. Disable or tune with `captureStyleMap(page, { stabilize: false })` / `{ stabilize: { quietFor, timeout } }`.

## Reference

**Action `BenSheridanEdwards/StyleProof@v1`** — key inputs:

| Input              | Default      | Purpose                                                                    |
| ------------------ | ------------ | -------------------------------------------------------------------------- |
| `baseline-dir`     | _required_   | Base-branch captures.                                                      |
| `fresh-dir`        | _required_   | PR-head captures to compare.                                               |
| `require-approval` | `false`      | Review-gate mode: set the `StyleProof` status instead of failing.          |
| `fail-on-diff`     | `true`       | Certify mode: fail on any diff. Ignored when `require-approval` is true.   |
| `status-context`   | `StyleProof` | Commit-status name. Must match the approve workflow and branch protection. |

Outputs: `changed` (`"true"` when anything changed), `report-url`. Other inputs (`report-branch`, `inline-images`, `github-token`) have sensible defaults — see [`action.yml`](https://github.com/BenSheridanEdwards/StyleProof/blob/main/action.yml).

**Capture spec `defineStyleMapCapture({ surfaces, … })`** — determinism is on by default; you rarely set more than `surfaces` and `dir`:

| Option        | Default                     | Purpose                                                                                                          |
| ------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `surfaces`    | _required_                  | Page states to certify — each `{ key, go, widths, ignore?, height? }`. `go(page)` drives to a settled state.     |
| `dir`         | `STYLEMAP_DIR`              | Output label (`base`/`head`); the spec is **inert until set**, so it sits safely beside your other specs.        |
| `replayFrom`  | `STYLEPROOF_REPLAY_FROM`    | Baseline dir whose recorded responses to replay. Unset → this run **records** its HAR for the comparison to use. |
| `replayUrl`   | `**/api/**` (`…REPLAY_URL`) | URL glob for the data boundary to record/replay; everything else (JS/CSS/fonts) loads live so the code runs.     |
| `freezeClock` | `true`                      | Pin `Date.now()`/`new Date()` so time-derived styling can't drift; timers keep running so settling still works.  |
| `clockTime`   | `2025-01-01T00:00:00Z`      | The frozen instant.                                                                                              |
| `selfCheck`   | `STYLEPROOF_SELFCHECK=1`    | Capture each surface twice and fail on any difference — proves the capture is deterministic.                     |
| `screenshots` | `true`                      | Save full-page screenshots for the report's before/after crops.                                                  |
| `baseDir`     | `__stylemaps__`             | Output root directory.                                                                                           |

Non-visual and framework-injected elements (`<meta>`/`<title>`/`<script>`/`<style>`/… and `next-route-announcer`) are skipped automatically; a surface's `ignore` adds to that default, it doesn't replace it.

**Capture env vars** (wire CI without editing the spec):

| Env                      | Purpose                                                                       |
| ------------------------ | ----------------------------------------------------------------------------- |
| `STYLEMAP_DIR`           | Output label; the capture is skipped entirely when unset.                     |
| `STYLEPROOF_REPLAY_FROM` | Baseline dir to replay recorded data from — set this on the **head** capture. |
| `STYLEPROOF_REPLAY_URL`  | Override the `**/api/**` data-boundary glob.                                  |
| `STYLEPROOF_SELFCHECK`   | `1` to capture each surface twice and fail if the two differ.                 |

**CLIs** (every flag accepts `--flag value` and `--flag=value`; `--help` lists all):

- `styleproof-init` — scaffold the capture spec (and a starter `playwright.config.ts` if none exists).
- `styleproof-diff <beforeDir> <afterDir>` — the certify gate; exits `1` on any difference.
- `styleproof-report <beforeDir> <afterDir> --out <dir>` — render the diff to a Markdown report with before/after crops.

A programmatic API (`captureStyleMap`, `diffStyleMaps`, `generateStyleMapReport`, …) is also exported. For the capture internals, the approve-workflow trust model, and how to contribute, see [CONTRIBUTING](https://github.com/BenSheridanEdwards/StyleProof/blob/main/CONTRIBUTING.md) and the [`example/`](https://github.com/BenSheridanEdwards/StyleProof/tree/main/example) workflows.

## License

MIT © Ben Sheridan-Edwards
