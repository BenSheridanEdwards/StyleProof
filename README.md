# StyleProof

**Know exactly what every PR changes visually, and sign it off.** Two modes share one capture-and-diff engine: gate a PR on per-change sign-off, or certify that a refactor changed nothing visual. StyleProof captures the browser's _computed_ styles, diffs your PR against its base branch, and posts a per-change report, so a styling change never ships without someone confirming it was intended.

[![npm version](https://img.shields.io/npm/v/styleproof.svg)](https://www.npmjs.com/package/styleproof)
[![CI](https://github.com/BenSheridanEdwards/styleproof/actions/workflows/ci.yml/badge.svg)](https://github.com/BenSheridanEdwards/styleproof/actions)
[![license](https://img.shields.io/npm/l/styleproof.svg)](https://github.com/BenSheridanEdwards/styleproof/blob/main/LICENSE)

---

## The problem

Visual regressions are the biggest unguarded gap in front-end review. A PR says it does one thing; somewhere in the diff a `:focus` ring goes missing, a hidden error message changes colour, a rule lands on the wrong side of a breakpoint, a sub-pixel shift creeps in. None of that shows up in a code review of a Tailwind class soup, and pixel-snapshot tools miss most of it too: screenshots can't force `:hover` / `:focus` / `:active`, can't see elements that aren't currently visible, can't reach between-breakpoint rules, and blur away sub-pixel drift and declared-but-not-running motion.

## The solution

StyleProof reads the **computed style** of every element, the values the browser actually resolves, and turns each PR into a crisp answer to one question: what did this change about the way the site looks?

- It **captures computed styles, not pixels**: every resolved longhand, every pseudo-element, the deltas that `:hover` / `:focus` / `:active` apply (forced via the DevTools protocol, no mouse), swept across each `@media` breakpoint. It catches what screenshots miss.
- It **diffs your PR's HEAD against its base branch**, so the report is _exactly what this PR changes_, nothing more. There is no committed baseline to maintain and no drift to chase.
- It **posts a per-change report comment** on the PR, with before/after property tables and side-by-side crops, grouped so each distinct change appears once.
- It **gates the PR on per-change sign-off**: a `StyleProof` commit status that stays red until every change is approved, and goes green when there are none. The author (human or agent) ticks a box per change to confirm it was intended.

A reviewer, a senior engineer or an AI agent, holds that report against the PR's stated intent. If they line up, ship it. If a change shows up the PR never claimed, that's the signal something slipped in.

---

## How it works

Four stages turn a PR into a signed-off visual review: **capture → diff → report → gate.**

### The capture

StyleProof drives your pages with Playwright and, at each settled state, reads what the browser computed:

- **Elements.** Every element's computed style, pruned against per-tag user-agent defaults (measured in a clean, stylesheet-free iframe so only _your_ declarations remain), plus `::before` / `::after` / `::marker` / `::placeholder`.
- **States.** For every interactive element, what `:hover`, `:focus` (forced together with `:focus-visible`), and `:active` _change_, forced through a CDP session with `CSS.forcePseudoState`, captured as a delta over the element's subtree. No screenshot can reach these.
- **Motion.** `transition` and `animation` longhands are captured _before_ animations are frozen, so declared motion is verified while every other value is read as a settled end state.

Elements are keyed by **DOM structure, never class name** (`body > div:nth-child(2) > a:nth-child(1)`). That is the design property that makes a CSS-to-Tailwind migration legible: every `class` attribute can be rewritten and the map still lines up element-for-element. The class is stored as a human-readable label, but it is never compared.

The result is a `StyleMap`: a compact, deterministic JSON snapshot of one page at one viewport width. You capture one per surface per breakpoint.

### The diff: HEAD vs base branch

CI captures a `StyleMap` from the PR HEAD and another from the base branch, then diffs them. The diff is structural and value-exact:

- Elements present on one side only become `added` / `removed` DOM findings; a changed tag at the same path becomes `retagged`.
- Every computed longhand is compared, with each side falling back to its own UA defaults; any `before ≠ after` is a property change.
- State deltas are compared per element, per state, per sub-path.
- Custom properties (`--*`) are ignored on purpose: they are inputs, not outcomes, and every visual effect of a variable lands in a real longhand that _is_ compared in full.

Because the comparison is HEAD-against-base, the findings are precisely the visual surface area of _this_ PR.

### The report

The diff is rendered to a Markdown report (`report.md` + structured `report.json` + image crops) and posted as a marked PR comment:

- A one-line summary: how many DOM, computed-style, and state-delta differences, across how many distinct changes and surfaces.
- Each distinct change rendered once, even when it appears on several breakpoints (identical changes across surfaces collapse into a single section with one representative crop, the widest one).
- Before/after property tables per element, with longhands folded into readable rows (4-side families collapsed to shorthand, logical/physical duplicates dropped, transparent values normalised).
- Side-by-side before/after crops on a GitHub-dark canvas, located in a full-page screenshot via each element's document-space rect.
- Reflow noise filtered out by default: elements whose only change is size/position-derived are dropped so a single layout shift doesn't drown the real change.

### The approval gate

In review-gate mode the report comment carries **one approval checkbox per change**. The `StyleProof` commit status is red until every box is ticked, green when it is, and green immediately when a PR has no visual changes at all. Sign-off is bound to the exact reviewed commit: push new work and the gate re-opens for the new SHA. A companion workflow enforces _who_ can approve, detailed in [the Action reference](#the-github-action).

---

## Two modes

StyleProof is one capture-and-diff engine with two ways to act on the result. Pick which, and why:

- **Review gate** (`require-approval: true`) is the recommended mode: drive the `StyleProof` commit status and ask for per-change sign-off, so an intended change ships once someone confirms it. Use it on any PR that touches styling.
- **Certify a refactor** (`fail-on-diff: true`, the historical default) proves a change touched _nothing_ visual: any difference fails the job. Use it for a CSS-to-Tailwind migration, a design-system swap, or a build-tooling change whose entire promise is "the output is byte-for-byte identical." The contract is zero diff, and a single drifting property is a failure to investigate, not a change to approve.

Review-gate is the recommended mode but opt-in; `fail-on-diff` is the historical default, and `fail-on-diff` is ignored when `require-approval` is true. A PR is either gated on sign-off or gated on identity, never both.

---

## Install

```bash
npm install -D styleproof @playwright/test
npx playwright install chromium
```

Requirements:

- **Node ≥ 18**, ESM (`"type": "module"`).
- **`@playwright/test` ≥ 1.40** (peer dependency): StyleProof captures through Playwright and forces states through Chromium's DevTools protocol.

Working examples live in [`example/`](https://github.com/BenSheridanEdwards/styleproof/tree/main/example): a capture spec and the approve workflow you'll copy into CI.

## Quickstart

After installing (above), scaffold the capture spec, wire CI, copy the approve workflow, and require the status.

### 1. Scaffold a capture spec

```bash
npx styleproof-init
```

This writes `e2e/styleproof.spec.ts` (a starter surface sweeping widths `[1280, 768, 390]` with a `settle()` helper) and, only if you don't already have one, a `playwright.config.ts` pointed at `http://localhost:3000`. It never overwrites an existing config, and re-running it is a no-op.

Edit the spec to describe your surfaces with `defineStyleMapCapture`:

```ts
import { defineStyleMapCapture } from 'styleproof';

async function settle(page) {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  // scroll-reveal, lazy images, etc.: drive the page to rest before capture
}

defineStyleMapCapture({
  dir: process.env.STYLEMAP_DIR, // inert until set — see below
  surfaces: [
    {
      key: 'landing',
      go: async (page) => {
        await page.goto('/');
        await settle(page);
      },
      widths: [1280, 768, 390], // one viewport per @media band
    },
    {
      key: 'landing-nav-open',
      go: async (page) => {
        await page.goto('/');
        await settle(page);
        await page.getByRole('button', { name: 'Menu' }).click();
      },
      widths: [768, 390],
    },
  ],
});
```

The spec is **inert** (every test skips) until `dir` is set via `STYLEMAP_DIR`, so it lives harmlessly alongside your other Playwright tests and only runs when CI asks it to. Each `surface × width` becomes one test, capturing `<key>@<width>.json.gz` (plus a full-page screenshot for the report crops).

### 2. Wire CI to capture HEAD and base

Your CI job captures the PR HEAD and the base branch into two directories, then hands them to the Action. The shape is the same for every framework; `npm run build` / `npm run serve` here stand in for _your_ framework's commands (see [CI recipes](#ci-recipes)), and `npx wait-on` blocks until the server is actually ready before capture:

```yaml
# .github/workflows/styleproof.yml
name: StyleProof
on: pull_request

jobs:
  styleproof:
    runs-on: ubuntu-latest # or your self-hosted runner — see caveat
    permissions:
      contents: write # push the report branch
      pull-requests: write # post/update the comment
      statuses: write # set the StyleProof status
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # need the base branch too

      # --- capture the base branch ---
      - run: git checkout ${{ github.event.pull_request.base.sha }}
      - run: npm ci && npm run build && (npm run serve &) # your framework's build + serve
      - run: npx wait-on http://localhost:3000 # wait for the server to bind
      - run: STYLEMAP_DIR=base npx playwright test e2e/styleproof.spec.ts

      # --- capture the PR head ---
      - run: git checkout ${{ github.event.pull_request.head.sha }}
      - run: npm ci && npm run build && (npm run serve &)
      - run: npx wait-on http://localhost:3000
      - run: STYLEMAP_DIR=head npx playwright test e2e/styleproof.spec.ts

      # --- report + gate ---
      - uses: BenSheridanEdwards/styleproof@v1
        with:
          baseline-dir: base
          fresh-dir: head
          require-approval: true # review-gate mode
```

The `git checkout`, build/serve, and `wait-on` lines are conventional Actions/git plumbing you supply for a HEAD-vs-base capture, not StyleProof commands; only the `styleproof.spec.ts` runs and the Action step are StyleProof's.

### 3. Copy the approve workflow to your default branch

The checkboxes need a workflow to read them. Copy [`example/styleproof-approve.yml`](https://github.com/BenSheridanEdwards/styleproof/blob/main/example/styleproof-approve.yml) to `.github/workflows/` on your **default branch**: it enforces who can approve (details in [the Action reference](#the-github-action)). GitHub only runs `issue_comment` workflows from the default branch, so until this file is merged there the checkboxes won't do anything, even on the PR you're testing.

### 4. Require the status

Add a branch-protection rule requiring the `StyleProof` status check. Now an unsigned visual change can't merge.

> **Caveats.**
>
> - **Self-hosted runners:** `issue_comment` workflows run from the default branch, and on a **private repo without GitHub-hosted Actions minutes** that job silently fails to start. Point the approve workflow at the same self-hosted runner your CI uses (`runs-on: [self-hosted, …]`); there's a comment in the template marking the line.
> - **Hard merge-blocking is your host's job.** StyleProof sets a commit status; turning that status into a _required_ check is a branch-protection setting on GitHub. The gate is only as binding as the rule you attach to it.

---

## Reference

### Concepts

**StyleMap.** The capture artifact: a JSON object (gzipped on disk) with three layers — `defaults` (per-tag UA baselines used for pruning), `elements` (every element's pruned computed style + pseudo-elements + document-space `rect`), and `states` (the `:hover` / `:focus` / `:active` deltas). One `StyleMap` is one surface at one width.

**Surfaces.** A page in a particular state at a set of widths: a `key`, a `go(page)` that navigates and settles, an `ignore` list of nondeterministic regions, and the `widths` to sweep (one per `@media` band). `defineStyleMapCapture` expands `surfaces × widths` into individual Playwright tests.

**DOM-structure keys.** Elements are keyed by structural path, never class, so a refactor can rewrite every `class` and still produce a comparable map. Tag changes at the same path surface as `retagged`.

**Derived / reflow filtering.** The report drops elements whose only differences are size/position-derived and strips those props from the rest. Turn it off with `--include-layout-noise`. The certification differ (`styleproof-diff`) always keeps them — a reflow is itself a change to certify.

**The report.** Cross-surface changes collapse to one section with one representative crop (the widest surface); each changed element renders once, gathering its base, pseudo, and state findings under a single heading. Property lists are folded into readable rows by `summarizeProps`; element labels come from `prettyLabel`. Brand-new elements render their state values as a single column (there's no meaningful "before"); existing elements render `Before → After`.

### Readable output

A clean run:

```
✓ All surfaces identical: every computed style, pseudo-element, and hover/focus/active state matches.
```

A change, as the certification differ prints it:

```
✗ 2 surface(s) with difference(s)

landing @ 1280
  a.nav-cta
    color           #0b1220 → #ffffff
    background-color #58a6ff → #1f6feb
  button.cta  :focus
    outline-color   (state does not change it) → #58a6ff
```

…and as the PR report renders it: a summary line, a section per distinct change with a before/after crop, and per-element property tables.

### API

```ts
import {
  captureStyleMap,
  saveStyleMap,
  loadStyleMap,
  defineStyleMapCapture,
  diffStyleMaps,
  diffStyleMapDirs,
  findingLabel,
  generateStyleMapReport,
  summarizeProps,
  prettyLabel,
} from 'styleproof';
```

| Export                                           | Purpose                                                                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `captureStyleMap(page, options?)`                | Read a settled page into a `StyleMap`.                                                                           |
| `saveStyleMap(path, map)` / `loadStyleMap(path)` | Persist / read a map (gzipped when the path ends `.gz`; a corrupt file throws a friendly "re-capture it" error). |
| `defineStyleMapCapture(options)`                 | Generate the Playwright capture tests from a surface list.                                                       |
| `diffStyleMaps(a, b)`                            | `Finding[]` for two maps.                                                                                        |
| `diffStyleMapDirs(dirA, dirB)`                   | `{ surfaces, counts }` across two capture directories.                                                           |
| `findingLabel(path, cls)`                        | Human label for a finding.                                                                                       |
| `generateStyleMapReport(before, after, options)` | Write `report.md`, `report.json`, and `crops/`.                                                                  |
| `summarizeProps` / `prettyLabel`                 | The report's property-folding and element-labelling helpers.                                                     |

Key types: `StyleMap`, `ElementEntry`, `Rect`, `CaptureOptions` (capture); `Surface`, `DefineOptions` (runner); `Finding`, `PropChange`, `SurfaceDiff`, `DiffCounts` (diff); `ReportOptions`, `ReportResult` (report).

```ts
import { chromium } from '@playwright/test';
import { captureStyleMap, saveStyleMap, loadStyleMap, diffStyleMaps } from 'styleproof';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

await page.goto('http://localhost:3000');
// …drive to a settled state…
const head = await captureStyleMap(page, { ignore: ['.clock', '.carousel'] });

const base = loadStyleMap('base/landing@1280.json.gz');
const findings = diffStyleMaps(base, head); // exactly what changed
```

`CaptureOptions`:

```ts
type CaptureOptions = {
  ignore?: string[]; // nondeterministic regions; matches AND their descendants are skipped
  captureStates?: boolean; // default true — the forced :hover/:focus/:active layer
  maxInteractive?: number; // default 800 — cap on forced-state interactive elements
};
```

### CLI

Three bins ship with the package. Every flag accepts both `--flag value` and `--flag=value`.

#### `styleproof-init`

Scaffold the capture spec (and a starter `playwright.config.ts` if none exists).

```
styleproof-init [options]
  --dir <path>      spec output path (default: e2e/styleproof.spec.ts)
  --base-url <url>  baseURL for a generated playwright.config.ts (default: http://localhost:3000)
  --force           overwrite the spec if it already exists
  -h, --help        show this help
```

Idempotent. Exit `0` done / nothing to do, `2` usage error.

#### `styleproof-diff`

The certification gate: does anything differ? Prints per-surface element / property / state drift and a final identical / differences summary.

```
styleproof-diff <beforeDir> <afterDir> [options]
  --max <n>     max lines printed per surface before truncating (default: 40)
  --json <file> also write the full structured diff to <file>
  -h, --help    show this help
```

Exit `0` identical (certified), `1` differences found, `2` usage / capture error.

#### `styleproof-report`

The reviewable product: render the diff to a Markdown report with before/after crops.

```
styleproof-report <beforeDir> <afterDir> --out <dir> [options]
  --out <dir>              output directory (default: styleproof-report)
  --image-base-url <url>   prefix for image URLs in report.md (default: relative)
  --pad <px>               padding around changed rects when cropping (default: 24)
  --max-crops <n>          max crop regions per surface before collapsing (default: 6)
  --fold-details-at <n>    rows at which a crop's tables fold under a <details> toggle
                           (default: 0 = always; 'Infinity' = never)
  --min-width <px>         minimum crop width, for context (default: 320)
  --min-height <px>        minimum crop height, for context (default: 180)
  --include-layout-noise   keep size/position-derived longhands (off by default)
  -h, --help               show this help
```

Exit `0` no changes (empty report written), `1` report generated, `2` usage error.

The split is the spine of the tool: **`styleproof-diff` is the certify gate, `styleproof-report` is the review product.** The Action runs the diff to decide whether anything changed, then the report to show what.

### The GitHub Action

`BenSheridanEdwards/styleproof@v1` (composite). It runs `styleproof-diff` to detect change, runs `styleproof-report` when there is any, pushes the report to an orphan branch, upserts a marked PR comment, and either fails the job (certify mode) or sets the `StyleProof` status (review mode).

**Inputs:**

| Input              | Default               | Purpose                                                                                                      |
| ------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `baseline-dir`     | _required_            | Base-branch captures (`.json.gz` + `.png`).                                                                  |
| `fresh-dir`        | _required_            | PR-head captures to compare.                                                                                 |
| `report-branch`    | `styleproof-reports`  | Orphan branch storing reports, one `pr-<n>/` folder per PR.                                                  |
| `inline-images`    | `auto`                | `auto` / `always` / `never`. `auto` embeds composites inline for public repos, links the report for private. |
| `github-token`     | `${{ github.token }}` | Push the report branch and post the comment.                                                                 |
| `fail-on-diff`     | `true`                | Certify mode: fail the job on any diff. Ignored when `require-approval` is true.                             |
| `require-approval` | `false`               | Review-gate mode: set the `StyleProof` status instead of failing.                                            |
| `status-context`   | `StyleProof`          | Commit-status name. Must match the approve workflow and branch protection.                                   |

**Outputs:**

| Output       | Value                                                               |
| ------------ | ------------------------------------------------------------------- |
| `changed`    | `"true"` when any computed style, pseudo-element, or state changed. |
| `report-url` | Blob URL of the committed report (when changed).                    |

**The approve workflow trust model.** `styleproof-approve.yml` fires on `issue_comment: [edited]` (ticking a box edits the comment) and flips the status. It is deliberately strict about _who_ can approve:

- It only acts on a **human editing the bot's own report comment**: comment author is the Bot, the editing sender is a User, and the body carries the `<!-- styleproof-report -->` marker. This excludes the Action's own edits and any attacker-authored comment.
- **Write access is the trust boundary, not the marker.** The editor's collaborator permission must be `admin` / `maintain` / `write` (failing closed to `none`); otherwise it posts a "needs write access" reply and leaves the status red.
- **Sign-off is bound to the commit.** The report embeds `<!-- styleproof-sha:<40-hex> -->`; the workflow resolves the PR head and does nothing unless they match. A push after the report can never inherit a green status — the Action re-posts red for the new SHA.
- It counts `- [x] **Approve this change**` lines and sets `success` only when ticked equals total, else `failure` with `N of M change(s) approved`.

It runs on the default token via `actions/github-script@v7`; the Action's `github-token` defaults to `${{ github.token }}`, so no PAT is required.

---

## CI recipes

Capture base and head under their own `STYLEMAP_DIR` (see [Quickstart step 2](#2-wire-ci-to-capture-head-and-base)), then hand the two directories to the Action. Only the build/serve lines change per framework:

| Framework   | build                      | serve                                       |
| ----------- | -------------------------- | ------------------------------------------- |
| Next.js     | `next build`               | `next start -p 3000`                        |
| Vite        | `vite build`               | `vite preview --port 3000`                  |
| Static site | (your generator)           | `npx serve -l 3000 dist`                    |
| Anything    | whatever produces the site | any static server on the captured `baseURL` |

For **certify mode**, swap `require-approval: true` for `fail-on-diff: true` (the default) and the job fails on any diff instead of asking for sign-off.

### Baselines and the env-parity gotcha

Capture both sides under the **same environment**. If env vars change _what renders_ (a token that toggles a panel, an address that changes a `mailto:`, an embed key that swaps a real widget for a skeleton), then a base captured with your local `.env` against a head captured on a bare CI runner will diff on DOM structure that no PR touched. Capture base and head with the identical env on the same machine, and the diff is purely the PR's doing.

## Determinism

The capture reads whatever is in front of it, so **drive the page to rest before capturing.** Your `settle()` should wait for fonts (`document.fonts.ready`), let lazy images and scroll-reveal animations finish, and stop any looping motion. StyleProof freezes `transition`/`animation` itself before the base pass (after recording declared motion), but it cannot settle _your_ application state for you. `ignore` out genuinely nondeterministic regions (clocks, carousels, randomised content); the selector and all its descendants are dropped.

## Limitations

- **Forced states are Chromium-only.** `:hover` / `:focus` / `:active` are forced through the Chromium DevTools protocol, so the state layer is Chromium-specific. (Base and pseudo layers work wherever Playwright runs.)
- **No Shadow DOM or iframe piercing.** Open or closed shadow roots and iframe content (same- or cross-origin) are not traversed; a refactor inside one would be falsely reported identical. Capture warns once when it sees shadow hosts or same-origin frames.
- **Same machine.** Compare maps captured on the same OS / browser build / DPR; font rasterisation and default metrics differ across hosts. (See the env-parity note above.)
- **The forced-state layer is the expensive one.** It's capped at `maxInteractive` (800) elements per surface and can be turned off with `captureStates: false`. A CDP count-skew on a surface (from `display: contents`, late hydration, injected nodes) makes the state layer for that surface skip with a warning rather than abort the diff; a one-sided skip is surfaced loudly so it never reads as "identical."

## Compared to pixel-snapshot tools

|                                  | Percy / Chromatic     | Playwright screenshots | **StyleProof**                                |
| -------------------------------- | --------------------- | ---------------------- | --------------------------------------------- |
| What's compared                  | rendered pixels       | rendered pixels        | **computed styles** (every resolved longhand) |
| Hover / focus / active           | ✗ (can't force)       | ✗ (can't force)        | ✓ forced via CDP                              |
| Hidden / off-screen elements     | ✗                     | ✗                      | ✓                                             |
| Between-breakpoint rules         | only at chosen widths | only at chosen widths  | ✓ swept per width                             |
| Sub-pixel / declared motion      | blurred / invisible   | blurred / invisible    | ✓ exact values                                |
| Baseline to maintain             | hosted baseline       | committed PNGs         | **none — diffs HEAD vs base branch**          |
| Per-change sign-off              | hosted approvals UI   | ✗                      | ✓ per-change checkboxes, `StyleProof` status  |
| Refactor "changed nothing" proof | approximate (pixels)  | approximate (pixels)   | ✓ exact (zero diff)                           |

## Contributing

Issues and PRs welcome at [github.com/BenSheridanEdwards/styleproof](https://github.com/BenSheridanEdwards/styleproof). It is, fittingly, gated on its own report.

## License

MIT © Ben Sheridan-Edwards
