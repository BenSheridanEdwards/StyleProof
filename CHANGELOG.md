# Changelog

All notable changes to **StyleProof** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.7.0] - 2026-07-04

### Added

- **Inventory guard** — StyleProof can now assert the navigable UI doesn't silently
  shrink. Opt in with `captureStyleMap(page, { inventory: true })` and each surface's
  navigable affordances — internal route links, `role=tab`, `role=menuitem`,
  button-only nav — are harvested (keyed stably) into `StyleMap.inventory`.
  `auditRunInventory(baseMaps, headMaps, allowRemoved)` unions the reachable set
  across the run and flags any affordance present on base but absent on head — a
  feature that stopped being reachable — as a **gating removal**, unless it's
  acknowledged in the `allowRemoved` ledger (`key → reason`; a stale acknowledgement
  is flagged so the ledger can't rot). Closes the certification diff's blind spot for
  the information-architecture / replacement class: a redesign staged as a new
  surface, or a nav item / route that disappears, which a same-surface computed-style
  diff catches only incidentally. **Off by default; the certification diff is
  unchanged.** See `docs/inventory-guard.md`.

## [3.6.0] - 2026-07-03

### Changed

- Crawl candidate collection collapses inherited-cursor subtrees to their
  OUTERMOST clickable. `cursor` is an inherited CSS property, so a clickable card
  makes every descendant compute `cursor: pointer`; each became its own candidate
  even though clicking any of them just bubbles to the card's handler (the same
  surface). Each redundant candidate paid a drive + verified reset — the dominant
  cost of a large crawl. Measured on a 241-class design: base candidates 557 → 22,
  whole coverage crawl ~40min → ~6min (240/241, unchanged). Semantic controls
  nested in a clickable container are still kept.
- `--until-covered` reaches deep coverage: it now terminates on the queue
  draining (or full coverage), not a fixed "N surfaces without a new class"
  plateau — a plateau cut the crawl off before a productive deep state (an
  automation whose expandable run row is its last candidate) was ever swept.
  Coverage mode also (a) prunes the queue to surfaces that add new render
  vocabulary — a structural repeat like the ninth agent's identical dossier is
  captured once but not re-drilled — and (b) uses the breadth-first queue rather
  than the depth-first in-place descent, so distinct components are reached fast
  and each drilled once via now-reliable resets. Measured on a 241-class design:
  240/241 (the one gap a post-decision state reachable only with a setup step),
  where a plateau-stopped crawl left the deep automation run-detail unmapped.

### Fixed

- Reset-replay to depth >= 2 no longer fails: the crawler's structural
  fingerprint counted StyleProof's OWN injected hover-sink `<div>` (added during
  a capture, so present when a state is captured in place but absent on a fresh
  reset+replay). Every such reset failed its fingerprint verification, so any
  surface reachable ONLY by re-driving from a deep state — a pairwise mode
  combination like a tab's edit view — was silently lost. The fingerprint now
  excludes the sink (and framework route-announcers). Measured: depth-2..5
  resets went from all-fail to all-pass.

### Fixed

- Report tables never show an equal-looking Before/After pair for a real diff.
  A colour embedded in a compound value (gradient, shadow) no longer stands in
  for the whole value — `toHex` only converts values that ARE a colour — and
  long value pairs (gradients, data URIs) are excerpted around the differing
  substring with a little shared context on each side.
- Report values render verbatim: display rounding of decimals is gone (alpha
  `0.18` was shown as `0.2`, and a real `0.18 → 0.2` change could be dropped
  as a no-op after rounding).

### Changed

- Crawl reset settle no longer waits on `networkidle`: it polls DOM-growth to
  detect the mounted app (unchanged) and then waits for `document.fonts.ready`
  specifically (fonts are part of the computed style the diff compares, so they
  must be loaded — but that is the deterministic signal, cache-warm on repeat
  loads). networkidle waited a 500ms idle window ON TOP of a cross-origin font
  sheet that lingered ~1s per load with no bearing on readiness; since every
  state reset re-navigates, that dominated crawl time. Measured: settle 911ms →
  105ms per reset (~8.7x), whole-crawl surface rate ~5/min → ~17/min.

- Crawl is now breadth-first (was depth-first): every shallow surface — nav
  tabs, opened panels, the tabs inside a dossier — is exhausted before drilling
  deeper. Depth-first starved breadth: one append-generator branch drilled past
  depth 20 while sibling tabs sat unvisited, so real surfaces (an OAuth card, a
  skills grid, a markdown editor) went uncaptured — measured live as 48 defined
  classes never rendered across ~12 surfaces. Dedup is set-based, so order
  changes only WHICH surface is found first, never the final set.
- `maxDepth` default 1000 -> 16: exhaustive for real UI (nothing human-navigable
  is 16 clicks from load) while terminating append-generator chains, whose every
  appended node is a fresh tag-path identity. The coverage verifier still names
  any class left unrendered, so a too-low cap fails loudly rather than lying.

- The never-click guard now also covers state-mutating verbs (rotate,
  provision, seal, regenerate, renew): mapping must not mutate, and a mutating
  control that persists after its click re-labels its surroundings with fresh
  data on every press — an unbounded mutation farm a crawl must not walk.
  Observed live: credential-rotation cells minted new identities per press,
  inflating a crawl past 470 surfaces at depth 23. Their render states are
  seed-data territory (and anything unreached is named by the verifier).
