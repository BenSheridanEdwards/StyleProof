# Changelog

All notable changes to **StyleProof** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/BenSheridanEdwards/styleproof/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/BenSheridanEdwards/styleproof/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/BenSheridanEdwards/styleproof/compare/v0.7.0...v1.0.0
[0.7.0]: https://github.com/BenSheridanEdwards/styleproof/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/BenSheridanEdwards/styleproof/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/BenSheridanEdwards/styleproof/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/BenSheridanEdwards/styleproof/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/BenSheridanEdwards/styleproof/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/BenSheridanEdwards/styleproof/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/BenSheridanEdwards/styleproof/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/BenSheridanEdwards/styleproof/releases/tag/v0.1.0
