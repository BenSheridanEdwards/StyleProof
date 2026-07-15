# Changelog

All notable changes to **StyleProof** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [4.5.1] - 2026-07-15

### Added

- **`styleproof-ci --spec-ref <ref>`**: on a cold base capture, when the base commit
  already contains the configured `--spec` path, overlay that file's bytes from
  `<ref>:<spec>` for the base render only (app source and lockfile stay at `--base`).
  The overlay is hidden from the dirty-tree gate with a narrowly scoped
  `assume-unchanged` index flag and is always cleared before the head checkout,
  including after a failed base capture. Omitted `--spec-ref` preserves 4.5.0 behavior.
  Invalid refs, missing specs at the ref, or absolute/out-of-repo spec paths fail loudly.

## [4.5.0] - 2026-07-15

### Added

- **`styleproof.config.json` is now the single project-config surface.** Every
  CLI reads `spec`, `dirtyAllow`, `cacheBranch`, `remote`, and
  `affected.{surfaces,graph,base}` from it as the lowest-precedence default
  layer (flag > env > file > built-in), alongside the Action's existing
  gate-policy keys. A configured repo runs `styleproof-affected` bare, and
  dirty-allow paths live in config instead of being threaded through hook and
  workflow invocations. A malformed file or wrongly-typed key fails loudly.
- **`styleproof-init --upgrade` and `--check`.** The generated pre-push hook,
  report workflow, and approval workflow are machine-owned thin wrappers;
  `--check` reports drift against the current release's templates without
  writing (exit 1 — CI-able), and `--upgrade` refreshes them in place, never
  touching the user-owned spec or playwright config.

- **`styleproof-ci`** — the cache-first CI orchestration as one command:
  `--base <sha> --head <sha>` restores both exact-SHA bundles, captures just the
  head on a head-only miss (HAR replay when the base recorded data), and rebuilds
  the pair cold on a base miss under the head's exact StyleProof release, with
  package-manager commands detected independently at each checkout. A failed
  base capture now produces explicit head-only degraded evidence while head
  capture remains fail-closed. The
  init-generated workflow step is now a single invocation instead of ~80 lines of
  copied bash, and emits `base-hit`/`head-hit`/`capture-needed`/
  `base-capture-failed`.
- **`styleproof-prepush`** — the canonical pre-push capture→publish flow,
  packaged. The generated hook is a two-line shim that execs it, so the rules
  (pushed-refspec selection, docs-only skip, restore-before-capture) update with
  each release instead of drifting in a copied hook file. The shim invokes the
  installed local binary directly, so a missing install fails instead of falling
  through to a package-registry download, and
  `styleproof-init --hook` refreshes a stale hook in place.
- **`styleproof-affected`** — the selective-remap verdict as a CLI over
  `affectedSurfaces`: dependency-cruiser graph in, changed files from git (or
  `--changed`), reviewer-checkable skip list and `--json` verdict out; exit `0`
  scoped / `3` unbounded.
- **`--dirty-allow <path>`** on `styleproof-map` (and `STYLEPROOF_DIRTY_ALLOW`) —
  tracked files a dev tool rewrites on every run (e.g. `next dev` regenerating a
  `tsconfig.json`) no longer mark a capture dirty, generalizing the built-in
  `next-env.d.ts` allowance.
- **The Action self-verifies its published report.** After pushing the report
  branch it reads the report back at the exact advertised commit and requires the
  embedded receipt to name this run's head SHA, run id, and attempt — failing
  closed instead of shipping a green run with a dead or stale `report-url`, so
  consumers can drop their own post-action read-back checks.
- **Map-store dogfood runs the production roundtrip on every same-repo PR.** A
  real browser capture is published to a per-attempt scratch branch, restored by
  exact SHA, certified byte-identical, and checked for the exit-4 miss contract.
  Cleanup distinguishes an absent branch from an inspection or deletion fault,
  so leaked scratch branches cannot hide behind a green run.

### Fixed

- **Restore faults no longer masquerade as cache misses.** `styleproof-prepush`
  exits with the persistent map-store/network failure instead of attempting an
  unrelated capture, and fallback captures now preserve explicit map/base dirs.
- **`styleproof-init --upgrade` preserves repository-owned pre-push hooks.** It
  only refreshes hooks carrying StyleProof's ownership marker; replacement of a
  custom hook still requires the explicit `--hook` command.
- **Action configuration now fails loudly through the shared config loader.**
  Malformed policy is no longer warned about and silently replaced with defaults.
- **Generated pre-push hooks execute the installed local binary.** Missing
  installs can no longer fall through to a registry lookup for an unpublished
  package name.

- **Every Action run now publishes a durable report receipt.** Clean comparisons
  commit the no-change report and return its immutable URL, so consumers can
  verify publication for every completed run instead of treating missing
  evidence as a clean verdict.
- **The consumer-checkout publish fallback now works from a partial isolated clone.**
  The isolated map-store checkout is a blob:none partial clone, and Git refuses to
  lazy-fetch missing objects while serving a local fetch, so importing the new
  commit into the consumer checkout failed with "protocol error: bad pack header"
  whenever the store already held other bundles. The consumer now fetches the
  branch tip through its own credentials first, which narrows the import to the
  newly committed objects, and the fallback push fully qualifies its destination
  ref so it can also create the branch on first publish.
- **Explicit workflow authentication no longer duplicates the checkout header.**
  StyleProof clears any inherited GitHub HTTP authorization value before adding
  `STYLEPROOF_MAP_STORE_TOKEN`, preventing GitHub from rejecting cold-cache
  clones with `Duplicate header: "Authorization"` while retaining explicit-token
  precedence over stale checkout credentials.

## [4.4.22] - 2026-07-13

### Fixed

- **The compatibility key no longer depends on how `cwd` was spelled.** A
  relative `cwd` made the Playwright-version probe throw internally, silently
  dropping that field from the key — so a publish and a restore in the same
  environment could stamp different keys, and every cache lookup missed
  (a silent full-recapture tax, never an error). The key inputs now resolve
  `cwd` first, and a regression test pins relative/absolute equality.

## [4.4.21] - 2026-07-14

### Fixed

- **GitHub Actions map publication no longer sends duplicate authorization headers.**
  StyleProof now resets inherited checkout headers before applying the single
  effective credential to isolated map-store clone and push operations.

## [4.4.20] - 2026-07-14

### Fixed

- **Map-store network operations can no longer wedge CI indefinitely.** Remote
  lookup, clone, and push commands now have a bounded timeout, and a stalled
  isolated push falls through to the authenticated consumer checkout path.

## [4.4.19] - 2026-07-14

### Fixed

- **Generated cache restores now evaluate each map in its own commit context.**
  CI checks out the base before restoring the base bundle and returns to the head
  before restoring the head bundle, so lockfile-changing pull requests reach the
  browserless hot path after their first published pair.

## [4.4.18] - 2026-07-13

### Fixed

- **Generated cold-cache workflows now publish from a clean tracked tree.** Yarn,
  pnpm, and Bun restore only the package metadata changed by the temporary exact
  StyleProof install while retaining that release in `node_modules` for capture.

## [4.4.17] - 2026-07-13

### Fixed

- **Generated cache-first CI now preserves the installed StyleProof release across
  base checkouts.** Cold-cache capture installs the head's exact release into an
  older base checkout and invokes the installed binary directly, preventing package
  manager reconciliation from silently running the base's older capture logic.
- **Generated workflows now reuse checkout authentication for map publication.**
  The redundant map-store token environment variable is omitted; the persisted
  checkout credential supplies the existing least-privilege `contents: write` path.

## [4.4.16] - 2026-07-13

### Fixed

- **Map-store publication now retains failures that occur while preparing a retry.**
  If an authenticated push fails and the next clone also fails, StyleProof reports
  both errors with their attempt and phase instead of replacing the actionable push
  failure with the later setup error.

## [4.4.15] - 2026-07-13

### Fixed

- **Failed map-store uploads now retain every Git transport error.** The
  workflow-token credential retry is no longer hidden by a later fallback, so
  hosted CI reports the authenticated failure needed to repair publication.