- Freshly-opened surfaces are swept IN PLACE (forward-drive), not only queued
  for a later reset+replay. Reaching a surface by a forward click is reliable;
  re-reaching it by reset is slow (a reset per candidate) and, at depth, starved
  — a dossier's many filter combinations flood the queue and bury the deep
  sweep, so an expanded run row inside an expanded job was captured 0 times
  despite being reachable (now 29). The descent drives only fresh controls new
  to the surface (excludes parent-present mode-switchers), so pairwise mode
  coverage is unchanged and the lattice stays pairwise.

### Added

- `--until-covered`: stop the crawl as soon as every class the page's
  stylesheets define has rendered (full coverage) or coverage stops improving
  (no new class for a plateau of surfaces). Turns an exhaustive crawl into a
  fast coverage check that stops once it has SEEN everything, instead of
  enumerating every combinatorial surface that adds no new vocabulary. Opt-in;
  exhaustive remains the default.

## [3.5.0] - 2026-07-02

### Added

- Parallel crawl: `--workers <n>` (default 4) sweeps queued states concurrently,
  each worker on its own browser context. The surface set is identical to a
  serial crawl — dedup sets are shared, and a state's children only join the
  queue when its sweep completes, so family retry never reads a half-built
  changer registry. Only dup-key suffix attribution can vary with timing; pass
  `--workers 1` for byte-stable keys. Exhaustive runs drop from hours to
  minutes on lattice-heavy designs.

## [3.4.0] - 2026-07-02

### Fixed

