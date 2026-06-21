# Changelog

All notable changes to **StyleProof** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`approve-all` input.** In review-gate mode, render a single **Approve all
  changes** checkbox at the top of the report instead of one box per change, so a
  reviewer signs off every change with one tick. Off by default (per-change boxes
  are unchanged); the `styleproof-approve` workflow accepts either shape.
- **Fork and Dependabot support.** The Action now resolves the PR number and head
  SHA in an event-aware way, so it can be driven from a `workflow_run` as well as
  from `pull_request`. New example workflows `example/styleproof-capture.yml`
  (read-only `pull_request` capture + artifact upload) and
  `example/styleproof-report.yml` (`workflow_run` report under a write token, never
  running the PR's code) let fork and Dependabot PRs gate without handing a write
  token to untrusted code — the secure alternative to `pull_request_target`. PR
  identity is taken only from the trusted `workflow_run` event (`head_sha`, the
  event's `pull_requests`, and a commit→PR lookup against that same head SHA for
  forks) — never from the capture artifact — so an untrusted PR cannot redirect the
  privileged comment or status at a victim PR or commit.

### Fixed

- **SSE streams no longer read as phantom diffs under replay.** A long-lived
  stream can't round-trip through a HAR, so `routeFromHAR`'s url glob (default
  `**/api/**`) would intercept an app's `EventSource` endpoint and, on the replay
  run, abort it — dropping the app to its no-stream fallback (a different but
  _stable_ render that settle/volatile can't catch). That surfaced as a
  computed-style change on every diff even when no CSS changed. Capture now lets
  `Accept: text/event-stream` requests bypass record/replay and reach the live
  server on both runs, so both sides see the same streamed state. Stream-pushed
  data must be deterministic at capture time (fixtures/frozen clock), as the
  README already requires of live regions.
- The README CI recipe pointed `baseline-dir` / `fresh-dir` at the bare `base` /
  `head` labels, but captures land under `baseDir` (`__stylemaps__/base`,
  `__stylemaps__/head`), so `styleproof-diff` failed with `no capture at base`.
  The recipe now uses the full `__stylemaps__/<label>` paths.

## [1.9.4]

### Changed

- Repository URLs now use the canonical `BenSheridanEdwards/StyleProof` casing
  everywhere — README badges, Action references, and doc links, plus the CHANGELOG
  compare links, CONTRIBUTING, SECURITY, `action.yml`, and the release workflow.
  (npm package-name URLs stay lowercase, as npm requires.)

## [1.9.3]

### Changed

- Canonical `StyleProof`-cased GitHub URLs in `package.json` (`homepage`,
  `repository`, `bugs`).

### Fixed

- The README demo image now uses an absolute `raw.githubusercontent.com` URL so it
  renders on the npm package page — relative paths don't resolve there, so the image
  showed broken on npmjs.com.

## [1.9.1]

### Fixed

- **Framework / non-visual DOM noise no longer registers as a change.** Capture now skips a built-in default set of selectors — `<meta>`, `<title>`, `<link>`, `<script>`, `<style>`, `<base>`, `<noscript>`, `<template>`, and `next-route-announcer` — merged into (not replaced by) the caller's `ignore`. These are elements frameworks stream into the body and reorder (Next.js app-router injects metadata then hoists it) or inject as live regions (Next's a11y route announcer), with no visual box to diff; their churn was surfacing as phantom DOM-added/removed findings on PRs that changed no CSS. A real stylesheet change still shows up in the affected elements' computed styles, not in the `<style>` tag. _Note: this changes the captured element set slightly — re-baseline once after upgrading._

## [1.9.0]

### Added

- **Deterministic captures with no per-repo fixtures.** `defineStyleMapCapture` now records each surface's data responses on the baseline run and replays them on the comparison run, so a diff reflects code, not live-data drift — a backend blip or a flipped status chip no longer reads as a style change on a PR that touched no CSS. Set `STYLEPROOF_REPLAY_FROM=<base dir>` on the head capture; only data URLs (`**/api/**`, configurable via `replayUrl` / `STYLEPROOF_REPLAY_URL`) are intercepted, so the app's own JS/CSS still load live and the captured run runs its own code. If the backend is down during a run, both sides replay the same recording — no phantom diff.
- **Frozen clock during capture** (`freezeClock`, on by default; `clockTime` to set the instant). Pins `Date.now()` / `new Date()` so time-derived styling (relative-age classes, "stale > 1h" flags) can't drift between runs; timers keep running so settling/polling still work.
- **Capture self-check** (`STYLEPROOF_SELFCHECK=1` / `selfCheck`). Captures each surface twice and fails with a clear _"non-deterministic capture"_ error (naming the drifting element) if the two differ — so a replay gap or unseeded randomness is caught at setup time instead of surfacing as a phantom change on an unrelated PR.

## [1.8.1]

### Fixed

- The crop annotation now boxes the **innermost** changed elements (the added
  avatars, the restyled cards) instead of the container the crop anchors on —
  whose box just traced the whole frame and told you nothing. An element present
  on only one side (added/removed) is boxed only there.

## [1.8.0]

The crop now shows you where to look — without painting over the UI.

### Added

- **Annotated crop, alongside the clean one.** Each crop shows the clean
  before|after composite by default (the real UI), with an annotated twin one
  click away under a `🔍 Highlight what changed` toggle — a thin magenta outline
  around each changed element on both sides, so the eye lands on exactly what the
  bullet named. Outline only (never filled), and the clean image right there
  proves the box isn't part of the design, so the marker can be confident without
  reading as a change.

### Changed

- **Tighter, more focused crops.** Default crop padding drops from 24px to 12px
  (the change fills more of the frame), and up to 8 crop regions per surface
  (was 6) before collapsing — so distinct changes get their own focused frame
  instead of one wide merged one. Both are still tunable (`pad`, `maxCrops`).
- The action now commits the annotated crops alongside the composites.

## [1.7.2]

### Fixed

- **Responsive variants of one change no longer show as duplicate sections.** A
  grid whose `grid-template-columns/rows` computes to different pixels per width
  (`282px ×2` vs `282px 228px`) was given a different signature per width, so the
  same change rendered once per breakpoint. The signature now keys grid tracks by
  their COUNT, so responsive widths collapse into one grouped section.
- The `e.g. …` fold line no longer names the `+N more` overflow marker as if it
  were a change.

### Fixed

- A colour bullet no longer repeats a role word that matches its token name
  (`text \`text\` (#bfe9f5)` becomes `` `text` (`#bfe9f5`) ``).
- When several same-label elements fold but share no change, the line names the
  most common changes (`e.g. … _(vary)_`) instead of an uninformative
  `restyled _(details vary)_`.

## [1.7.0]

Colour changes are named by their theme token, shown as hex with a live swatch,
and the bullets stay a glance.

### Added

- **Theme-token linking.** A colour change now names the design token behind it —
  ``background `red-100` (`#fee2e2`) → `red-200` (`#fecaca`)`` — not just the raw
  value. Computed styles lose the `var(--token)` reference, so the capture now
  records the colour-valued `:root` custom properties (`StyleMap.tokens`,
  normalised to `rgb`) and the report matches a changed value back to its token by
  value, preferring the scale step (`red-200`) over an alias.
- **Hex everywhere, with swatches.** Every colour renders as `#hex` (translucent
  ones stay `rgba`), in both the bullets and the property tables, so GitHub draws
  its live colour swatch next to each value in the PR comment.
- **Click any crop to enlarge.** Each before/after composite is wrapped in a link
  to the full-resolution image, so a click opens it full size to zoom.

### Changed

- **Tighter bullets.** Each element is capped to its few most-visible changes
  (then `+N more`); low-signal props (`font-family`, `letter-spacing`, …) are kept
  out of the count; near-identical same-label elements fold to one `×N` line with
  their shared changes (`details vary` when they don't match).
- **No more `white → white`.** When two colours round to the same word, the bullet
  shows just the hex so a subtle change doesn't read as a no-op.
- **Headline drops zero counts** (`0 state-delta difference(s)` was noise), and a
  grid that becomes flex no longer prints a confusing `columns: 3 → 0` — the layout
  rule names it.

## [1.6.0]

The report tells you what to look for, in plain English, and stops being a
spot-the-difference puzzle.

### Added

- **Plain-English change bullets.** Each crop now leads with a few bullets that
  name the change the way a person would — `**columns: 2 → 3**`, `becomes a
centered flex layout`, `corners squared off (50% → 8px)`, `recoloured light
yellow → cyan` — instead of a raw list of computed-style deltas. A deterministic
  rule set over the summarised properties (no LLM, no network); the exact
  before→after tables still live in the fold for when you want them. New
  `describeChange` / `colorName` helpers in `src/describe.ts`.

### Changed

- **Before/after crops line up exactly.** Both sides are now cropped from the
  SAME page rectangle (the union of where the change sits on each side), so the
  backgrounds align and the bullet tells you where to look — no more comparing
  two differently-framed screenshots.
- **Forced-state noise is gone.** The `:hover`/`:focus`/`:active` layer was
  drowning real changes in echoes — on one PR, 3135 "state-delta differences"
  across 8 elements. Now:
  - a state delta the **base style already changed** is suppressed (a `:hover
color` that just follows a recoloured base is an echo, not a dropped variant);
  - layout/grid-track props are stripped from state deltas (a forced relayout
    isn't interaction feedback);
  - a change between two "no value" markers (`— → (gone)`) is dropped — it never
    meant anything;
  - the `outline` shorthand no longer renders `(state no longer changes it)`
    three times in a row.
- `summarizeProps` drops no-op and non-value↔non-value rows, so counts and tables
  reflect only real, reviewable changes.

## [1.5.0]

Live regions are handled automatically, so a dashboard with streaming data,
tickers, or late-loading content no longer produces a false "everything
changed" report.

### Added

- **Auto-settle before capture (`stabilize`, default on).** The capture now
  polls the (motion-frozen) page until its computed-style map has been unchanged
  for a quiet window, so content that paints _after_ `go()` resolves — an async
  fetch, an SSE/WebSocket stream backfilling a grid — is captured loaded, not
  mid-load. This is what fixes the most common false positive: base and head
  racing an async load and diffing empty-state-vs-populated. Requiring a
  _sustained_ no-change window (not a single quiet sample) is what lets it wait
  through the gap before late content appears.
- **Automatic live-region detection.** Anything still changing on its own when
  the settle budget runs out is, by definition, nondeterministic (it mutates
  with no code change). Those element paths are recorded in `StyleMap.volatile`
  and excluded from the diff — unioned across both sides — so a stream or ticker
  never reads as a change, with no manual `ignore`. The report notes how many
  live regions were auto-excluded. Tune or disable via
  `captureStyleMap(page, { stabilize })` (`false`, or `{ interval, quietFor, timeout }`).

### Changed

- `diffStyleMapDirs` now returns a `volatile` count alongside `surfaces`/`counts`.
- Text-only churn (a clock, "2m ago") still never matters — the diff has always
  compared computed style, not text; this release adds the structural/layout
  determinism to match.

## [1.4.0]

New surfaces (present on only one side, no baseline to diff) are shown for
reference and never block the review gate.

### Fixed

- **A surface captured on only one side is now treated as a _new surface_, not a
  change.** Previously every one-sided surface counted as a DOM change, so a
  bootstrap PR (base branch has no capture spec yet → empty baseline) rendered a
  self-contradicting report — a `0 DOM change(s) · 0 … · 0 … across 0 distinct
change(s) in N surface(s)` headline sitting above N "re-run both captures"
  warnings, each with an approval checkbox that could turn the gate green on a
  capture set that has no baseline at all.

### Changed

- **New surfaces are shown, not blocked.** A surface present on only one side is
  rendered with its captured-side screenshot under a `🆕 new surface` heading,
  summarised on its own headline line (`🆕 N new surface(s) … don't block the
check`), and excluded from the change tallies. In review-gate mode it gets an
  **optional** `Approve this new surface` checkbox that the approve workflow
  deliberately ignores — so a new surface never holds the `StyleProof` status red.
  Real before↔after changes still gate exactly as before.
- **`styleproof-diff` exit codes:** `0` identical, `1` reviewable differences,
  `2` usage/capture error (unchanged), and new **`3`** = only new surfaces (no
  baseline to diff). The Action reports on `1` or `3` but only gates on `1`;
  certify mode (`fail-on-diff`) still fails on either, since "nothing changed"
  means the capture set didn't grow either.
- The Action `changed` output is now `"false"` for a brand-new surface with no
  baseline (it was a change before). `generateStyleMapReport` returns a new
  `newSurfaces` count alongside `changedSurfaces`.

## [1.3.1]

### Changed

- The before/after composite no longer draws coloured accent strips (grey for
  before, blue for after) above each crop. They were a font-free before/after
  cue, but a strip that differs between the two sides reads as a _second_ change
  in the pair. Now the only thing that differs across the composite is the actual
  change; before/after stays conveyed by position (left = before) and the caption.

## [1.3.0]

Clearer reports: one section per screenshot.

### Changed

- **The report is organised by crop, not by surface.** Each changed region of the
  page is its own section, headed by the element it is anchored on
  (`` `who-grid` · 7 elements restyled ``), and its before|after screenshot is
  followed by **only** the property changes that screenshot shows. A page with two
  unrelated changes (say a restructured grid and a lone button) used to render one
  screenshot, then another, then a single wall of tables you could not map back to
  either image; now every table sits under the crop it belongs to, and crops read
  top-to-bottom in page order.
- **Approval is per crop.** Because each crop is its own `###` section, the approval
  checkbox the Action injects is per visual region — sign off the grid and the
  button independently. A change that is identical across widths still collapses to
  one section, as before.
- **The property tables fold under a toggle, behind a one-line essence.** The
  screenshot and the approval checkbox always stay visible; below them a scannable
  one-liner names the top deltas (and flags hover/focus/active changes, which a
  static screenshot can't show), and the full before→after tables sit inside a
  `<details>`. New `foldDetailsAt` report option: the row count at which tables fold
  (default `0` = always; set `5` to keep small changes inline and fold only verbose
  ones, `Infinity` to never fold).

### Fixed

- Two distinct changes that shared a representative surface could collide on one crop
  image filename; crop images are now uniquely numbered across the whole report.

## [1.2.0]

Visual-review approval gate. StyleProof can now act as a per-PR review gate
("here is what changed visually — sign off if it's intentional") rather than only
a zero-diff refactor certifier.

### Added

- **`require-approval` Action input.** Instead of failing the job on any diff, the
  Action sets a `StyleProof` commit status: green when there are no visual changes,
  red ("needs sign-off") until the changes are approved. The report comment gains
  **one approval checkbox per change** — each distinct visual change is signed off
  on its own, and the gate goes green only when **every** box is ticked.
- **`example/styleproof-approve.yml`** — a template `issue_comment` workflow (copy
  to your default branch). As a write-access reviewer ticks the per-change boxes,
  it updates the `StyleProof` status ("2 of 3 approved") and flips it green only at
  full approval. Its trust model:
  - acts only on a **human edit** of the **bot's own** report comment
    (`comment.user.type == 'Bot'` and `sender.type == 'User'`), which excludes both
    the Action's own comment upserts and any attacker-authored comment;
  - **binds approval to the exact commit** the report was generated for (a
    `<!-- styleproof-sha -->` marker), so a push after the report can never inherit
    a green status — a new render re-opens the gate;
  - **verifies write access** (`getCollaboratorPermissionLevel`, fails closed)
    before moving the status. The marker is not the trust boundary — write access is.
- **`status-context` input** to rename the commit status (must match the approve
  workflow + branch protection).

### Changed

- The report no longer appends its own "regenerate the baseline" footer — the
  consumer (the Action, or your own wrapper) owns the call to action. This also
  removes the duplicate footer the Action used to add. `fail-on-diff` (legacy
  refactor mode) is unchanged and still the default.

## [1.1.0]

Report readability overhaul. No change to the capture format, the diff, or the
public API — `styleproof-diff` certification is byte-for-byte identical; only the
human-facing `styleproof-report` / `generateStyleMapReport` output changed.

### Changed

- **Group an identical change across surfaces into one section + one image.** A
  change that appears on every breakpoint of a responsive page (e.g. a new footer
  link across 7 landing widths) was repeated once per surface with a near-duplicate
  crop each time. Surfaces whose findings are identical now collapse into a single
  section that lists the affected surfaces (`landing @ 1280, 1080, 390 …`) and shows
  one representative crop (the widest). The summary counts distinct changes, not
  per-surface repetitions.
- **One heading per element.** An element's base, pseudo, and forced-state findings
  render under a single heading instead of a separate `DOM added` / `:hover` /
  `:focus` block each.
- **Newly-added elements read naturally.** A brand-new element has no meaningful
  "before", so its forced states render as a `State · Property · Value` table of the
  values it takes, instead of a `Before` column full of `(state does not change it)`.
- `outline-width`/`-style`/`-color` collapse into one `outline` row.

## [1.0.0]

First stable release and first publish to npm. The capture format, the public API
(`src/index.ts`), the three CLIs, and the GitHub Action are now considered stable under
semver. This release also lands the engine and packaging hardening below.

> **Upgrading from 0.x:** the pseudo-element pruning fix changes captured output for
> elements with pseudo-elements, so a baseline captured by an earlier version may show
> spurious diffs on first run — regenerate your committed baseline once after upgrading.

### Added

- Published to npm as `styleproof`; install with
  `npm i -D styleproof @playwright/test`.
- `styleproof-init` CLI: scaffold a starter capture spec (and `playwright.config.ts`) into
  any project.
- `styleproof-report` CLI flags `--pad`, `--max-crops`, `--min-width`, `--min-height`,
  `--include-layout-noise`; `-h`/`--help` on all three CLIs.
- `CaptureOptions.captureStates` (default true) and `CaptureOptions.maxInteractive`
  (default 800) to skip or cap the expensive forced-state layer on huge pages.
- `summarizeProps` and `prettyLabel` are now exported for downstream report builders.
- A real test suite (`node:test` unit tests + a self-contained Playwright smoke), a CI
  matrix (Node 18/20/22), and a provenance-signed release workflow.
- Full documentation set: complete README (API/CLI/Action reference tables, CI recipes,
  env-parity and determinism guidance, limitations, troubleshooting, a comparison vs
  pixel-snapshot tools), `CONTRIBUTING.md`, this `CHANGELOG.md`, plus
  `CODE_OF_CONDUCT.md`, `SECURITY.md`, and issue/PR templates.

### Fixed

- **Pseudo-elements are pruned against their own UA defaults**, not the host element's
  tag defaults — a pseudo-element's computed baseline differs from the element's, so the
  old pruning could both drop real changes and bloat the file. (Behaviour change; see the
  upgrade note above.)
- **CDP/page interactive-element count skew no longer aborts the capture.** It warns and
  skips only the forced-state layer for that surface (base + pseudo capture still
  succeed), and records `statesSkipped` on the map so a diff against a fully-captured side
  flags the gap loudly instead of reading as "identical".
- **Shadow DOM and iframe content** are surfaced with a one-time capture warning counting
  the shadow hosts / same-origin frames skipped, so the (still-present) non-traversal
  limitation is loud, not silent.
- Both `loadStyleMap`-backed CLIs now exit `2` with a file-naming message on a
  corrupt/truncated `.gz`, instead of a raw zlib stack trace.

### Changed

- Public API and capture/serialization format frozen under semver: a change to the map
  structure, an exported type, a CLI flag, or an Action input is now a versioned revision.
- The GitHub Action's report-branch push is re-derived from the current remote tip on each
  retry (concurrency-safe on a first-run race, no `rebase` unrelated-histories trap), and
  public-repo inline images get a `?v=<sha>` cache-bust so an overwritten crop can't serve
  stale from the CDN.

## [0.7.0]

### Added

- **Readable property tables in the report and PR comment.** The raw diff is a wall of
  longhands (one `border` change is 16 entries, one `color` change drags 8
  `currentColor` echoes); the report now renders per-element tables that collapse
  shorthand families (`border-width`/`-style`/`-color`, `border-radius`,
  `margin`/`padding` via CSS 1–4-value notation, `gap`), drop logical-property
  duplicates and `currentColor` echoes, fold repeated tokens (`368px ×3`) and round
  decimals, group identical sibling elements into one `×N` block, label by the semantic
  marker class (`div.who-grid`, `a.nav-cta`) instead of the structural path, and put
  each colour in its own cell so GitHub renders swatches.

### Changed

- The PR-comment action embeds these text tables (so they render even on private repos)
  instead of a raw diff dump; public repos also inline the images, private repos link
  them.
- Report header counts the collapsed total, not the raw longhand count.
- The certification differ (`styleproof-diff`) stays raw and complete — only the report
  collapses.

## [0.6.0]

### Changed

- **Reports crop the component, not the page.** A layout change reflows the page, so
  `height`/`width`/`transform-origin`/`perspective-origin` and `top`/`left`/`inset`
  shift all the way up the ancestor chain (`body`, `main`, `section`…). Those ancestors
  were becoming the "outermost changed element", so an organism-level change cropped to
  the entire page. The report now ignores size/position-derived longhands when choosing
  crop anchors and in its findings.

### Added

- `includeLayoutNoise: true` (`ReportOptions`) restores those longhands in the report.
  The certification differ keeps them unconditionally — a reflow is a change to certify.

## [0.5.0]

### Added

- **Orphan report branch with stable per-PR links.** Reports live on a `styleproof-reports`
  orphan branch (reports only, never your code); each run overwrites `pr-<n>/`, so the
  report URL is permanent for the PR's life and reports are never pruned.
- **Public/private image modes** via `inline-images: auto` — public repos embed
  composites directly in the comment (public raw URL); private repos link the committed
  `report.md`, whose relative images render through the viewer's authenticated session.
- Concurrency-safe additive pushes with a rebase-retry loop (different PRs touch
  different folders).
- A squash snippet in the README to reclaim orphan-branch git history without breaking
  current report URLs.

### Changed

- Leaner images: commit only the composite (not the separate before/after crops), and
  write PNGs lossless-but-lean — drop alpha (crops are opaque), max deflate, adaptive
  filtering (~15% smaller).

## [0.4.0]

### Fixed

- **Private-repo inline images.** The earlier action embedded `raw.githubusercontent`
  image URLs in the comment body; GitHub's Camo proxy fetches those anonymously, so they
  404 on private repos. The action now commits the report to a branch and **links** it
  from the comment — a committed file's relative images render inline through the
  viewer's authenticated session, like a private README's images. Fully automated,
  token-only, no browser, no public hosting.

### Added

- `report-url` output on the action.
- Path-safe crop filenames (`hero@1280` → `hero-1280`) so relative links resolve in any
  markdown host.

## [0.3.0]

### Changed

- **One composite image per change.** The report stitches each region's before/after
  crops into a single labelled image (before-left / after-right, divider, grey→blue
  accent bars as a font-free cue) and embeds that one image per change — one upload,
  reads cleanly inline.

## [0.2.1]

### Added

- `Surface.height` may be a function of width (`height?: number | ((width: number) =>
number)`), so each viewport band can capture at its own height. Default remains 800.

## [0.2.0]

### Added

- **Visual diff reports.** `styleproof-report` (and `generateStyleMapReport`) crop the
  before/after full-page screenshots around the outermost changed element (descendants
  fold into ancestors, nearby regions merge, both sides framed at identical dimensions)
  and write PR-comment-ready markdown with the exact property changes — `report.md`,
  `report.json`, and `crops/`. Uses `pngjs` only; no native deps.
- Captures now record each element's document-space bounding box, and the runner saves a
  full-page screenshot per capture (`screenshots: false` to opt out), so the committed
  baseline carries pixels and reports never rebuild the old code.
- `--json <file>` on `styleproof-diff`.
- A composite GitHub Action: diff against the committed baseline, publish crops, upsert
  a PR comment, flip it to ✓ when clean.

### Changed

- Diff core extracted to `src/diff.ts` with typed `Finding`s, shared by both CLIs.

## [0.1.0]

### Added

- Initial release, extracted from a production CSS-to-Tailwind migration (~680 lines
  certified to zero diff).
- `captureStyleMap` records every computed longhand on every element (pruned against
  per-tag UA defaults measured in a stylesheet-free iframe), the pseudo-elements
  `::before`/`::after`/`::marker`/`::placeholder`, declared transition/animation
  longhands (frozen so every other value is a settled end state), and forced
  `:hover`/`:focus`(`-visible`)/`:active` deltas via the Chrome DevTools Protocol.
- Maps are keyed by DOM structure, never class names, so a migration can rewrite every
  `class` attribute while the map stays comparable. Custom properties (`--*`) are
  ignored — inputs, not outcomes.
- `defineStyleMapCapture` generates one Playwright test per surface × width, inert until
  `STYLEMAP_DIR` is set; `saveStyleMap`/`loadStyleMap` persist `.json` or `.json.gz`.
- `styleproof-diff` CLI: certifies a refactor (exit 0) or names the exact element,
  property, and state that drifted (exit 1).

[Unreleased]: https://github.com/BenSheridanEdwards/StyleProof/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/BenSheridanEdwards/StyleProof/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/BenSheridanEdwards/StyleProof/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/BenSheridanEdwards/StyleProof/compare/v0.7.0...v1.0.0
[0.7.0]: https://github.com/BenSheridanEdwards/StyleProof/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/BenSheridanEdwards/StyleProof/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/BenSheridanEdwards/StyleProof/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/BenSheridanEdwards/StyleProof/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/BenSheridanEdwards/StyleProof/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/BenSheridanEdwards/StyleProof/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/BenSheridanEdwards/StyleProof/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/BenSheridanEdwards/StyleProof/releases/tag/v0.1.0
