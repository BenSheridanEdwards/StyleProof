# StyleProof

**Know exactly what every PR changes visually, and sign it off.** StyleProof captures the browser's _computed_ styles (not pixels), diffs your PR's HEAD against its base branch, and posts a per-change report on the PR, so a styling change never ships without someone confirming it was intended.

[![npm version](https://img.shields.io/npm/v/styleproof.svg)](https://www.npmjs.com/package/styleproof)
[![CI](https://github.com/BenSheridanEdwards/styleproof/actions/workflows/ci.yml/badge.svg)](https://github.com/BenSheridanEdwards/styleproof/actions)
[![license](https://img.shields.io/npm/l/styleproof.svg)](https://github.com/BenSheridanEdwards/styleproof/blob/main/LICENSE)

## Why

Pixel-snapshot tools miss most CSS regressions: they can't force `:hover` / `:focus` / `:active`, can't see hidden or off-screen elements, can't reach between-breakpoint rules, and blur away sub-pixel drift. StyleProof reads the **computed style** of every element instead — every resolved longhand, every pseudo-element, the deltas `:hover` / `:focus` / `:active` apply (forced via CDP, no mouse), swept across each `@media` breakpoint.

## What the gate does

On every PR, StyleProof captures a `StyleMap` from the HEAD and from the base branch, diffs them, and posts a Markdown comment:

- A summary line, then **one section per distinct change**, with a side-by-side before/after cropped screenshot and the property changes folded under a toggle.
- An **approval checkbox per change**, driving a `StyleProof` commit status: red until every change is signed off, green when there are none.
- **New surfaces don't block.** A surface that exists only on the PR head (no baseline to diff — e.g. the bootstrap PR that first adds the capture spec, or a brand-new page) is shown with its screenshot under a `🆕 new surface` heading and an _optional_ approval box, but it never holds the status red. It becomes part of the baseline once merged.
- No committed baseline to maintain — the diff is HEAD-vs-base, so the report is _exactly what this PR changes_.

## What a report looks like

One change — the hero CTA recoloured cyan → amber — posts as a single section: a side-by-side before/after cropped screenshot, a one-line summary, then the exact property change folded under a toggle.

![A StyleProof report: the CTA button before (cyan) and after (amber), side by side](docs/demo-composite.png)

As it renders in the PR comment (colours become live swatches; the full table sits inside the toggle):

```text
### `a.btn-solid` · 1 element restyled
_landing @ 1280_

`background-color` `rgb(95, 202, 219)` → `rgb(245, 158, 11)`

▾ Show the property change
   | Property         | Before            | After             |
   | background-color | rgb(95, 202, 219) | rgb(245, 158, 11) |
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

      # capture the PR head
      - run: git checkout ${{ github.event.pull_request.head.sha }}
      - run: npm ci && npm run build && (npm run serve &)
      - run: npx wait-on http://localhost:3000
      - run: STYLEMAP_DIR=head npx playwright test e2e/styleproof.spec.ts

      # report + gate
      - uses: BenSheridanEdwards/styleproof@v1
        with:
          baseline-dir: base
          fresh-dir: head
          require-approval: true # review-gate mode (omit / use fail-on-diff: true to certify)
```

**3. Copy [`example/styleproof-approve.yml`](https://github.com/BenSheridanEdwards/styleproof/blob/main/example/styleproof-approve.yml) to `.github/workflows/` on your default branch** — GitHub only runs `issue_comment` workflows from there, so the checkboxes do nothing until it's merged.

**4. Require the `StyleProof` status** in branch protection. Now an unsigned visual change can't merge.

> Capture both sides in the **same environment** (same machine, same env vars): if env vars change _what renders_, base and head will diff on DOM no PR touched.

## Reference

**Action `BenSheridanEdwards/styleproof@v1`** — key inputs:

| Input              | Default      | Purpose                                                                    |
| ------------------ | ------------ | -------------------------------------------------------------------------- |
| `baseline-dir`     | _required_   | Base-branch captures.                                                      |
| `fresh-dir`        | _required_   | PR-head captures to compare.                                               |
| `require-approval` | `false`      | Review-gate mode: set the `StyleProof` status instead of failing.          |
| `fail-on-diff`     | `true`       | Certify mode: fail on any diff. Ignored when `require-approval` is true.   |
| `status-context`   | `StyleProof` | Commit-status name. Must match the approve workflow and branch protection. |

Outputs: `changed` (`"true"` when anything changed), `report-url`. Other inputs (`report-branch`, `inline-images`, `github-token`) have sensible defaults — see [`action.yml`](https://github.com/BenSheridanEdwards/styleproof/blob/main/action.yml).

**CLIs** (every flag accepts `--flag value` and `--flag=value`; `--help` lists all):

- `styleproof-init` — scaffold the capture spec (and a starter `playwright.config.ts` if none exists).
- `styleproof-diff <beforeDir> <afterDir>` — the certify gate; exits `1` on any difference.
- `styleproof-report <beforeDir> <afterDir> --out <dir>` — render the diff to a Markdown report with before/after crops.

A programmatic API (`captureStyleMap`, `diffStyleMaps`, `generateStyleMapReport`, …) is also exported. For the capture internals, the approve-workflow trust model, and how to contribute, see [CONTRIBUTING](https://github.com/BenSheridanEdwards/styleproof/blob/main/CONTRIBUTING.md) and the [`example/`](https://github.com/BenSheridanEdwards/styleproof/tree/main/example) workflows.

## License

MIT © Ben Sheridan-Edwards