- Consuming actions (controls that disappear when used — resolve/approve/dismiss
  rows) no longer spawn a combinatorial decision lattice. Their result-states are
  captured and swept RETRY-ONLY: the parent's persistent mode-switchers still
  apply (a resolved list's tab view stays reachable), but no fresh candidates are
  collected there — removed rows shift sibling nth-of-type selectors, which made
  the same logical controls look "fresh" in every decided subset and could stall
  an exhaustive crawl for hours adding zero coverage. Found live, on a
  decision-heavy page whose crawl went 449 surfaces / 6 new classes before the
  rule; with it, the same shape converges in single digits with full coverage.

### Added

- `styleproof-capture --setup <file>`: deterministic steps (goto/fill/click/
  waitFor) run after every fresh navigation, so input-gated states — a login,
  an unlock code, seeded input — become crawlable. `${ENV_VAR}` in values is
  interpolated from the environment at load time, so credentials never live in
  the file or the maps; a failed non-optional step aborts loudly.
- Automatic data states: the crawl watches the entry page's data requests and
  additionally captures `loading` (requests stalled — the skeleton) and `error`
  (requests fulfilled with 500) out of the box. Identical-to-base renders dedup
  away; `--no-data-states` to skip.
- README: "What the crawler can and cannot reach — honestly" — the crawl
  vocabulary, what each state class is reached by, and the verifier contract
  that anything unreached is named, never silently missed.
- Automatic neutral-input fill: text/search/email/tel/url/number inputs and
  textareas are typed with a deterministic value, so input-driven states (a
  search's results, a filter's rendering) are crawled with no config.
  Credential-semantic fields (type=password, autocomplete username/
  current-password/new-password/one-time-code) are never auto-filled — that is
  `--setup` territory, the only input the tool cannot derive.
- Automatic scroll reveal: a bounded, deterministic scroll pass on every load
  mounts IntersectionObserver/lazy content before discovery, so scroll-gated
  sections are part of the mapped surface.
- The crawl now auto-detects the page's real `@media` breakpoints when no
  `--widths` are given (like the one-shot path), sweeping one width per band.
- `--setup` steps are honoured by the one-shot (non-crawl) capture too, so a
  gated page's single state is capturable directly.

### Fixed

- Automatic data states now intercept by resource type (fetch/XHR) instead of
  exact URL — apps that cache-bust their requests (`?t=...`) previously
  slipped past the stall and produced no `loading` capture.

## [3.3.0] - 2026-07-02

### Added

- New `styleproof-capture <url>` CLI: capture a single page (a deployed URL, a
  static export, or a standalone HTML mockup) so you can prove a production build
  renders identically to its design. Point it at the design and at the build,
  diff the two, and zero diff means pixel-identical — anything else is named down
  to the computed style. One shot, no spec, no config; writes the same
  `<key>@<width>.json.gz` (+ `.png`) shape any capture does, so `styleproof-diff`
  compares it against anything. Also exported programmatically as
  `captureUrlToDir` / `runCaptureUrl` / `parseCaptureUrlArgs`.
- `styleproof-capture --crawl`: map a whole interactive design from one URL with
  no spec and no selectors — EXHAUSTIVE by default, running until every
  non-destructive control has been driven once and every structurally new surface
  captured (a modal's tabs, a drawer's sub-views, a popover's panels), each under
  a derived key. The sweep works in place with lazy, fingerprint-verified resets:
  a no-op click costs nothing, only state-changing clicks pay a fresh
  navigation + replay, and children are never attributed to the wrong parent.
  Deterministic, deduped by a structural fingerprint, self-settling for async
  (React/Vue/Babel) apps, discovery pinned to one viewport width, progress
  streamed per captured surface, and destructive-looking controls are never
  clicked. `--max-depth` / `--max-actions` / `--max-states` exist only as
  throttles. Exported programmatically as `crawlAndCapture`.
- Crawl coverage verifier: after `--crawl`, every class the page's own
  stylesheets define (parsed CSSOM) is checked against the classes rendered
  across all captured surfaces, and the never-seen residue is printed — dead
  CSS, or a state the crawl could not reach. `--require-full-coverage` makes
  any residue exit 4, so "the design is fully covered, nothing missing" is a
  machine-checked property. On `CrawlReport.coverage` programmatically.

### Fixed

- GitHub Action reports now publish every generated crop PNG, including zoom
  crops, so committed `report.md` files do not point at missing images.

## [3.2.0] - 2026-06-30

### Added

- Added optional `styleproof-map --crawl-base-url ... --crawl-route ...` pre-map
  variant crawling, so automation can refresh the generated variant manifest
  immediately before map capture.

### Changed

- `styleproof-init` now writes a dedicated `playwright.styleproof.config.ts`,
  scopes discovery to the StyleProof spec, detects Vite/Next production preview
  commands, and respects pnpm/Corepack pins in generated commands.
- Map upload dirty-tree detection now ignores Next's generated `next-env.d.ts`
  shim, while normal source edits still block upload.

## [3.1.5] - 2026-06-29

### Added

- Added `harvestStyleVariants` and the `styleproof-variants` CLI to discover
  one-step UI state variants from a running app. The crawler tries semantic
  controls, keeps only actions that change computed styles, dedupes equivalent
  outcomes, and reports live-state candidates that need fixtures or opt-outs.
- **Captured maps now include semantic overlay proof metadata.** Visible dialog,
  menu, listbox, modal, popover, tooltip, and toast roots that are present in the
  captured DOM are recorded under `overlays`, filtered to paths that are actually
  in the computed-style map. Downstream suites can now assert that a popup map
  captured `role="dialog"`, `aria-modal`, `role="menu"`, `role="listbox"`, or
  hot-toast text instead of only asserting that a popup file exists.
- **Component inventory coverage is now available through
  `discoverComponentFiles`.** It scans explicit component roots across common
  framework file types and returns stable `component-*` keys, so teams can wire a
  Storybook/Ladle/custom catalog into `expected` and fail CI when a component file
  has no rendered StyleProof surface or reviewed exclusion. `componentCatalogSurfaces`
  turns the same inventory into catalog URL capture surfaces so the surface list
  and expected list cannot drift apart.

### Changed

- **`styleproof-init` now points modal, popover, menu, tab, and form-error
  captures at `variants`.** The generated generic spec includes commented
  `dialog-open` and `popover-open` examples under the base surface, so app-owned
  UI states compare state-to-state instead of becoming orphan root surfaces.
- **The coverage guard now checks expanded variant keys.** Projects can put
  required states such as `dashboard-user-menu-open`, `dashboard-toast-visible`,
  or component catalog keys in `expected`; StyleProof fails unless those exact
  surfaces are captured or explicitly excluded.
- **Non-live variants now keep the base capture.** Dialog, menu, popover, toast,
  and overlay captures augment the owning surface instead of replacing its normal
  page capture. `liveStates` continue to model explicit pinned live states.
- **Automatic popup capture now treats modal attributes, dropdown roles, and
  toast roots as default overlay candidates.** The default selector includes
  `[aria-modal="true"]`, `role="menu"`, `role="listbox"`, hot-toast/Sonner-style
  toast markers, and status/alert toast roots. Popup matching also compares a
  semantic/text signature, so a reused mount or toast host can still be captured
  when its visible state changes.

### Fixed

- Computed-style diffs now ignore sub-pixel `transform-origin` and
  `perspective-origin` jitter while still reporting meaningful origin changes.

## [3.1.4] - 2026-06-29

### Changed

- New surfaces now require approval in review-gate mode. A new-surface-only diff
  still exits `3`, but the Action marks `changed=true`, posts the report, and
  holds the `StyleProof` status red until the reviewer approves it. Certify mode
  was already strict because it fails on any report.

### Fixed

- **Popup capture no longer collapses distinct triggers that reuse the same
  overlay mount.** Each visible trigger slot that opens a persistent overlay now
  gets its own `<surface>-popup-XX` map, so separate modals or menus rendered at
  the same DOM path are captured instead of being deduped away.

## [3.1.3] - 2026-06-29

### Added

- **Optional automatic popup capture.** `defineStyleMapCapture` and
  `defineCrawlCapture` now accept `popups: true` or `{ max, triggers, overlays,
timeoutMs }`. When enabled, StyleProof clicks visible safe triggers after each
  base surface capture and saves persistent dialogs, popovers, menus, listboxes,
  tooltips, and open data-state overlays as `<surface>-popup-XX` captures with
  popup labels in reports.
- **Local-first reusable map bundles are now the default v3 flow.** `styleproof-map`
  writes `.styleproof/maps/current`, records a `styleproof-manifest.json` with the
  commit SHA and capture compatibility key, and uploads the bundle to a dedicated
  `styleproof-maps` branch when the working tree was clean and a git remote is
  available. The upload happens from the explicit `styleproof-map` command, not
  from a git hook, so generated maps no longer enter PR branch history.
- **The report now surfaces tiny changes by default.** Every changed region shows
  the clean before/after crop **and** a highlighted twin (magenta boxes marking each
  change) without expanding anything, and names the changed element next to the image
  (e.g. `changed: span.caret`). When the changed element's footprint is small
  (≤ `zoomBelow`, default 64px) a magnified zoom crop is added so a sub-pixel change
  (e.g. a 2px caret bump) is obvious at a glance instead of hiding in a collapsed
  section. New `zoomBelow` report option tunes or disables it. ([#97](https://github.com/BenSheridanEdwards/StyleProof/issues/97))

### Changed

- **`styleproof-init` no longer generates or activates a pre-push hook.** It now
  scaffolds `.gitignore` cache entries and a cache-first PR workflow that restores
  base/head maps from `styleproof-maps`, runs the full StyleProof report action
  when both bundles are present, and recaptures both sides in CI only on cache miss
  or incompatible cache.
- **`styleproof-diff` and `styleproof-report` now default to cached maps by commit
  SHA.** No-arg and single base argument usage restores base/head bundles from the map
  store, while explicit `<beforeDir> <afterDir>` usage remains for CI fallback
  captures and custom comparisons. The old committed-map `--base-ref`/`--maps-dir`
  mode is removed from v3 so generated maps no longer have any supported path into
  PR branch history.

### Fixed

- `styleproof-diff` and report generation now ignore `styleproof-manifest.json`
  when discovering surface map files, so manifest-backed bundles do not get parsed
  as captures.

## [3.1.2] - 2026-06-28

### Added

- Documented the sound way to skip StyleProof work: skip the **entire** CI
  workflow for docs-only / non-rendered paths with native path filters, but do
  not skip individual surfaces based on changed-file guesses.

### Fixed

- **Live-region detection now respects the surface's `ignore` list.** A region
  the caller ignored was still scanned for `aria-live`/`role` and surfaced (and
  persisted into the committed map) as a live-state candidate, unlike every other
  capture pass which honours the merged `ignore`. Ignored regions are now excluded
  from `liveCandidates` too.
- **The scaffolded CI workflow no longer blocks PRs that only add new surfaces.**
  `styleproof init` generated a workflow that failed on any non-zero diff exit
  code, so a new-surface-only diff (exit `3`) held the check red and the PR
  receipt claimed "Visual changes detected" — contradicting the documented
  contract that new surfaces never block. The gate now fails only on reviewable
  diffs (exit `1`) and errors (exit `2`), matching `action.yml`, and the receipt
  reports new surfaces explicitly.
- **A truncated forced-state layer is no longer silently certified as
  identical.** When a surface had more interactive elements than
  `maxInteractive`, capture truncated the `:hover/:focus/:active` layer but left
  `statesSkipped` unset, so the uncaptured states read as "identical" against a
  fully-captured side — the exact false-certification the flag exists to prevent.
  Truncation now sets `statesSkipped`, and the diff reports the layer as "not
  fully captured" on the affected side.
- **Release workflow no longer passes an empty `body_path` to the GitHub Release
  step.** Previously a release whose CHANGELOG version section was absent (e.g. a
  hotfix tag with no entry) passed `body_path: ''`, which `softprops/action-gh-release`
  treats as a file to read and fails with ENOENT instead of auto-generating notes.
  The step is now split into two mutually-exclusive steps: one with
  `body_path: notes.md`, one with `generate_release_notes: true`.

## [3.1.1] - 2026-06-27

### Changed

- **Release workflow now verifies npm publication before tagging.** A release
  fails before creating tags or GitHub Releases if `NPM_TOKEN` is missing, and
  it verifies `styleproof@<version>` on npm after publishing or detecting an
  already-published version.
- **Generated pre-push hooks now restore no-op map churn before committing.** The
  hook captures through `styleproof-map`, runs a semantic diff against `HEAD`, and
  restores `stylemaps/` when the refreshed map is identical. When the map really
  changes, the hook prints the diff plus a concrete live-state/replay hint before
  creating the map commit.

### Fixed

- **Real cursor hover no longer contaminates the resting style map.** Capture now
  parks the mouse over an ignored 1px hover sink before reading, matching the
  existing focus blur behavior. The canonical resting map stays unhovered while
  the forced `:hover` layer still records the hover delta.
- **`styleproof-map` now writes lean committed maps by default.** Recorded HAR
  files are removed after successful capture so private API responses are not
  accidentally committed by the default pre-push flow. Use `--keep-har` or
  `STYLEPROOF_KEEP_HAR=1` for explicit record/replay workflows.
- **Generated pre-push hooks now clean untracked no-op artifacts.** When the
  refreshed map is semantically identical to `HEAD`, the hook restores tracked
  `stylemaps/` files and removes untracked files under `stylemaps/current`, so a
  clean push leaves no generated capture debris behind.

## [3.1.0] - 2026-06-27

### Changed

- **`styleproof-init` now follows the repo's package manager.** Generated
  Playwright configs, pre-push hooks, and browser-less CI workflows detect
  `bun.lock`/`bun.lockb`, `pnpm-lock.yaml`, `yarn.lock`, or `package-lock.json`
  and scaffold matching build, install, `styleproof-map`, and `styleproof-diff`
  commands instead of assuming npm everywhere.
- **The committed-map flow is now a three-command CLI path.** Run
  `styleproof-init`, `styleproof-map`, then `styleproof-diff`. `styleproof-map`
  captures the current branch into `stylemaps/current`, while `styleproof-diff`
  now defaults to that map directory and infers the base ref from GitHub Actions,
  `branch.<name>.gh-merge-base`, `origin/main`, `origin/master`, `main`, or
  `master` (or accepts `styleproof-diff main` / `--base-ref main`). The zero-diff
  success line says `0 changed surfaces across N captured surface(s)` instead of
  the confusing `N surfaces identical` / `0 surfaces identical` wording, and the
  `--json` payload includes `compared` so consumers can show the same count.
- **`styleproof-report` now mirrors the diff CLI defaults.** Run
  `styleproof-report` with no args to generate the side-by-side report from
  `stylemaps/current` against the inferred base branch, or pass
  `styleproof-report main` / `--base-ref main` to pin the base while keeping the
  committed-map directory default.
- **No-arg diff/report now understand stacked PRs locally.** After
  `GITHUB_BASE_REF` and explicit `branch.<name>.gh-merge-base` config, the shared
  base-ref inference asks `gh pr view` for the current PR base before falling back
  to `main`/`master`, so stacked branches compare against their real review base
  out of the box.

### Fixed

- **CLI errors now lead with the recovery step.** Missing specs, unknown flags,
  absent working maps, and missing committed base maps now print a concrete
  `Next:` line such as `run styleproof-map`, pass `--maps-dir <dir>`, or commit
  captures on the base branch.
- **`styleproof-map` now runs generated capture tests correctly.** The CLI no
  longer passes the spec path as a Playwright file filter, because StyleProof's
  generated tests are registered through the package runner. It now targets the
  capture suite with Playwright's grep path, matching the public
  `styleproof-init` → `styleproof-map` → `styleproof-diff` flow.
- **Clean StyleProof PR runs now leave a visible receipt.** The Action creates or
  updates its PR comment with `No visual changes detected.` even when there is no
  existing report comment yet, and `styleproof-init` scaffolds the same
  no-change PR comment for the browser-less committed-map workflow.
- **Layout-equivalent auto-margin drift no longer creates phantom diffs.** Some
  browser/forced-state combinations can report horizontal `margin-left` /
  `margin-right` / logical margin equivalents differently even when the captured
  document-space rectangle is unchanged. StyleProof now drops only those
  margin-longhand differences when the element's rect is identical on both sides,
  including inside forced `:hover`/`:focus`/`:active` deltas. If the rect moves,
  the margin change still reports.

## [3.0.2] - 2026-06-27

### Fixed

- **The composite Action now builds its checked-out source before running local
  bins.** Because `dist/` is intentionally gitignored, the v3 Action ref could
  install runtime dependencies and then fail when `bin/styleproof-report.mjs`
  imported `../dist/report.js`. The Action runtime now installs the checkout's dev
  toolchain with scripts disabled, runs `npm run build`, and executes the checked-out
  entrypoints from that built source.

## [3.0.1] - 2026-06-27

### Added

- **First-class live states plus generic variants.** `Surface` now accepts
  `liveStates`, each captured as `<surface>-<state>` with optional `setup`, `go`,
  `widths`, `height`, and `ignore` overrides. This lets a spec certify both
  `loading` and `loaded` (or `empty` / `error`) on the base branch and feature
  branch, then compare matching states directly instead of relying on one moving
  live page state. Reports label those captures as live states. Generic `variants`
  remain available for non-live states such as nav-open or modal-open. `defineCrawlCapture`
  accepts both and applies them to every discovered link surface.
- **Semantic live-state candidates are auto-detected.** Captures now record
  diagnostic metadata for `[aria-live]`, implicit live-region roles such as
  `role=status` / `role=alert`, and `aria-busy=true`. Stable candidates are still
  captured and compared by default; only regions that actually keep changing are
  excluded as volatile.

### Changed

- **Self-check diagnostics now call out volatile root layout drift.** When a
  capture contains volatile regions and the repeated self-check differs on
  `html`/`body` layout properties, the error explains that ignored/live content can
  still move document flow, includes any auto-detected live-state candidates, and
  points users to deterministic `liveStates`.
- **Release proof now matches CI before publishing.** The release workflow and
  `prepublishOnly` gate now include format checking plus browser e2e coverage before
  npm publication, so a version cannot publish ahead of the full package proof gate.

### Fixed

- **The composite Action now executes the checked-out Action version.** Report jobs
  install StyleProof's runtime dependencies under `GITHUB_ACTION_PATH` and invoke the
  local `bin/styleproof-*` entrypoints, so `uses: BenSheridanEdwards/StyleProof@v3`
  cannot drift to a consumer workspace install or npm's latest package.

## [3.0.0] - 2026-06-27

**Milestone: the committed-map gate is how StyleProof works now.** Capture runs
**pre-push** (parallel, with auto-detected `@media` breakpoints), the lean computed-
style map is committed and **pushed in a single `git push`**, and CI is a
**browser-less diff** of two precomputed maps — measured ~5400× cheaper on the
compare step, and it skips build + serve entirely. `styleproof-init` scaffolds **and
activates** the whole gate in one command. Coverage stays **full and sound**: every
surface is captured (parallelised) and what changed is determined by _measuring_ the
map, never by guessing which pages a code change touched. **No breaking API changes**
— existing specs and the classic capture-both-in-CI flow keep working unchanged; the
major marks the new default paradigm.

### Changed

- **`styleproof-init` now activates the pre-push hook for you** (`git config
core.hooksPath .githooks`), so a single `styleproof-init` is all it takes — no
  follow-up command. It never clobbers a repo that already manages hooks: if
  `core.hooksPath` is already set or a `.husky/` dir exists, it leaves them alone and
  prints the one-liner instead.

## [2.5.0] - 2026-06-26

### Changed

- **`styleproof-init` scaffolds parallel surface capture (`fullyParallel: true`).**
  StyleProof emits one test per surface × width, each an isolated page writing a
  uniquely-keyed file — independent and safe to run concurrently. Without
  `fullyParallel`, all surfaces sit in one spec file and capture **serially**; with it
  they fan out across workers. Measured: 6 surfaces went from 12.3 s (1 worker) to
  4.9 s (4 workers) — **~2.5× faster**, byte-identical output. Profiling confirmed the
  single-capture path is correctness-bound (the settle is a deterministic wait; forced
  states must be isolated per element), so parallelism across surfaces — not
  micro-optimising one capture — is the real lever.

### Added

- **Dogfood: StyleProof certifies its own demo page in CI.** A new
  `example/demo/index.html` plus `test/dogfood.e2e.spec.ts` run the full
  capture → detect → diff pipeline on a real multi-element page every CI run:
  auto-detection finds the demo's `@media` breakpoints, two captures certify
  identical (determinism), and a planted restyle is caught. `test:e2e` now runs the
  whole `*.e2e.spec.ts` suite. (Repo-only; `example/` isn't in the published package.)

- **`npm run bench` — measures the committed-map gate's CI speedup.** A reproducible
  benchmark of one in-browser capture vs one precomputed-map diff, projected to a
  sample app. On the dev fixture: capture ≈ 1 s/surface-width, diff ≈ 0.4 ms — so the
  per-PR compare step is ~1000s× cheaper, before counting the build + serve the
  committed-map CI also skips. (Internal tooling; not shipped in the package.)
- **The Action and `styleproof-report` support `--base-ref`.** The committed-map gate
  now gets the full review experience, not just a bare diff: pass `base-ref` to the
  Action (e.g. the PR base branch) and point `fresh-dir` at your committed maps — it
  reads the base from git and produces the same before/after report + approval gate,
  with no recapture. `styleproof-report --base-ref <gitref> <mapsDir>` does the same
  on the CLI. The git-materialisation is now a shared `materializeRef` (in `gitref`)
  used by both `styleproof-diff` and `styleproof-report`. `baseline-dir` is no longer
  required when `base-ref` is set.

## [2.4.0] - 2026-06-26

### Added

- **Automatic breakpoint detection — `Surface.widths` is now optional.** Omit it and
  StyleProof reads the app's real viewport breakpoints from the loaded CSSOM at
  capture time and sweeps one width per `@media` band — no config, no guessing.
  Because it reads the browser's parsed stylesheets (not your source), it's
  framework-agnostic: Tailwind, CSS Modules, styled-components, Sass and vanilla all
  resolve to the same `@media` rules. It is authoritative **or it fails**: an
  unreadable cross-origin stylesheet throws (so a band is never silently missed)
  rather than guessing. `min/max-width` and range syntax (`width >= …`) are handled,
  `em`/`rem` resolved against the root font size; container/print/height queries are
  correctly ignored. Set `widths` explicitly to pin the sweep or to cover a JS-only
  (`matchMedia`) breakpoint that has no CSS rule. New exports: `detectViewportWidths`,
  `mediaTextWidthBoundaries`, `widthsFromBoundaries`. **`styleproof-init` now scaffolds
  surfaces with no `widths`**, so a fresh project gets zero-config breakpoint detection
  by default.
- **Out-of-the-box committed-map gate — capture pre-push, CI just diffs.**
  `styleproof-init` now scaffolds the whole flow as the default: a **pre-push hook**
  (`.githooks/pre-push`) captures this branch's computed-style map against a
  production build, commits it as a lean `.json.gz` under `stylemaps/`, and **pushes
  it with your branch — one `git push`, never two** (the hook pushes the map commit
  itself, because git would otherwise send only the pre-hook commit); and a
  **browser-less CI workflow** that just diffs the committed map against the base. So
  `main` always carries a base map and every PR is a fast comparison of precomputed
  maps, never a recapture. (Capture belongs pre-push because it needs the app built +
  served; the same-environment requirement is self-enforced by the self-check.)
- **`styleproof-diff --base-ref <gitref>` — diff against a committed base in git.**
  `styleproof-diff --base-ref main <mapsDir>` materialises the captures committed at
  `<mapsDir>` as of `main` and diffs them against your working `<mapsDir>` — the CI
  half of the gate above. Reads the base purely through git (`ls-tree`/`show`, no
  `tar`/deps; binary `.json.gz` preserved), into a temp dir cleaned up after.
- **`STYLEPROOF_BASEDIR` / `STYLEPROOF_SCREENSHOTS` env knobs** (same wiring style as
  `STYLEPROOF_REPLAY_*`): redirect capture into a committed dir and drop screenshots
  for lean, commit-friendly maps — without editing the spec. This is what lets the
  pre-push hook capture committed maps from the stock generated spec.

## [2.3.1] - 2026-06-23

### Fixed

- **Animation freeze is now deterministic for content that mounts during the
  settle.** Motion longhands (declared `animation`/`transition`) were read _before_
  the settle, so an element that mounts while the page settles — a status glyph
  gated on a snapshot fetch — missed that read: its declared `animation-duration`
  was folded back on a run where it mounted early but left frozen to `0s` on a run
  where it mounted late, surfacing as a self-check `animation-duration: 0s ↔ 1.6s`
  non-deterministic failure. Motion is now read on the settled DOM (the freeze is
  lifted only for that read), so a late-mounted animated element is captured
  identically every run.

## [2.3.0] - 2026-06-23

### Added

- **`defineCrawlCapture` — discover surfaces by crawling rendered links.**
  `discoverNextRoutes` reads the filesystem, so it only sees one surface per
  `app/**` page — blind to a single-route SPA whose views are query params
  (`/?tab=overview`) or client-routed, which exist only in the rendered nav as its
  links. `defineCrawlCapture({ from, match, widths, dir })` loads a root URL, reads
  its same-origin `<a href>`s (filtered by `match`), and captures each as a surface
  keyed from its URL (`/?tab=overview` → `overview`; override with `key`). The
  surface set _is_ the nav, so there's no hand-maintained `surfaces` list to drift
  out of sync. The app just has to render its nav as real links — a button-only nav
  exposes nothing to crawl. Replay, self-check and clock-freeze behave exactly as
  for explicit surfaces. Also exported: `selectCrawlLinks` / `defaultLinkKey` (the
  pure link-selection helpers) and the `CrawlOptions` / `CrawlLink` / `LinkMatch`
  types.

## [2.2.0] - 2026-06-23

### Added

- **Newly-added elements now report their full resting computed style**, not just
  interaction-state deltas. Previously an added element surfaced only its
  `:hover`/`:focus` changes (the diff short-circuited added elements before the
  style loop); its background, padding, font, radius, etc. were captured but never
  shown. The diff now emits the new element's full style as `(unset) → value`
  findings and the report renders them value-only (no bogus "Before" column), in
  both the PR report and the `styleproof-diff` CLI. The element already gated via
  its `added` finding, so this enriches detail without changing what gates.
- **`captureComponent` (opt-in, default off): surface the React component + props**
  behind each element. With it on, capture reads the React fiber in-page
  (`__reactFiber$*`/`__reactProps$*` on React 17+, `__reactInternalInstance$*` on
  ≤16) to record the component display name and a sanitized subset of its props
  (primitives only; `children`/handlers/objects dropped) on `ElementEntry.component`.
  The report names it — `React component: Button (variant=primary, size=sm)` —
  instead of a bare `<button>`. **Advisory only**, exactly like the content layer:
  never fed to the certification diff or its blocking counts, so captures stay
  deterministic. Names are mangled in minified prod builds, so it's most useful
  against dev/non-minified output; a no-op on non-React pages.

## [2.1.0] - 2026-06-23

### Added

- **Coverage guard (`expected` / `exclude`).** `defineStyleMapCapture` now accepts
  `expected` — the app's route/view universe — and emits a guard test that fails
  when a route has no captured surface and isn't in `exclude`. It runs in the
  normal test suite (no `STYLEMAP_DIR`, no browser — a static check), closing the
  one hole captures can't catch on their own: a new page nobody added to
  `surfaces` is invisible to the diff (no base capture, no head capture), so the
  gate goes green having never looked at it. `exclude` is a `key → reason` ledger
  of deliberate opt-outs; a key absent from `expected` (a renamed/removed route)
  fails the guard too, so the ledger can't rot. Omit `expected` and behaviour is
  unchanged. The pure `coverageGaps(captured, expected, exclude)` helper is also
  exported. Closes the class of regression where a brand-new view's styles ship
  uncaptured because the surface list silently drifted from the app's routes.
- **Coverage guard works out of the box for Next.js.** New `discoverNextRoutes()`
  reads the App Router (`app/`) and Pages Router (`pages/`) at run time and returns
  `{ key, path, dynamic }[]` (route groups/slots stripped, `[param]` flagged). `styleproof-init`
  now detects a Next.js app and scaffolds a spec that wires both the surfaces and
  `expected` to it — so a fresh install is protected without hand-wiring, and a page
  added later is covered automatically. Non-Next projects get the previous starter
  surface plus a commented guard block to point at their own route registry.
- **Network-aware settle (default on).** The settle now holds while the page's own
  data requests are in flight — excluding long-lived `EventSource`/WebSocket streams
  (handled by the live-region pass) — instead of only waiting for the computed-style
  map to go quiet. So late-fetched content is captured **loaded, not mid-load**, and
  the settle can't false-settle on a loading state before a slow backend responds —
  the phantom-diff / self-check flake that a fixed wait produces under CI load. New
  exported `trackInflightRequests(page)` arms the tracker; `defineStyleMapCapture`
  arms it before each `go()` automatically.
  Opt out with `stabilize.waitForRequests: false`.
- **`styleproof-init` scaffolds a production-build web server.** The generated
  `playwright.config.ts` now includes a `webServer` that runs
  `npm run build && npm run start` (reusing a server already up), so a fresh project
  captures against a production build by default instead of a `next dev`-style server
  whose JIT timing variance is the top source of capture flakes.

### Changed

- **`selfCheck` defaults on while recording, off on replay.** The determinism guard
  (capture twice, fail on drift) was opt-in (`STYLEPROOF_SELFCHECK=1`), so by default
  nondeterminism shipped silently as a phantom diff. It now defaults **on when
  recording** (no `replayFrom`), where live nondeterminism surfaces, and **off on
  replay**, which is deterministic by construction — so a fresh
  `defineStyleMapCapture({ surfaces })` auto-detects and names nondeterminism with no
  2× cost on the replay run. `STYLEPROOF_SELFCHECK=1` still forces it on for both;
  `selfCheck: false` opts out.
- **`styleproof-init` scaffolds a minimal `settle()`.** Now that the engine's
  network-aware settle waits out in-flight data and fonts, freezes animations, and
  blurs focus, the generated helper drops the hand-rolled `document.fonts.ready`,
  animation-freeze, fixed `waitForTimeout`, and `networkidle` wait (the last an
  active trap — it never fires against an SSE stream). It keeps only what the engine
  can't know about — scroll-reveal — and `go()` is a plain `page.goto(...)`.

## [2.0.0] - 2026-06-22

### Changed

- **Single approval box is the only review-gate UI.** The report comment carries
  one **Approve all changes** checkbox — one tick signs off every change. The
  per-change boxes (and the `approve-all` input that opted into the single box) are
  gone. **Breaking:** a review-gate consumer on the old per-change
  `styleproof-approve` workflow must replace it with the updated
  `example/styleproof-approve.yml` — the old one counts `Approve this change` boxes
  that no longer exist, so it would never turn the status green.
- **Lean PR comment; the committed report is the complete source of truth.** The
  comment is now a summary + the approval box + a link to the side-by-side report.
  Before/after crops and per-element property tables live only in the report, so
  the comment and report can't drift and the comment renders identically on public
  and private repos. **Breaking:** the `inline-images` input is removed (the comment
  no longer embeds images).

### Added

- **Approver attribution.** When a reviewer ticks **Approve all changes**, the
  comment shows _approved by @them_ inline and the commit-status description reads
  `Approved by @them`. The status is the source of truth, so a later report re-run
  (e.g. to clear a blocking check) reconstructs the attribution instead of losing it.
- **`styleproof.config.json` policy file + `blocking`.** An optional repo-root file
  for gate _policy_, separate from the Action's workflow-_plumbing_ inputs.
  `"blocking": true` makes review-gate mode also **fail the job** on unapproved
  visual changes, so the check is red even without a branch-protection rule
  requiring the status — the blocking option for free private repos. Asynchronous by
  design: tick **Approve all changes**, then re-run the job; the re-run reads the
  sign-off from the commit status and passes instead of clobbering it.

## [1.10.0] - 2026-06-22

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

- **Real focus no longer makes `:focus` capture nondeterministic.** Capture froze
  motion (`FREEZE_CSS`) and the clock but never neutralised real DOM focus, so
  whatever element happened to hold focus at capture time (autofocus, late
  hydration, a stray prior action) contaminated the capture across runs: it baked
  a focus ring into the resting `elements` map, and it cancelled the forced-state
  `:focus` delta — forcing `:focus` on an already-focused element changes nothing,
  so the ring showed up as a delta on some runs but not others, surfacing as a
  self-check `outline-color: … → (state does not change it)` failure on a no-op
  PR. `captureStyleMap` now blurs the active element before any read, mirroring
  the motion freeze; `:hover`/`:focus`/`:active` are still certified
  deterministically via CDP `forcePseudoState`.
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

[Unreleased]: https://github.com/BenSheridanEdwards/StyleProof/compare/v3.2.0...HEAD
[3.2.0]: https://github.com/BenSheridanEdwards/StyleProof/compare/v3.1.5...v3.2.0
[3.1.5]: https://github.com/BenSheridanEdwards/StyleProof/compare/v3.1.4...v3.1.5
[3.1.4]: https://github.com/BenSheridanEdwards/StyleProof/compare/v3.1.3...v3.1.4
[3.1.3]: https://github.com/BenSheridanEdwards/StyleProof/compare/v3.1.2...v3.1.3
[3.1.2]: https://github.com/BenSheridanEdwards/StyleProof/compare/v3.1.1...v3.1.2
[3.1.1]: https://github.com/BenSheridanEdwards/StyleProof/compare/v3.1.0...v3.1.1
[3.1.0]: https://github.com/BenSheridanEdwards/StyleProof/compare/v3.0.2...v3.1.0
[3.0.2]: https://github.com/BenSheridanEdwards/StyleProof/compare/v3.0.1...v3.0.2
[3.0.1]: https://github.com/BenSheridanEdwards/StyleProof/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/BenSheridanEdwards/StyleProof/compare/v2.5.0...v3.0.0
[2.5.0]: https://github.com/BenSheridanEdwards/StyleProof/compare/v2.4.0...v2.5.0
[2.4.0]: https://github.com/BenSheridanEdwards/StyleProof/compare/v2.3.1...v2.4.0
[2.3.1]: https://github.com/BenSheridanEdwards/StyleProof/compare/v2.3.0...v2.3.1
[2.3.0]: https://github.com/BenSheridanEdwards/StyleProof/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/BenSheridanEdwards/StyleProof/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/BenSheridanEdwards/StyleProof/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/BenSheridanEdwards/StyleProof/compare/v1.10.0...v2.0.0
[1.10.0]: https://github.com/BenSheridanEdwards/StyleProof/compare/v1.9.4...v1.10.0
[1.9.4]: https://github.com/BenSheridanEdwards/StyleProof/compare/v1.9.3...v1.9.4
[1.9.3]: https://github.com/BenSheridanEdwards/StyleProof/compare/v1.9.2...v1.9.3
[1.9.1]: https://github.com/BenSheridanEdwards/StyleProof/compare/v1.9.0...v1.9.1
[1.9.0]: https://github.com/BenSheridanEdwards/StyleProof/compare/v1.8.1...v1.9.0
[1.8.1]: https://github.com/BenSheridanEdwards/StyleProof/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/BenSheridanEdwards/StyleProof/compare/v1.7.2...v1.8.0
[1.7.2]: https://github.com/BenSheridanEdwards/StyleProof/compare/v1.7.1...v1.7.2
[1.7.0]: https://github.com/BenSheridanEdwards/StyleProof/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/BenSheridanEdwards/StyleProof/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/BenSheridanEdwards/StyleProof/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/BenSheridanEdwards/StyleProof/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/BenSheridanEdwards/StyleProof/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/BenSheridanEdwards/StyleProof/compare/v1.2.0...v1.3.0
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
