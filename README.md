# StyleProof

**Know exactly what every PR changes visually, and sign it off.** StyleProof captures the browser's _computed_ styles (not pixels), diffs your PR's HEAD against its base branch, and posts a per-change report on the PR, so a styling change never ships without someone confirming it was intended.

[![npm version](https://img.shields.io/npm/v/styleproof.svg)](https://www.npmjs.com/package/styleproof)
[![CI](https://github.com/BenSheridanEdwards/StyleProof/actions/workflows/ci.yml/badge.svg)](https://github.com/BenSheridanEdwards/StyleProof/actions)
[![license](https://img.shields.io/npm/l/styleproof.svg)](https://github.com/BenSheridanEdwards/StyleProof/blob/main/LICENSE)

## Why

Pixel-snapshot tools miss most CSS regressions: they can't force `:hover` / `:focus` / `:active`, can't see hidden or off-screen elements, can't reach between-breakpoint rules, and blur away sub-pixel drift. StyleProof reads the **computed style** of every element instead — every resolved longhand, every pseudo-element, the deltas `:hover` / `:focus` / `:active` apply (forced via CDP, no mouse), swept across each `@media` breakpoint.

## What the gate does

On every PR, StyleProof captures a `StyleMap` from the HEAD and from the base branch, diffs them, and posts a Markdown comment:

- A **lean summary comment** linking to a committed side-by-side report — the report is the complete source of truth (**one section per distinct change**, with a before/after cropped screenshot cropped from the same rectangle so the two sides line up exactly, **plain-English bullets that tell you what to look for** — `columns: 2 → 3`, `recoloured cyan → amber` — and the exact property changes). The comment never duplicates the report, so the two can't drift, and it renders identically on public and private repos.
- A single **Approve all changes** checkbox in the comment, driving a `StyleProof` commit status: red until one tick signs off every change, green when there are none. The reviewer who ticks it is recorded inline (_approved by @them_), sourced from the commit status so it survives a report re-run.
- **New surfaces don't block.** A surface that exists only on the PR head (no baseline to diff — e.g. the bootstrap PR that first adds the capture spec, or a brand-new page) is shown in the report under a `🆕 new surface` heading but never holds the status red and needs no sign-off. It becomes part of the baseline once merged.
- No committed baseline to maintain — the diff is HEAD-vs-base, so the report is _exactly what this PR changes_.

## Don't let a new page ship uncaptured

StyleProof diffs the surfaces your spec lists — so a page nobody added to the list is invisible to the gate. Its change has no base capture _and_ no head capture, so it never appears in any diff, and the status goes green having never looked at it. This is the one thing the captures can't catch on their own: a capture that was never taken.

Declare your app's route/view universe in `expected` and StyleProof emits a coverage-guard test in your **normal** suite (it runs even without `STYLEMAP_DIR` — it's a static check, no browser). It fails the moment a route exists with no surface, so a new page can't ship uncaptured:

```ts
import { defineStyleMapCapture } from 'styleproof';
import { ROUTES } from '../app/routes'; // your registry — wherever routes live

defineStyleMapCapture({
  dir: process.env.STYLEMAP_DIR,
  surfaces: SURFACES,
  expected: ROUTES.map((r) => r.id), // every route StyleProof should cover
  exclude: { checkout: 'auth-gated — capture fixture pending' }, // visible, reviewed opt-outs (key → reason)
});
```

A route that's neither a captured surface nor an `exclude` entry fails the guard; an `exclude` key that isn't in `expected` (a renamed/removed route) fails too, so the opt-out ledger can't quietly rot. Captured surfaces beyond `expected` are fine — one route can have several states (`landing`, `landing-nav-open`). Omit `expected` and behaviour is unchanged.

**Next.js: wired for you.** Run `styleproof-init` in a Next.js project and the generated spec discovers your routes (App Router `app/` + Pages Router `pages/`) at run time and wires both the surfaces and `expected` to them — so it's protected out of the box, and a page you add later is covered automatically with nothing to keep in sync:

```ts
import { defineStyleMapCapture, discoverNextRoutes } from 'styleproof';

const ROUTES = discoverNextRoutes(); // [{ key, path, dynamic }, …] from app/ + pages/
defineStyleMapCapture({
  surfaces: ROUTES.filter((r) => !r.dynamic).map((r) => ({
    key: r.key,
    go: (p) => p.goto(r.path),
    widths: [1280, 768, 390],
  })),
  expected: ROUTES.map((r) => r.key),
  exclude: Object.fromEntries(
    ROUTES.filter((r) => r.dynamic).map((r) => [
      r.key,
      `dynamic route ${r.path} — add a surface with a concrete param`,
    ]),
  ),
  dir: process.env.STYLEMAP_DIR,
});
```

`discoverNextRoutes(cwd?)` reads the filesystem only (route groups `(group)` and `@slots` stripped, `[param]`/`[...catchall]` flagged `dynamic`) — a heuristic, not a router; edit the generated spec for exotic routing. For any other framework, point `expected` at your own route registry as above.

## What a report looks like

One change — the hero CTA recoloured cyan → amber — appears as a single section in the report: a side-by-side before/after cropped screenshot, a one-line summary, then the exact property change folded under a toggle.

![A StyleProof report: the CTA button before (cyan) and after (amber), side by side](https://raw.githubusercontent.com/BenSheridanEdwards/StyleProof/main/docs/demo-composite.png)

As it renders in the committed report (a plain-English bullet first — naming the theme token and showing the hex with a live colour swatch — then the exact table inside the toggle). The PR comment itself stays lean — a summary plus the approval box — and links here:

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
      go: (page) => page.goto('/'), // that's it — StyleProof settles the page (in-flight data, fonts, animations) before it reads
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
      - uses: BenSheridanEdwards/StyleProof@v2
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
- **Self-check** — captures each surface twice and fails if they differ, so a replay gap or unseeded randomness surfaces as a clear _"non-deterministic capture"_ error, never as a phantom change on an unrelated PR. **On by default while recording** (where live nondeterminism shows up); off on the replay run, which renders against the recorded HAR and is deterministic by construction. `STYLEPROOF_SELFCHECK=1` forces it on for both; `selfCheck: false` opts out.
- **Framework noise is skipped by default.** Non-visual and framework-injected elements never count as a change — `<meta>`/`<title>`/`<script>`/`<style>`/… (which Next.js streams into the body then hoists) and live regions like Next's `next-route-announcer`. A real stylesheet change still shows up in the affected elements' computed styles, not in the `<style>` tag. Add your own selectors with `ignore` — they extend this default, they don't replace it.

> Replay covers data the page _fetches_. If your app **server-renders** differently per environment (SSR feature flags, locale), still capture both sides with the same server env so the rendered HTML matches.

**Live pages just work.** Before each capture, StyleProof settles the page, and the settle is **network-aware**: it holds while the page's data requests are in flight (excluding long-lived `EventSource`/WebSocket streams, which never finish) _and_ until the computed-style map stops changing. So async content (a fetch backfilling a grid, an SSE stream) is captured **loaded, not mid-load** — and, crucially, it **can't false-settle on the loading state before a slow backend's response arrives**. That's the failure mode of a fixed wait: against a slow server (e.g. a dev server under CI load) a timer settles on the loading skeleton one run and the loaded deck the next — a phantom diff / self-check flake. Waiting on the actual request removes it. Anything still moving on its own after that is detected as a live region and excluded from the diff, so a stream or ticker never reads as a change — no manual `ignore` needed. `defineStyleMapCapture` arms the request tracker before each `go()` automatically; for a direct `captureStyleMap` call, arm one before you navigate with `trackInflightRequests(page)` and pass `{ pendingRequests }`. Disable or tune with `{ stabilize: false }` / `{ stabilize: { quietFor, timeout, waitForRequests } }`.

**At a glance — almost everything is automatic.** The few knobs exist only for what StyleProof can't know about your app, and each says why:

| Handled for you — zero config                               | How                                                                                      |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| In-flight data, fonts, late layout                          | network-aware settle holds until requests finish _and_ the computed styles stop changing |
| Animations, transitions, focus ring, caret                  | frozen / blurred before the map is read                                                  |
| Clock-derived styling (`stale > 1h → red`)                  | `Date.now()` / `new Date()` frozen to a fixed instant                                    |
| Framework & non-visual noise (`<script>`, route announcers) | skipped by default                                                                       |
| Live / volatile regions (tickers, third-party embeds)       | auto-detected as still-moving and excluded from the diff                                 |
| Non-deterministic capture (replay gap, unseeded randomness) | self-check flags it _while recording_, with a named error                                |

| You set this — only because it's app-specific | Why it exists                                                                                                                                                                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STYLEPROOF_REPLAY_FROM` (record / replay)    | Base and head capture at different times against a live backend; replaying the base's recorded data pins the head to the same inputs, so the diff is **your code, not data drift**. The one piece of real setup. |
| `replayUrl` / `STYLEPROOF_REPLAY_URL`         | Your data endpoints aren't under `**/api/**`.                                                                                                                                                                    |
| `ignore: ['.selector']`                       | You want a region gone **explicitly** — auto-exclude already handles most live regions, but a known-noisy element reads clearer named.                                                                           |
| `clockTime`                                   | Your styling keys off a **specific** date, not just "now".                                                                                                                                                       |
| `stabilize: { quietFor, timeout }`            | An unusually slow surface needs a longer quiet window before the map is read.                                                                                                                                    |

## Optional: content layer (advisory)

StyleProof is **computed-styles first**, and stays that way: a CSS-only refactor that also rewrites text is still certified identical, and live text (a clock, "2m ago") never reads as a change. But a pure-style diff is blind to copy, and copy isn't always cosmetic: **new or longer text can overflow or clip its box, silently breaking the layout.** A visual-confidence tool that can't see that isn't quite complete. So the content layer exists as an explicit **opt-in**, off by default, and **advisory** — it never feeds the certification or the gate.

Turn it on in two places:

```ts
// styleproof.spec.ts — record each element's own text alongside its computed style
defineStyleMapCapture({ surfaces: SURFACES, dir: process.env.STYLEMAP_DIR, captureText: true });
```

```bash
# render the advisory content section (each change with a before/after crop)
styleproof-report before after --out report --include-content
```

The report then carries a separate **📝 Content changes (advisory)** section: every element whose own text changed, with the before/after strings and a side-by-side crop, so a silent copy edit (and any overflow it causes) is visible in review. It does **not** affect `changed`, the `StyleProof` status, or the diff exit code, by design. With capture left at its default (`captureText` off), there's no text in the maps and the section is always empty, so existing setups are completely unaffected.

Notes: only an element's _own_ text is recorded (so a parent and child never double-report the same string); text churn in a live region is auto-excluded by the same settle pass that guards styles; and the certification CLI (`styleproof-diff`) is deliberately left content-blind.

## Optional: React component layer (advisory)

For a React app, knowing _which component_ rendered an element is often the fastest way to read a change. Off by default, opt in with `captureComponent`:

```ts
// styleproof.spec.ts — record the React component + props behind each element
defineStyleMapCapture({ surfaces: SURFACES, dir: process.env.STYLEMAP_DIR, captureComponent: true });
```

Capture reads the React fiber in-page (`__reactFiber$*`/`__reactProps$*` on React 17+, `__reactInternalInstance$*` on ≤16) and records the component display name plus a **sanitized** subset of its props (primitives only — `children`, handlers, and objects are dropped) on `ElementEntry.component`. The report then names the element — **`React component: Button (variant=primary, size=sm)`** — instead of showing a bare `<button>`.

Like the content layer it is **advisory**: never fed to the certification diff or the gate, so captures stay deterministic. Component names are mangled in minified production builds, so it's most useful against a dev / non-minified target; on a non-React page the fiber keys are absent and the field is simply omitted.

## Newly-added elements show their full style

When a PR **adds** an element, StyleProof now reports its **full resting computed style** (background, padding, font, radius, …), value-only, in addition to any interaction-state deltas — previously an added element surfaced only its `:hover`/`:focus` changes. The new element already gates via its `added` finding; this only enriches what you see, in both the report and the `styleproof-diff` CLI.

## Reference

**Action `BenSheridanEdwards/StyleProof@v2`** — key inputs:

| Input              | Default      | Purpose                                                                    |
| ------------------ | ------------ | -------------------------------------------------------------------------- |
| `baseline-dir`     | _required_   | Base-branch captures.                                                      |
| `fresh-dir`        | _required_   | PR-head captures to compare.                                               |
| `require-approval` | `false`      | Review-gate mode: set the `StyleProof` status instead of failing.          |
| `fail-on-diff`     | `true`       | Certify mode: fail on any diff. Ignored when `require-approval` is true.   |
| `status-context`   | `StyleProof` | Commit-status name. Must match the approve workflow and branch protection. |

Outputs: `changed` (`"true"` when anything changed), `report-url`. Other inputs (`report-branch`, `github-token`) have sensible defaults — see [`action.yml`](https://github.com/BenSheridanEdwards/StyleProof/blob/main/action.yml).

**Policy file `styleproof.config.json`** (optional, at the repo root) — gate policy that isn't workflow plumbing:

| Key        | Default | Purpose                                                                                                                                                                            |
| ---------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blocking` | `false` | Review-gate mode only: on **unapproved** visual changes, also **fail the job** (red ✗), so the check blocks even without a branch-protection rule requiring the status. See below. |

### Blocking without branch protection

A commit status only _blocks a merge_ where a branch-protection rule requires it — which needs GitHub Pro or a public repo. On a free private repo the `StyleProof` status is advisory. Set `"blocking": true` in `styleproof.config.json` to also fail the report job on unapproved changes, so the PR shows a red check regardless:

```json
{ "blocking": true }
```

It's **asynchronous by design**: approval is a checkbox tick handled by a separate workflow, so to clear the red you tick **Approve all changes**, then **re-run the StyleProof job** — the re-run sees the sign-off on the commit status and passes. (A new push that changes styles re-opens it.)

**Capture spec `defineStyleMapCapture({ surfaces, … })`** — determinism is on by default; you rarely set more than `surfaces` and `dir`:

| Option        | Default                     | Purpose                                                                                                                                                                             |
| ------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `surfaces`    | _required_                  | Page states to certify — each `{ key, go, widths, ignore?, height? }`. `go(page)` drives to a settled state.                                                                        |
| `expected`    | _none_                      | Your route/view universe. Emits a coverage-guard test (runs without a capture dir) that fails when a route has no surface and isn't excluded — so a new page can't ship uncaptured. |
| `exclude`     | `{}`                        | `key → reason` for routes deliberately not captured. Keeps the guard green for known gaps; a key absent from `expected` fails the guard, so the ledger can't go stale.              |
| `dir`         | `STYLEMAP_DIR`              | Output label (`base`/`head`); the spec is **inert until set**, so it sits safely beside your other specs.                                                                           |
| `replayFrom`  | `STYLEPROOF_REPLAY_FROM`    | Baseline dir whose recorded responses to replay. Unset → this run **records** its HAR for the comparison to use.                                                                    |
| `replayUrl`   | `**/api/**` (`…REPLAY_URL`) | URL glob for the data boundary to record/replay; everything else (JS/CSS/fonts) loads live so the code runs.                                                                        |
| `freezeClock` | `true`                      | Pin `Date.now()`/`new Date()` so time-derived styling can't drift; timers keep running so settling still works.                                                                     |
| `clockTime`   | `2025-01-01T00:00:00Z`      | The frozen instant.                                                                                                                                                                 |
| `selfCheck`   | on while recording          | Capture each surface twice and fail on any difference — proves the capture is deterministic. Off on the replay run; `STYLEPROOF_SELFCHECK=1` forces both.                           |
| `screenshots` | `true`                      | Save full-page screenshots for the report's before/after crops.                                                                                                                     |
| `baseDir`     | `__stylemaps__`             | Output root directory.                                                                                                                                                              |

Non-visual and framework-injected elements (`<meta>`/`<title>`/`<script>`/`<style>`/… and `next-route-announcer`) are skipped automatically; a surface's `ignore` adds to that default, it doesn't replace it.

**Capture env vars** (wire CI without editing the spec):

| Env                      | Purpose                                                                       |
| ------------------------ | ----------------------------------------------------------------------------- |
| `STYLEMAP_DIR`           | Output label; the capture is skipped entirely when unset.                     |
| `STYLEPROOF_REPLAY_FROM` | Baseline dir to replay recorded data from — set this on the **head** capture. |
| `STYLEPROOF_REPLAY_URL`  | Override the `**/api/**` data-boundary glob.                                  |
| `STYLEPROOF_SELFCHECK`   | `1` to capture each surface twice and fail if the two differ.                 |

**CLIs** (every flag accepts `--flag value` and `--flag=value`; `--help` lists all):

- `styleproof-init` — scaffold the capture spec (and, if none exists, a starter `playwright.config.ts` whose `webServer` **builds and serves a production build**, so captures never run against a flaky dev server).
- `styleproof-diff <beforeDir> <afterDir>` — the certify gate; exits `0` certified (identical), `1` on a diff, `2` on a usage/capture error, `3` when only new surfaces are present (no baseline to diff against).
- `styleproof-report <beforeDir> <afterDir> --out <dir>` — render the diff to a Markdown report with before/after crops. Add `--include-content` for the opt-in, advisory content section (see above).

A programmatic API (`captureStyleMap`, `diffStyleMaps`, `generateStyleMapReport`, …) is also exported. For the capture internals, the approve-workflow trust model, and how to contribute, see [CONTRIBUTING](https://github.com/BenSheridanEdwards/StyleProof/blob/main/CONTRIBUTING.md) and the [`example/`](https://github.com/BenSheridanEdwards/StyleProof/tree/main/example) workflows.

## License

MIT © Ben Sheridan-Edwards