## [4.4.14] - 2026-07-13

### Fixed

- **Workflow-token publication now uses Git's credential protocol for the final retry.**
  The token stays out of remote URLs and process arguments, while real Git credential
  lookup is covered directly instead of relying on an executable askpass script.

## [4.4.13] - 2026-07-13

### Fixed

- **Workflow-token publication now retries through Git askpass.** When GitHub
  rejects the temporary checkout's explicit HTTP header, StyleProof clears that
  header and supplies the token through Git's credential prompt protocol without
  placing the secret in the remote URL or command arguments.

## [4.4.12] - 2026-07-13

### Fixed

- **Map-store publication now survives an isolated push losing Actions
  authentication.** If the sparse temporary checkout is rejected, StyleProof
  imports its generated commit into the original checkout and retries the push
  through checkout-v7's authenticated Git context.

## [4.4.11] - 2026-07-13

### Fixed

- **Map-store pushes now receive workflow authentication directly.** The final
  `git push` uses the same explicit reset-and-token arguments as the isolated
  clone, so temporary sparse-checkout config cannot drop the Actions token after
  a successful cold-cache capture.

## [4.4.8] - 2026-07-13

### Fixed

- **Map-store restore now retrieves only the requested commit bundle.** Restore
  clones branch metadata without a checkout, sparsely selects the requested SHA,
  and, on partial-clone-capable remotes such as GitHub, downloads only that
  bundle's blobs. Large long-lived map stores therefore no longer make every
  cache lookup clone all historical bundles on supported remotes. Publishing
  uses the same sparse checkout and stages only the requested bundle plus the
  store README; Git's sparse index preserves unseen bundles without downloading
  their blobs, so cache misses no longer materialise the complete store either.

## [4.4.7] - 2026-07-13

### Fixed

- **Explicit map-store credentials take precedence over checkout state.** When
  `STYLEPROOF_MAP_STORE_TOKEN` is set, StyleProof now uses it before inspecting
  persisted Git headers, so stale `actions/checkout` credentials cannot break a
  cold-cache map upload.
- **Generated CI authenticates map publication explicitly.** `styleproof-init`
  passes the workflow's least-privilege `github.token` as
  `STYLEPROOF_MAP_STORE_TOKEN`, so cold-cache uploads do not depend on private
  `actions/checkout` credential-storage details. Local hooks continue to reuse
  normal Git credentials without requiring this variable.
- **Map-store uploads now reuse credentials from `actions/checkout@v7`.**
  Checkout v7 keeps its HTTP header in an included temporary config rather than
  directly in `.git/config`; StyleProof now explicitly enables Git config includes
  and falls back to its locally registered checkout config before carrying that
  header into the isolated clone and push.
- **Map-store uploads now reuse credentials from `actions/checkout@v7`.**
  Checkout v7 keeps its HTTP header in an included temporary config rather than
  directly in `.git/config`; StyleProof now explicitly enables Git config includes
  and falls back to its locally registered checkout config before carrying that
  header into the isolated clone and push.
- **Map-store uploads now reuse the HTTP authentication persisted by
  `actions/checkout`.** The isolated `styleproof-maps` clone carries the
  checkout's URL-scoped extra header through clone and push, so cache-miss
  captures publish successfully without every consumer wiring a token into the
  CLI step.
- **Map-store uploads from Git hooks no longer inherit the caller repository's
  Git location variables.** A cold `styleproof-maps` upload could otherwise run
  its temporary `git init` against the consumer repository, set
  `core.bare=true`, and reject the push after a successful capture. StyleProof
  now isolates every child Git process from hook-exported repository paths.

## [4.4.1] - 2026-07-13

### Changed

- **`styleproof-init` now scaffolds the least-work v4 map loop.** Pull-request
  CI restores exact base/head bundles from `styleproof-maps`; a compatible base
  hit plus head miss captures only the head, while a base miss rebuilds the
  pair. Every fallback capture is bound to its explicit commit SHA and
  published, so the same cold work is not repeated on later pull requests.
  Temporary CI maps live under `runner.temp`, outside the checkout, and the
  fallback installs Chromium before capture. The generated Action pin is `v4`.
- **The generated pre-push hook is restore-first too.** Re-pushing an already
  published commit restores its exact bundle and skips the browser; a real miss
  captures once and requires a clean SHA-keyed upload before the push proceeds.

## [4.4.0] - 2026-07-13

### Changed

- **Spec-driven captures now run in parallel across Playwright workers.** The
  capture describe declares `parallel` mode itself, so surface×width tests fan
  out over the consumer's `workers` even when the project pins
  `fullyParallel: false` for its behaviour suite. Every generated test was
  already independent (own page, own map/HAR files, own self-check; ledger and
  manifest tests mkdir and tolerate any order), so the maps are byte-identical —
  a real consumer's 150-capture run dropped from 24.5 to 6.0 minutes at 4
  workers on the same box. A spec file whose OWN sibling tests read the captured
  maps in file order can opt out with `parallel: false`. Found while
  dogfooding against a large single-route consumer app.

### Fixed

- **An absolute `STYLEMAP_DIR` (or `--dir`) is respected as-is.** It was joined
  under `baseDir`, so `STYLEMAP_DIR=/abs/path styleproof-map` stranded the maps
  at `.styleproof/maps/abs/path` where no consumer looks. Relative dirs nest
  under `baseDir` unchanged. Also found dogfooding against a consumer app.

## [4.3.0] - 2026-07-13

### Changed

- **A removed surface now blocks (exit 1) instead of riding the exit-3 "only new
  surfaces" path.** A surface captured only on the base side is a deleted route
  or a dropped width — a reviewable change, printed as `✗ REMOVED surface` —
  never an onboarding case the approve-all box waves through under a "new
  surfaces" banner. Exit 3 now means only NEW (head-side-only) surfaces.
- **Stale acknowledgements gate everywhere.** A stale `allowRemoved` entry in
  `styleproof.inventory.json` now blocks like a stale data-residue
  acknowledgement (and the Action's inventory hard-gate counts both), so a
  ledger entry left behind cannot pre-acknowledge the next removal of that key.

### Fixed

- **Crawls never capture an off-origin redirect target.** A same-origin link
  that 302s to another origin (SSO, `/out?url=…`) previously entered the map as
  a surface — third-party, nondeterministic content. The CLI sweep now skips the
  page loudly and continues; a spec-driven capture fails naming the surface; an
  entry URL that redirects off-origin is a hard error.
- **The gate now surfaces what it did NOT compare.** The diff prints (and
  `--json` carries) the count of auto-detected volatile subtrees excluded from
  the comparison, and warns when the forced-state layer was skipped on BOTH
  sides — previously a head-side volatile region or a twice-skipped state layer
  could hide a real change with zero trace in the output.
- **A corrupt coverage ledger is a hard error (exit 2), not a silent disarm.**
  Unparseable `styleproof-coverage.json` used to read as "no registry", quietly
  turning the coverage, determinism, and residue gates into warnings at once.
  The residue footer also no longer misattributes a ledger-less bundle to the
  `dataResidue: "warn"` opt-out.
- **The Action fails closed on unexpected diff exit codes.** A node crash, OOM
  kill, or missing file (127/137/143/…) previously fell through to
  `changed=false` — a green "No visual changes" status for a run that never
  compared anything.
- **Approval can no longer wave through certification failures.** The Action
  gained a post-approval hard gate (like the inventory gate) for incomplete
  coverage, unproven determinism, and armed data-residue failures — none of
  which are restyles the approve-all checkbox should clear.
- Stale `exclude` entries are printed with the coverage verdict, and "coverage
  complete" now says "captured or explicitly excluded".

## [4.2.0] - 2026-07-13

### Changed

- **`styleproof-capture --crawl` now follows same-origin nav links.** Every
  page the site links to is crawled like the entry page, keyed by its route
  (`about`, `pricing`, …), with class coverage aggregated across the pages that
  share stylesheets. Previously the CLI crawl drove controls but silently
  dropped links, so a multi-page site reported "1/1 surfaces, coverage ✓" while
  losing every other page. `--no-follow-links` restores the entry-page-only
  sweep.

### Fixed

- **A non-head checkout in CI is no longer stamped with the pull request's head
  SHA.** `currentGitSha` now trusts `git rev-parse HEAD` and relabels only a
  checkout of the synthetic `GITHUB_SHA` merge commit, so a base-branch capture
  (the scaffolded cache-miss job) can never publish a base-tree map under the
  head's store key — a store poisoning that made later restores diff
  base-vs-base and report a false green. `pull_request_target` payloads are no
  longer trusted for relabeling at all, and a malformed `STYLEPROOF_SHA`
  override now errors instead of silently falling back.
- **Annotation move-suppression now requires provable displacement.** A
  cross-path annotation match may suppress its magenta boxes only when the
  container where the two paths diverge gained or lost captured children, or
  when the element slid into a vacated slot in its own container. This fixes
  three truthfulness bugs at once: a size-changing duplicate restyle swap no
  longer loses all visual proof, a sibling insertion into a uniform-shell list
  (menus, navs) no longer re-boxes every unchanged displaced item, and an
  independent removal + identical addition in different containers no longer
  cancel each other's annotations to zero.
- **`styleproof-diff` no longer misreports fresh ad-hoc captures as predating
  the determinism ledger.** The unknown-basis warning now names the real cause:
  ad-hoc `styleproof-capture` output records no ledger; spec-driven captures
  self-check and do.

## [4.1.0] - 2026-07-12

### Fixed

- **Annotated report crops no longer paint path-shifted subtrees as visual
  changes.** When an unkeyed sibling insertion renumbers `:nth-child()` paths,
  the report reconciles exact-equivalent entries across paths for annotation
  only. Genuine additions and removals stay highlighted, while exhaustive
  structural findings remain in the certification and audit details.
- **Pull-request captures and reports now stay bound to the real head commit.**
  GitHub's synthetic merge SHA no longer becomes the map or report provenance,
  and published report links point to the immutable report commit.
- **Certify-mode report comments now carry their source head marker**, so stale
  comments can be distinguished from the current PR head.
- **Annotation reconciliation preserves duplicate additions, removals, and
  forced-state changes.** Matching is one-to-one within a structural
  neighborhood, and indistinguishable duplicate provenance is reported as a
  deterministic unmatched occurrence rather than guessed. Ambiguous duplicate
  restyle swaps retain visual proof on both sides.

## [4.0.2] - 2026-07-11

### Fixed

- **Inserting a semantic sibling no longer turns every following element into a
  false restyle.** Capture paths now prefer privacy-safe hashed identities from
  stable attributes (`data-styleproof-key`, IDs, test IDs, link destinations,
  and form names) when they are unique among siblings, falling back to
  `:nth-child()` only when no stable identity exists. Raw attribute values never
  enter the map.
- **Reports no longer publish an unchanged image as a misleading highlighted
  twin.** The annotated crop is omitted when every changed rectangle falls
  outside the rendered crop.
- **New-surface screenshots no longer preserve a blank full-page tail.** New
  captures record their viewport and reports show that top viewport when the
  full-page screenshot is taller.
- **Shared changes now choose exposed proof and suppress misleading crops.** When
  the same change appears on an ordinary page and a modal-open state, the report
  excludes modal-background DOM content before viewport width; if no captured
  state visibly paints the change, it retains the audit details without images.

### Changed

- **New pages, states, and surfaces render before element-level diffs.** A new
  page can no longer be buried beneath shared-frame changes in the report.
- StyleProof reports now lead with named new surfaces in the summary that PR comments quote, and render new-surface screenshots before existing-surface diff groups so new-page PRs do not read like broad restyle churn.

## [4.0.1] - 2026-07-07

### Fixed

- **Unset capture specs no longer inflate Playwright's skipped-test count.** When
  `defineStyleMapCapture({ dir: process.env.STYLEMAP_DIR, ... })` or
  `defineCrawlCapture({ dir: process.env.STYLEMAP_DIR, ... })` runs with no `dir`,
  StyleProof now returns before registering generated capture tests instead of
  registering one skipped test per surface. Static `expected` coverage guards still
  run in the normal suite. (#215)

## [4.0.0] - 2026-07-07

The first major since v3. Three breaking defaults make StyleProof strict out of
the box — an unapproved change **blocks**, a silently-failing data endpoint
**gates**, and a manifest-less map bundle is **refused** rather than compared on
faith. Pin `BenSheridanEdwards/StyleProof@v4` to adopt; `@v3` stays on 3.x. Each
breaking entry below carries its one-line migration.

### Removed

- **BREAKING: a manifest-less map bundle is no longer compared — it fails with exit
  `2`.** Before, a two-directory `styleproof-diff`/`styleproof-report` where a side
  shipped captured maps but no `styleproof-manifest.json` (the legacy committed-map
  workflow) printed a one-line stderr notice and **compared anyway** (the tolerance
  added in #200). The same-environment guard can't be enforced without a manifest, so
  captures from different browser builds or platforms could diff as false changes. For
  **v4** that tolerance is removed: a side that ships maps with no manifest now fails
  loudly with exit `2` (usage/capture error), naming the bare side(s) and the remedy —
  re-capture with current StyleProof; maps without a manifest are unsupported. A dir
  with _no maps at all_ is unchanged: it is "no baseline yet", still the first-adoption
  review path (exit `3`), not a bare bundle. **Migration:** re-capture both sides —
  `styleproof-map` for spec-driven surfaces, or `styleproof-capture` for a one-shot
  design diff; both now write a `styleproof-manifest.json` into their output dir
  (`styleproof-capture` previously wrote none, which would have made the design-match
  flow fail under this change — it now stamps one, degrading the git SHA/dirty fields
  gracefully when run outside a git repo).

### Changed

- **BREAKING: `dataResidue` now defaults to `'gate'` instead of `'warn'`.** A
  data-boundary request (`replayUrl`, default `**/api/**`) that fails during a
  spec-driven capture means the endpoint's _fallback_ branch shipped as the certified
  state — its response-driven states were never captured. Warn-only was the
  backwards-compatible launch choice, not the correct one; the default is now to BLOCK.
  `'warn'` remains fully supported as the explicit opt-out (record + warn without
  gating); the acknowledgement ledger and stale-acknowledgement rot protection are
  unchanged. **Migration:** if a capture now fails on a data endpoint you expect to be
  down, either acknowledge the intentional failures in `styleproof.data-residue.json`
  (`{"<surface·endpoint>": "why"}`), or set `dataResidue: 'warn'` in the capture spec to
  restore the previous non-gating behaviour. A capture with no failing data request is
  unaffected. (#205)

- **BREAKING: `blocking` now defaults to `true`.** In review-gate mode
  (`require-approval: true`), an **unapproved** visual change now **fails the
  report job** (red ✗) out of the box, so the check blocks a merge even on a repo
  without a branch-protection rule requiring the `StyleProof` status (which needs
  GitHub Pro or a public repo). Previously the default was `false` — advisory-only,
  where only the commit status went red. The approve→re-run flow is unchanged: tick
  **Approve all changes**, re-run the job, and the re-run sees the sign-off and
  passes. Certify mode (`fail-on-diff: true`) is unaffected. **Migration:** to keep
  the old advisory-only behaviour, set `"blocking": false` in
  `styleproof.config.json` at your repo root.
- **Pre-push guidance no longer commits maps to the PR branch** (docs and repo
  hygiene only; no change to the published package, CLI, or Action). The
  pre-push recipe previously ended with `git add stylemaps` + a map commit on
  the branch — so maps appeared as changed files in every PR, and because all
  PRs wrote the same `stylemaps/` paths, each merge forced every other open PR
  to rebase. The recipe now captures and publishes to the SHA-keyed
  `styleproof-maps` store branch (what `styleproof-map` already does outside
  CI) and never touches the PR branch; `stylemaps/` is gitignored as a
  guardrail, and the README states the maps-never-in-PR rule explicitly.

### Added

- **Data-residue guard — a capture that embeds an unprovoked data-fault state now
  says so.** During a spec-driven capture, any request matching the data boundary
  (`replayUrl`, default `**/api/**`) that FAILS — a network error, or a 4xx/5xx —
  means the captured state rendered that endpoint's _fallback_ branch, so the states
  its real responses would drive are uncaptured and unproven (the failure mode
  documented in #202). StyleProof now names each such failure on stderr at capture
  time (what failed, what it means, what to do: fixture it via `page.route`/
  `liveStates`, or acknowledge it), records it on the capture (`StyleMap.dataResidue`),
  and surfaces it in `styleproof-diff` and the report's certification block. **Gate by
  default:** an _unacknowledged_ failing endpoint blocks the diff (exit 1); acknowledge
  intentional ones in `styleproof.data-residue.json` (`key → reason`), and a stale
  acknowledgement (the endpoint no longer fails) also fails so the ledger can't rot — the
  same discipline as `exclude` and the inventory guard. Set `dataResidue: 'warn'` to opt
  down to record-and-warn without gating. A 2xx endpoint that merely wasn't fixtured is
  **never** flagged (recording mode legitimately records live responses). `--json` gains
  an additive optional `dataResidue` field. A capture with no failing data request is
  byte-identical whichever mode you run. Fixes #205.
- **`styleproof-init` now installs the pre-push publish hook by default.** The
  capture-locally/publish-to-store flow is the out-of-the-box path, not an
  opt-in recipe: init scaffolds a `pre-push` hook (into `.husky/` when present,
  else `.githooks/` with a one-line activation hint) that runs `styleproof-map`
  — capture this commit, publish the bundle to the SHA-keyed `styleproof-maps`
  branch — plus an advisory `styleproof-diff`, so CI restores by SHA and stays
  report-only. `STYLEPROOF_SKIP_CAPTURE=1 git push` skips a push that can't
  affect render. Never overwrites an existing hook; maps never get committed
  to the PR branch.
- **`styleproof-init` now installs the approval workflow.** The generated report
  workflow runs with `require-approval: true`, but the `issue_comment` handler
  that flips the `StyleProof` status when a reviewer ticks **Approve all changes**
  previously had to be copied from `example/` by hand — leaving the review gate
  inert until someone did. `styleproof-init` now scaffolds
  `.github/workflows/styleproof-approve.yml` alongside the report workflow
  (copied verbatim from the packaged example, never overwriting an existing file),
  so the gate is complete out of the box. It activates once the init PR merges,
  since GitHub runs `issue_comment` workflows only from the default branch.
- **Enforced quality gates and an agent context layer** (repository tooling only;
  no change to the published package, CLI, or Action). A `commit-msg` commitlint
  hook and PR-title/body validation enforce Conventional Commits; gitleaks
  (staged-diff hook + full-history CI, fail-closed), CodeQL, and
  `npm audit --audit-level=high` add secret/SAST/dependency scanning; a machine
  `pull_request` check validates the PR template shape. `AGENTS.md` is now the
  tool-agnostic source of truth (previously a symlink to `CLAUDE.md`, now a thin
  vendor adapter), with `.agents/project/` documenting architecture, conventions,
  tech stack, glossary, the gate matrix, PR quality, and the Definition of Done
  (moved from `.agents/DEFINITION_OF_DONE.md`). Adds `.agents/decisions/` ADRs, a
  root `TODO.md`, and a `.claude/` PreToolUse hook that blocks `--no-verify`.

### Docs

- **README catches up with the shipped gates.** A new _What a green certifies_
  section surfaces the coverage, determinism, and inventory verdicts (3.9–3.14)
  that previously lived only in the CLI reference bullet, linking
  `docs/what-it-catches.md` and `docs/inventory-guard.md`; `styleproof-capture`
  joins the CLI reference (with `--until-covered`); the policy table gains
  `gateInventoryRemovals`; and the layout-equivalent-margin wording reflects the
  one-sided-imbalance fix below. The repo's Claude Code skills
  (`.claude/skills/styleproof*`) are fact-checked against the current CLI/API
  surface: dead cross-references removed; the gate-contract exit codes, crawl
  `expected` guard, browser-build compatibility key, and ledger verdicts added.

### Fixed

- **A two-directory `styleproof-diff`/`styleproof-report` no longer skips the
  same-environment guard in silence.** The guard (`assertCompatibleMapDirs`) compares
  platform/arch/node/Playwright/browser-build across both maps, but no-ops when either
  side carries no `styleproof-manifest.json` — so a committed-map workflow that ships
  maps but no manifest (exactly the flow most likely to compare captures across
  machines) got zero protection with nothing said. Both CLIs now print a one-line
  notice to stderr naming the bare side(s) — `before`, `after`, or `both` — pointing
  at `styleproof-map` to record a manifest, then compare anyway. It is a notice, not a
  failure: **exit codes are byte-identical** (plenty of legitimate manifest-less flows
  exist, e.g. `styleproof-capture` one-shots), and a pair where both sides carry a
  manifest behaves exactly as before, silently. `--json` is unchanged.

## [3.21.0] - 2026-07-07

### Added

- **Shared-chrome tier in the report and the `styleproof-diff` CLI.** When one
  change rides the frame every view draws — a persistent nav rail, header, or
  footer that moved on every surface that renders it — it is promoted to a single
  "🧱 Global chrome change" callout at the top, with the detail folded beneath,
  instead of repeating across a long surface list on several entries. The reviewer
  reads "the nav changed everywhere" once. The threshold is **structural, not a
  tunable knob**: an element path is chrome only when it is hosted on more than one
  surface base and changed on _every_ base that hosts it (full coverage of its
  hosting surfaces). A change on merely some surfaces, or a view's own content
  change entangled with the frame change, is never promoted — the view-specific
  detail always stays visible. Purely presentational: grouping keys, findings,
  counts, exit codes, and `--json` are unchanged.

### Changed

- **`styleproof-diff` human output now reuses the report's grouping.** One real
  change no longer prints once per surface with its derived-longhand echo: the CLI
  groups surfaces that changed identically into one finding (with the per-surface
  count on the header line), summarises longhands into shorthands, and folds the
  size/position-derived longhands (`transform-origin`, `width`/`height`, cascaded
  ancestor heights…) behind a `(+N derived longhands)` count. A one-view button
  restyle at one width that used to fill dozens of raw lines now reads as a single
  grouped finding. `--json` stays the complete, byte-stable machine contract (every
  surface, every raw longhand); exit codes are unchanged.

### Fixed

- **The report's certification block no longer contradicts the diff on inventory
  additions.** For the same capture pair, `styleproof-diff` correctly prints a
  navigable addition (additive, non-gating), but `styleproof-report`'s certification
  block still read `Inventory — ✓ navigable set unchanged` — telling a reviewer the
  navigable set didn't change when it did. The inventory line now echoes additions as
  an informational, still-✓-class clause (`✓ N navigable affordance(s) added: <keys>
(additions don't gate)`), with the same truncation and key-escaping discipline as
  the removals line. Removals still drive the ⚠/✗ gate semantics; additions are
  appended. The diff and the report can no longer disagree about the navigable delta.
- **The unit suite no longer flakes on spawned-CLI tests (test-infra only, no
  consumer-visible change).** The package-smoke test packed the live checkout with
  `npm pack`, which runs the `prepare` lifecycle (`tsc`) even under `--ignore-scripts`.
  `tsc` truncates each `dist/*.js` to zero bytes before rewriting it, so a CLI spawned
  by a _different_ test running concurrently under `node --test` could read a
  half-written `dist` module and die with a static ESM link error
  (`does not provide an export named …`) — surfacing as an "impossible" exit code (a
  flag-rejection test that pins exit `2` seeing exit `1`, or a spawned bin printing a
  missing-export `SyntaxError`). The smoke test now packs a staged copy of the package
  whose manifest carries no lifecycle scripts, so pack can never rebuild — the shared
  `dist` is never mutated mid-suite. Same coverage (the packed tarball is still
  installed and its API + every bin's `--help` exercised); the packed artifact is
  identical.

## [3.20.0] - 2026-07-07

### Fixed

- **Crawl no longer double-captures `/` and `/index.html` as two surfaces.** On a
  static multi-page site whose nav links the `.html` files, `/` and `/index.html`
  (and `/dir/` vs `/dir/index.html`) are the same route but were captured twice as
  byte-near-identical maps — doubling the capture work and duplicating every finding
  in the diff. The crawl's dedup identity now normalizes a trailing `index.html` to
  its directory path, so they collapse to one surface (first-seen href keeps its
  original navigable form). Only the literal `index.html` filename normalizes — a
  genuine `about.html` stays a distinct surface from `about`.
- **`styleproof-init` now states exactly which files it wrote — and that it did NOT
  touch `package.json` or your lockfile.** Adopters attributed the `styleproof`
  dependency entry (added by their package manager's `install`) to init; init only
  ever reads `package.json` and writes the spec, the dedicated Playwright config,
  `.gitignore` lines, and the CI workflow. The summary now enumerates those files and
  says plainly that the manifest and lockfile were left untouched.
- **The no-comparison outcome of `styleproof-diff` / `styleproof-report` names both
  ways forward.** When the no-args (inferred-base) path can restore no base map — no
  map-store remote, no cached bundle — nothing is compared. That already exits `2`
  (never a soft `0` a newcomer could read as "certified clean"); the message now says
  "nothing was compared" and names the two working alternatives: run in CI (or a repo
  with the `origin` remote) where the base is restorable, or the two-directory form
  `styleproof-diff <beforeDir> <afterDir>`. A regression test pins the exit-2 contract
  in a remote-less repo for both commands.
- **README: the Next.js coverage guard is described accurately.** The docs conflated
  two behaviors. With the auto-wired spec, `surfaces` and `expected` both derive from
  the same `discoverNextRoutes()` call, so a new static route is captured and expected
  together — **auto-covered, never a guard failure**. The guard **fails** only on
  genuine divergence (a dynamic route, a hand-maintained registry, or a route dropped
  from `surfaces` while still `expected`). Rewrote the overclaiming passages and the
  generated-spec comments to state both behaviors.
- **Layout-equivalent margin suppression no longer drops a real one-sided margin
  change.** `dropLayoutEquivalentMarginProps` suppressed any horizontal
  `margin-left/right/inline-start/inline-end` change whenever the element's rect
  was unchanged — reasoning that a margin that doesn't move the box is cosmetic
  drift. But a one-sided change (e.g. `margin-left: 0 → 40px` with `margin-right`
  untouched) that leaves the rect identical only stayed put because _something
  else compensated_; that is a genuine restyle, and it was silently dropped. The
  suppression now fires only when there is no **demonstrable px imbalance**
  between a side and its opposite — balanced drift (both sides move together) and
  forced-state deltas are still suppressed exactly as before, but a one-sided
  real change surfaces. A residual, consciously-deferred corner remains (a
  perfectly _balanced_ change held in place by external compensation), documented
  inline; closing it needs cross-element layout reasoning.
- **`styleproof-init` no longer imports the whole library barrel (fixes a CI
  flake).** The scaffolder only needs `discoverNextRoutes`, but it imported it
  from `dist/index.js` — dragging capture, the crawler, the report renderer, and
  six Playwright-importing modules into a tool that writes files and captures
  nothing. Loading that oversized module graph concurrently (init's own suite
  spawns the CLI many times, alongside the rest of `node --test`) is what made
  init's tests flake in CI, red-flagging releases with no code cause. It now
  imports from the `dist/routes.js` leaf (`fs` + `path` only): init's transitive
  module graph drops from 21 dist modules to 1, with zero Playwright modules on
  its load path. Behaviour is unchanged; a regression test pins the leaf import.
- **Popup capture: verified reset + identity-bound triggers (no leaked-overlay
  contamination, no wrong-trigger keying).** On a surface whose `go()` doesn't
  navigate (SPA variants), the between-popups reset was Escape-only and assumed:
  a toast or `[role="status"]` overlay Escape can't dismiss leaked into the next
  popup's capture, and each reopen re-enumerated triggers positionally, so a
  shifted trigger set (e.g. a click that adds a button) could key a popup under a
  different trigger than the one originally enumerated. Triggers are now re-bound
  by the DOM identity recorded at first enumeration, and the reset is verified
  against the surface's pristine overlay set; a candidate that can't be opened
  safely is skipped loudly (a `styleproof:` warning naming the popup and the
  leaked overlay or missing trigger) instead of being captured contaminated,
  mis-keyed, or — with self-check on — saved unproven. That identity is the
  trigger's DOM path **and** its accessible label, not the path alone: for an
  id-less trigger the path ends in `:nth-of-type`, which is still position within
  a parent, so a same-tag same-parent sibling injected earlier in DOM order
  between enumeration and reopen would slide the recorded path onto a different
  trigger and key its popup under the wrong one — silently. Requiring the label
  (the same aria-label/name/text/title accessible name the crawler reads) to match
  too turns that mismatch into the same loud skip. Navigating surfaces are
  unaffected.

## [3.19.0] - 2026-07-06

### Added

- **Selective-remap wiring: `explainAffectedSurfaces` + the pre-push recipe.** The
  sound core (`affectedSurfaces`) shipped in 3.17.0 returns a bare `Set | 'all'` that
  names nothing; the new pure `explainAffectedSurfaces(result, allSurfaceKeys, reason?)`
  formatter renders the verdict as reviewer-checkable lines — which surfaces re-capture
  and which reuse their committed base map — so a pre-push hook or CI log can print the
  skip list before anyone trusts it. `affectedSurfaces`'s return shape is unchanged
  (backward-compatible; the helper takes the surface keys as a second argument rather
  than extending the sentinel). README's selective-remap section gains the helper, its
  output, and the full `git diff → dependency-cruiser → affectedSurfaces → capture subset`
  pre-push recipe. Opt-in and advisory throughout — the default full-coverage gate is
  untouched.

### Fixed

- **Report tables escape hostile CSS values (no Markdown breakout).** A property
  value carrying a `|` used to split a report table row, and a backtick used to close
  the code span and leak live Markdown (`content:"…"`, `url(…)`, `font` strings). The
  render boundary now escapes values instead of stripping them — `|` → `\|`, and the
  code fence widens past the value's longest backtick run — so hostile values render
  as one intact, readable cell. `report.md` only; the privileged review comment was
  never affected.
- **The navigable-removal guard now sees SVG `<a>` nav links.** The in-page harvest
  keyed anchors off `tagName === 'A'`, which is HTML-only (SVG reports lowercase `a`),
  so an SVG nav link never entered the inventory and its removal never gated. The tag
  check is now case-insensitive, the selector matches any-namespace `href`
  (`a[*|href]`), and the target falls back to `xlink:href` — an `<svg><a>` link now
  resolves like an HTML one.
- **Single-value `transform-origin`/`perspective-origin` jitter is suppressed.** The
  sub-pixel-origin equality check required at least two length components, so a
  one-value origin (`50px`) leaked rounding jitter as a false diff. One to three
  components are now all suppressed within `ORIGIN_EPSILON_PX`; a real, larger change
  still reports.
- **`styleproof-diff --json` exits 2 (not 1) when the file cannot be written.** A bad
  `--json` path is a usage/setup error, but the write sat outside the guarded blocks
  and let the failure fall through to exit 1 — which CI reads as a real diff. It now
  reports to stderr and exits 2.
- **Crawl flag docs corrected.** `--max-depth`'s default is documented as 16 (not
  "unbounded" in `--help`, not "3" in the JSDoc); `--until-covered` is now listed in
  `styleproof-capture --help`.
- **Crawl no longer silently drops surfaces to key collisions, and mapping no longer
  clicks title-only destructive controls.** Five soundness fixes across the crawl path:
  - `selectCrawlLinks` deduped by raw URL, so `/about` and `/about/` — one route — were
    two links that keyed identically and the second capture overwrote the first. Trailing
    slashes are now normalized in the dedup identity (root `/` and the query string are
    left intact), so a route is captured once.
  - Genuinely distinct surfaces whose derived keys collide (e.g. `/a/b` and `/a-b` both
    slugify to `a-b`) previously overwrote each other's map file. `selectCrawlLinks` now
    disambiguates with a `-2`, `-3`, … suffix (mirroring the surface crawler), so every
    surface survives.
  - `defaultLinkKey` joined query-param values in iteration order, so `?tab=a&x=b` and
    `?x=b&tab=a` — the same route — keyed as `a-b` vs `b-a` and flapped the coverage
    guard into phantom regressions. Params are now sorted by name before joining.
  - The surface crawler's clickable-candidate label omitted the `title` attribute, so an
    icon-only `<button title="Delete">` labeled as `button` and slipped past the
    destructive-action guard — mapping would click it. `title` is now part of the label
    input in both crawlers.
  - The variant crawler carried a weaker, divergent copy of the destructive-action word
    list (missing `revoke|reset|wipe|drop|rotate|provision|seal|regenerate|renew`). Both
    crawlers now share one `DANGER_SOURCE` constant, so mapping refuses the same set of
    destructive controls everywhere.
  - `defineStyleMapCapture` and `defineCrawlCapture` now assert every expanded capture
    key is unique before running: the `surface.key-variant.key` join is ambiguous
    (`a` + `b-c` and `a-b` + `c` both expand to `a-b-c`), which used to overwrite a map
    file with no error. The key format is unchanged (it's public — filenames and report
    identities); a collision now throws up front and names both origins so the author can
    rename one.
- **Sass `@use`/`@forward` in a CSS Module now fails closed to `'all'`.** A
  `.module.scss`/`.module.sass` that loads a partial via `@use`/`@forward` can pull in
  global rules the JS import graph can't see, so `classifyStyleChange` now treats any
  such file as global (`'all'`) — a sound over-approximation, no heuristics. A plain CSS
  Module with only class selectors stays `'scope'` as before.
- **Legacy Sass/CSS `@import` in a CSS Module now fails closed too.** The fail-closed
  load check missed the `@import` form, so a `.module.scss` loading a partial via
  `@import "vars"` — whose members merge in exactly like `@use` — classified as `'scope'`
  and could silently skip a re-capture. `classifyStyleChange` now treats any
  `@use`/`@forward`/`@import` load as global (`'all'`), covering both the Sass partial
  load and the plain-CSS pass-through (`@import url(x.css)`, whose selectors are not
  hashed into the module's per-file scope, so it escapes the module). Only ever widens
  toward `'all'`; a module with no load directive still stays `'scope'`.
- **`affectedSurfaces` now canonicalizes paths across all inputs, closing a silent
  unsound skip.** `surfaces` entries, `changedFiles`, graph edges, and `files` are now
  normalized to one spelling (strip a leading `./`, collapse `//`, resolve `.`/`..` as
  pure string math — no fs), so a `./pages/Home.tsx` surface entry no longer misses a
  reachability hit spelled `pages/Home.tsx` and gets dropped from the affected set. And a
  declared surface whose entry path appears in neither `files` nor any graph edge is now
  unplaceable → `'all'`, the same fail-closed rule as an unplaceable changed file.
- **Stale browser-build sidecar can no longer stamp a false fingerprint.**
  `styleproof-map` now deletes any prior run's `styleproof-browser.json` before Playwright
  runs, and `writeBrowserBuildSidecar(dir, undefined)` now removes an existing sidecar
  rather than leaving it. Previously a reused capture dir plus a run that recorded no
  browser version would fold the _previous_ run's build into this run's manifest, and
  `assertCompatibleMapDirs` would trust that false `browserVersion` fingerprint.
- **`captureStyleMap` no longer leaks its motion-freeze `<style>` onto a reused page.**
  The freeze injected for the base/forced-state reads was re-applied without a handle and
  never removed, so on a page recaptured **without a reload** (an SPA `go()` that doesn't
  navigate, multi-surface reuse, the self-check's re-run) the next capture's motion pass
  read the still-frozen transition/animation longhands (`none`/`0s`) as its baseline —
  phantom drift that surfaced as a **false "non-deterministic capture"** self-check
  failure. The re-applied tag is now tracked and removed in a `finally`, so throw paths
  clean up too. (No API change.)
- **`liveStates` + `expected` no longer reports a false coverage gap.** A surface with
  `liveStates` is captured only as its split expansions (`home-loading`, `home-loaded`) —
  the bare base key is dropped by design — but the coverage ledger recorded `expected`
  in base keys and the gate compared captured keys literally, so a fully-captured app
  failed the gate with `uncovered: ['home']` (live in 3.18.0). The ledger writer now
  records `expected` already translated through the same liveState expansion, and the
  suite-side guard maps each capture back to its originating `surfaceKey` — a precise
  mapping via real metadata, so an unrelated `home-banner` never satisfies an uncaptured
  `home`. Both the spec-driven and crawl capture paths are fixed consistently.

## [3.18.0] - 2026-07-06

### Added

- **Crawl coverage guard (`defineCrawlCapture` gains `expected` + `exclude`).** A
  link-crawled SPA can now reconcile its _rendered nav_ against a declared route
  registry, both directions: a rendered link with no `expected` entry fails as a new
  route with no owner, and an `expected` route the nav stopped linking fails as a nav
  regression. For such an app the nav is the route universe, so this is the spec
  guard's list-vs-ledger discipline with the nav as the source of truth. Because the
  link set isn't known until the page renders, the check runs _inside the capture
  test_ (fires when `STYLEMAP_DIR` is set), not in the plain suite like the Next
  guard. `exclude` (`key → reason`) opts out conditionally-rendered links (auth /
  feature-flag) so they can't flake the guard; an `exclude` key in neither `expected`
  nor the rendered nav fails as stale. Opt-in and backward-compatible: omit `expected`
  and the crawl behaves exactly as before (captures what the nav links to, asserts no
  completeness). New pure `crawlCoverageGaps` export for asserting reconciliation
  yourself. README's "protected out of the box" scoped to what's wired per framework.

### Fixed

- **`--crawl` now honours the fail-loud contract on unreadable CSS.** Three deviations on
  the crawl path let a page with a cross-origin stylesheet be certified without ever being
  fully looked at:
  - Breakpoint auto-detection swallowed the "unreadable stylesheet" throw and silently swept
    only 1280px — every other band certified unchanged without being rendered. The crawl now
    propagates the throw like every other entry point (`styleproof-capture` one-shot,
    `styleproof-map`); the message advises pinning `--widths` for a cross-origin-CSS page.
  - The coverage verifier read class vocabulary only from _readable_ sheets, so a design
    served cross-origin could pass `--require-full-coverage` with an artificially complete
    verdict. Unreadable sheets are now counted and surfaced as **named residue**: a plain
    crawl prints `N stylesheet(s) unreadable — class coverage not provable against them`, and
    `--require-full-coverage` treats them as residue → exit 4. (`CrawlCoverage` gains an
    `unreadable: string[]` field; purely additive.)
  - `--max-depth` had two different defaults (16 in `CRAWL_DEFAULTS`, 1000 in the CLI). The
    CLI default is now **16 everywhere** — the cap exists to bound append-generator UIs (a
    composer that appends a fresh-identity node per click, which dedup can't terminate); 1000
    made it decorative. Raise with `--max-depth` for a genuinely deeper nest.
- **The navigable-removal hard-gate now has data out of the box for new scaffolds — and
  says so when it doesn't.** The Action defaults the inventory gate _on_ (3.14.0), but
  inventory _capture_ defaults off, so on a spec that doesn't opt in, no map carries an
  inventory, the diff's `inventory` verdict is `null`, and the gate counted zero removals
  forever — armed, but with no ammunition. `styleproof-init` already scaffolds
  `inventory: true` in the generated capture spec (since 3.15.0's zero-config default), so
  **freshly scaffolded projects get the protection**; existing specs are untouched and stay
  opt-in. To make the mismatch impossible to miss on pre-existing specs, the Action's gate
  step now prints a `::notice::` — _"inventory gate is on but the captured maps carry no
  inventory — set `inventory: true`"_ — instead of silently passing green, and
  `styleproof-diff --json` emits an `inventoryNote` explaining the `null` verdict. Both are
  notices, never failures: a spec that deliberately omits inventory capture keeps working.

- **The compatibility guard now keys on the real browser build, not just the Playwright
  npm version.** Each capture records `browser().version()` (the actual Chromium build) in
  its manifest, and `styleproof-diff` / `styleproof-report` refuse to compare two maps whose
  builds differ (exit 2, both builds named). The npm `@playwright/test` version was only a
  proxy: the actual binary can change while it holds constant — a `playwright install`
  re-download after a cache wipe, a different `PLAYWRIGHT_BROWSERS_PATH`, or a CI image
  bump — and two maps captured under different Chromium builds used to pass the guard and
  then diff for real, walling the PR with false diffs the canonicalizer can't absorb.
  Backward compatible: the build is compared only when **both** manifests carry it, so
  bundles cached before this field keep comparing against each other; a build change now
  fires the scaffolded recapture fallback instead of a cross-build compare. Fonts are
  documented as an environment responsibility (too noisy across machines to fingerprint
  cheaply); see the same-environment note.

- **A missing map is now refused, not mislabelled as "all new surfaces".** When one dir
  held zero captures while the other held some, `styleproof-diff` used to mark every
  surface `missing` and exit `3` ("only new surfaces") — the Action then rendered the
  whole app as 🆕 new baselines a reviewer could approve wholesale. An empty **base** (a
  restore that "succeeded" into an empty dir, a wrong `--base-dir`, a contributor without
  the pre-push hook) meant approving a possibly fully-regressed head as the baseline; an
  empty **head** (a head capture that produced nothing) meant approving a head that
  rendered zero surfaces. Now: a bundle that claims to exist yet holds zero captures — a
  `styleproof-manifest.json` present alongside no maps, on either side — and any empty
  head exit `2` with their own named causes (`base map missing: restore it from the map
store or recapture both sides — refusing to treat every surface as new` / `head map
missing: the head capture produced zero surfaces — recapture the head side; refusing to
treat every surface as removed/new`), distinct enough that the scaffolded workflow's
  capture-needed fallback is the obvious remedy in CI logs. A truly **bare** base dir (no
  manifest, no maps) still means "no baseline exists yet" — the first-adoption flow where
  the base commit predates the capture spec — and keeps the exit-`3` new-surfaces review
  path. To keep that discrimination sound, `styleproof-map` no longer writes a manifest
  (or uploads) when a capture run produced zero surfaces. `styleproof-report` shares the
  load path and is refused identically, so it can't render the misleading all-new page
  either. Exit `3` keeps its meaning: no baseline for _these_ surfaces — new against an
  existing baseline, or the very first one.

### Security

- **Surface keys are escaped before they reach the privileged PR comment.** Surface keys
  originate from artifact filenames — attacker-controlled in the fork capture/report split
  — and flow into the bot comment (sliced from `report.md`'s headline). Markdown/HTML
  control characters (`` ` ``, `[`, `]`, `(`, `)`, `<`, `>`, `|`) are now stripped where a
  key is interpolated into the report headline, certification, and summary lines, so a
  crafted key can't inject a link, image, or table into the comment. (Crop filenames were
  already restricted to `[a-z0-9-]`; this is the display-side equivalent.) No code
  execution was possible; this closes a Markdown-injection surface.

## [3.17.0] - 2026-07-05

### Changed

- **`report.md` is bounded so GitHub can always render it.** A large redesign used to
  produce a `report.md` too big for GitHub's markdown viewer (it refuses to render past
  ~512 KB) — the reviewer clicked through and got _"we can't show files this big"_, so the
  report was useless exactly when the change was biggest. The generator now holds
  `report.md` to a byte budget (`maxReportBytes`, default ~400 KB): it emits full property
  tables greedily, then lists any remaining changed surfaces as one-liners (name · change
  count · crop link) under an announced banner. The exhaustive per-row detail is always in
  `report.json` and every crop in `crops/`, so nothing is dropped from the certification —
  only the inline detail is capped. A report a reviewer can't open isn't a source of truth.

### Added

- **`affectedSurfaces` — selective-remap core (opt-in, advisory).** Given the files a
  change touched, a declared surface→entry map, and a module graph (any tool's output
  in `{ from, to }` shape — dependency-cruiser maps directly), returns exactly the
  surfaces that could have rendered differently, or the sentinel `'all'`. Sound by
  construction: it over-approximates and resolves every uncertainty to `'all'` — global
  stylesheets/tokens, vanilla (unscoped) stylesheets, `createGlobalStyle`, design-system
  configs, unbounded `import(x)`, and unplaceable files all force a full re-capture;
  computed `import(`../dir/${x}`)` is recovered as a bundler context module (directory-
  level, never a miss). Ships with `classifyStyleChange`. Purely additive, adds no
  dependency, and never touches the default gate — the gate still captures every surface
  and lets the map be the oracle. New export; existing specs unaffected.

## [3.16.0] - 2026-07-05

### Added

- **The scaffolded PR workflow prunes its own report branch, out of the box.**
  `styleproof-init`'s `.github/workflows/styleproof.yml` now also runs on
  `pull_request: closed`: when a PR closes, a `prune` job removes that PR's `pr-<n>/`
  folder from the report branch (`styleproof-reports`), so the branch no longer grows
  without bound as PRs come and go — no adopter has to remember to garbage-collect it.
  The report job is unchanged, only guarded to skip the close event. Covered by the
  `styleproof-init` workflow test.

## [3.15.0] - 2026-07-05

### Changed

- **Computed values are compared canonically, so a re-serialization isn't a change.** A
  browser or build-tool version can serialize an _identical_ value differently — a Chromium
  bump rewrites `rgba(8, 18, 32, 0.62)` as `#0812209e`, a Tailwind migration reformats a
  font list's comma spacing — and StyleProof reported every one of those as a difference,
  drowning a re-baseline in changes that aren't changes (and blowing up the report). The
  diff now compares by a canonical form: colours are parsed to one `rgba()` (across
  hex / `rgb()` / `rgba()` / `hsl()` / `hsla()`, short and long hex, comma and modern space
  syntax) and comma/whitespace runs are normalised outside quotes. A green stops flickering
  red across browser versions — captures are serialization-independent.

  Safety: only _provably-equal_ values ever collapse. A value that can't be parsed with
  confidence (or lives inside a quoted string) is left byte-for-byte, so a real change —
  `#ff0000` → `#ff0001`, `0.5` → `0.6` alpha, a different font — always still surfaces. The
  report shows the real captured strings; only the equality test is canonical.

## [3.14.0] - 2026-07-05

### Added

- **The GitHub Action hard-gates on unacknowledged navigable removals, out of the box.**
  A removed route / tab / menu-item — a feature going unreachable — is categorically not a
  restyle, so it must not be waved through by the review-gate's "approve all changes" box.
  The Action now reads the diff's machine-readable inventory verdict (3.13.0) and, as a
  final step in **both** certify and review-gate modes, fails when
  `inventory.unacknowledged > 0`, naming each removed affordance — unless the removal is
  recorded (with a reason) in `styleproof.inventory.json`. Style diffs are unaffected
  (they stay report-only / sign-off). On by default; set `"gateInventoryRemovals": false`
  in `styleproof.config.json` to opt out. Covered by a new `action-dogfood` removal
  scenario (base offers `/a` + `/b`, head drops `/b` → the Action fails).

## [3.13.0] - 2026-07-05

### Added

- **`styleproof-diff --json` now carries the inventory verdict.** The structured output
  gained an `inventory` field alongside `coverage` and `determinism` — so all three
  source-of-truth axes are machine-readable, matching the report's certification block.
  Shape: `{ removed, added, unacknowledged, staleAcknowledgements }` (arrays of keys),
  or `null` when no capture carried inventory. Previously the inventory removals were
  printed to stdout but absent from `--json`, forcing a CI that wanted to hard-gate on a
  dropped nav item to grep human prose. Now it can read `inventory.unacknowledged.length`.

## [3.12.0] - 2026-07-05

### Changed

- **Inventory guard: target-based keying.** Source-of-truth step 4 (keying honesty).
  Tabs / menu items / nav buttons now key by the most stable identity the element
  exposes — a developer-authored `data-testid`, else a non-generated `id` /
  `aria-controls` — falling back to the label slug only when there's none. Previously
  they always keyed by `slug(accessible-name)`, so a wobble in the **label** (a live
  count badge like "COMMAND 5" → "COMMAND 3", a re-word) faked a `removed` + `added`
  pair. Links were already immune (they key by href); this extends the same
  target-based principle to the rest.

  Framework-generated ids (React `useId` `:r0:`, Headless UI `headlessui-…`, Radix,
  hashes) are rejected so keying on them can't _add_ churn. The design keeps the
  guard's safe failure direction: the label-slug fallback turns a wobble into a
  **surfaced** removed+added (a red you see and acknowledge), never a hidden real
  removal. Give a nav item a `data-testid` to key it immune to its own text.

  Note: an id-bearing affordance's key changes from `<role>:<slug>` to
  `<role>:#<id>`, so existing `styleproof.inventory.json` acknowledgements for such
  items need re-keying once (the guard names the new key).

## [3.11.0] - 2026-07-06

### Added

- **Report leads with the certification gates.** Source-of-truth step 3: the reviewer-
  facing `report.md` now opens with a **Certification** block — the three source-of-truth
  verdicts, so "is this green trustworthy?" is answered before the pixel details:
  - **Coverage** — ✓ complete / ✗ INCOMPLETE (names the uncaptured surfaces) / ⚠ not asserted;
  - **Determinism** — ✓ proven / ✗ NOT proven / ⚠ unknown;
  - **Inventory** — ✓ navigable set unchanged / ⚠ N affordance(s) removed (names them) /
    ✓ N removal(s), all acknowledged.

  These verdicts were previously visible only in the `styleproof-diff` CI logs; now
  they're in the artifact a reviewer actually reads. The block is omitted for an old
  bundle that carries no certification metadata, so nothing changes for legacy captures.

## [3.10.0] - 2026-07-06

### Added

- **Determinism provenance — a green needs a proven-deterministic capture.** Source-of-
  truth step 2: a clean diff of two _nondeterministic_ captures is meaningless (they
  might just happen to match). The capture now records its determinism basis in the
  ledger — `self-checked` (captured twice, styles matched — a drift would have failed the
  capture), `replayed` (rendered against a recorded HAR, deterministic by construction),
  or `unproven` (neither) — and `styleproof-diff`:
  - **blocks (exit 1) when either side is `unproven`**, even on an empty style diff;
  - prints `✓ determinism proven — base X, head Y`, `✗ determinism NOT proven …`, or
    `⚠ determinism basis unknown` (an older bundle with no field — degrades, never a
    false red). The record-then-replay flow (base `self-checked`, head `replayed`) is
    proven, as it should be.

## [3.9.0] - 2026-07-05

### Added

- **Coverage provenance — a green now states its completeness basis.** Source-of-truth
  step 1: a green from `styleproof-diff` used to silently imply completeness it couldn't
  back up (it certified only the surfaces it happened to capture). Now the capture writes
  a coverage ledger (`styleproof-coverage.json`) into the bundle — the declared
  `expected` registry, or `null` — and `styleproof-diff` reads it and:
  - **blocks (exit 1) when a registered surface was never captured**, even if the style
    diff is empty — the one failure the gate couldn't catch before (a green over a
    surface it never looked at). This checks the surfaces actually captured, so a
    declared surface whose capture _failed_ is caught here, where the suite guard (which
    checks the declared list) cannot see it;
  - prints the basis on every run: `✓ coverage complete — all N registered surface(s)
captured`, `✗ coverage INCOMPLETE — …`, or `⚠ completeness NOT asserted` (no
    registry — certifies only the captured surfaces, so declare `expected` to certify
    completeness). A crawl records `expected: null` honestly (it captures what the nav
    links to, not proven-every-route).
- `isMapFile` / `RESERVED_BUNDLE_FILES` (map-store) — one place that knows which bundle
  files are surface maps vs metadata sidecars, so a new sidecar can't read as a phantom
  "new surface".

## [3.8.0] - 2026-07-05

### Added

- **Zero-config out of the box** — `styleproof-init` now scaffolds a crawl-by-default
  spec for any non-Next.js app: `defineCrawlCapture({ from: '/', settle, inventory: true })`
  captures every surface the nav links to (the root plus each same-origin `<a href>`)
  with **nothing to hand-list** — the surface set is discovered from the rendered nav and
  can't drift from it. Next.js keeps filesystem route discovery; both variants now enable
  the inventory guard by default.
- **`defineCrawlCapture` auto-width** — omit `widths` and StyleProof detects each
  discovered surface's `@media` breakpoints and sweeps one viewport per band, the same
  zero-config behaviour explicit surfaces already had.
- **`defineCrawlCapture` `settle` hook** — run an app-specific step (e.g. trigger
  scroll-reveal) after navigating to each crawled surface, for parity with a hand-listed
  surface's `go`.
- **`inventory` spec option** — `defineStyleMapCapture` / `defineCrawlCapture` now forward
  `inventory: true` to the capture, so turning the inventory guard on (a removed nav item
  fails `styleproof-diff`) is a one-line opt-in from a spec, no manual `captureStyleMap`.
- The crawl now always covers its `from` root on an unfiltered crawl, so a home page not
  linked in its own nav — or a single-page app with no links — is still captured.

### Changed

- `styleproof-init` guidance now leads with "it runs on your first PR with no extra
  steps" (CI captures both sides on a cache miss); the local `npx styleproof-map`
  pre-cache is framed as an optional speedup, not a required first step.

### Tests / docs

- **Dogfood: the "100% surfaced" contract** — `test/pr-surfacing.e2e.spec.ts` runs the
  real capture → diff → report flow for every change class (resting style,
  `:hover/:focus/:active` drop, `::before/::after`, DOM add/remove/retag, a removed nav
  item via the inventory guard, a new surface, and a clean no-op) and asserts each is
  surfaced — the last two levels through the actual `styleproof-diff` / `styleproof-report`
  CLIs. Closes the four classes that previously had no end-to-end proof (`:active` drop,
  DOM removed, retag, pseudo-element change).
- **Dogfood: zero-config flow** — `test/cli-flow.e2e.spec.ts` runs `styleproof-init` on a
  real multi-page app and proves the generated crawl spec captures every page (root +
  pricing + about), multi-width, with the inventory harvested — no spec editing.
- **`docs/what-it-catches.md`** — states what StyleProof catches and its honest boundary
  (surfaces it never captured), so a green check is earned, not assumed.

## [3.7.0] - 2026-07-04

### Added

- **Inventory guard** — StyleProof can now assert the navigable UI doesn't silently
  shrink. Opt in with `captureStyleMap(page, { inventory: true })` and each surface's
  navigable affordances — internal route links, `role=tab`, `role=menuitem`,
  button-only nav — are harvested (keyed stably) into `StyleMap.inventory`.
  `styleproof-diff` then unions the reachable set across both sides and **exits 1 on
  any affordance present on base but absent on head** — a feature that stopped being
  reachable — unless it's acknowledged in `styleproof.inventory.json` (`{"<key>":
"<why>"}`, path overridable via `STYLEPROOF_INVENTORY`; a stale acknowledgement is
  flagged so the ledger can't rot). Closes the certification diff's blind spot for the
  information-architecture / replacement class: a redesign staged as a new surface, or
  a nav item / route that disappears, which a same-surface computed-style diff catches
  only incidentally. **Off by default (no map carries inventory ⇒ the CLI is
  byte-for-byte unchanged); the certification diff itself is untouched.** The
  programmatic entry point `auditRunInventory(baseMaps, headMaps, allowRemoved)`
  stays available for custom gates. See `docs/inventory-guard.md`.

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
