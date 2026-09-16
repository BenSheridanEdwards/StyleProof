# StyleProof

**StyleProof's job is a deterministic way to see visual regressions on the
frontend. Here's what a report looks like.**

StyleProof opens the app states you care about in a real browser, compares the
base and head by computed CSS, and posts the evidence to the pull request.
Intentional changes get approved. Unexpected changes block.

[![npm version](https://img.shields.io/npm/v/styleproof.svg)](https://www.npmjs.com/package/styleproof)
[![CI](https://github.com/BenSheridanEdwards/StyleProof/actions/workflows/ci.yml/badge.svg)](https://github.com/BenSheridanEdwards/StyleProof/actions)
[![license](https://img.shields.io/npm/l/styleproof.svg)](https://github.com/BenSheridanEdwards/StyleProof/blob/main/LICENSE)

On a pull request, the PR comment is the same linked summary for public and private repositories.
Reports publish as workflow artifacts by default — the comment links the artifact on the run, and nothing is written to repository git history. `report-storage: branch` opts back into the `styleproof-reports` orphan branch for an in-browser rendered report.
Crops travel inside the published report package instead of being duplicated into the comment.
Private-repository viewers need repository access and an authenticated GitHub session.
If publication or receipt verification fails, StyleProof posts no delivery claim for that run.
The README can carry the crops directly. The block below is a real run, not a mockup:
`scripts/live-readme-report.mjs` captures `example/demo/index.html` in Chromium twice, injecting a
fixed CSS change between the captures, then renders the report and the PR comment it would post. The
block is that comment, with three edits for this page: crop links repointed at
`docs/readme/live-report/crops/`, element-level sections reordered so Save at rest comes before the
Docs hover, focus, and active states, and `report.json` left out of the committed bundle. Every
finding, value, and crop is what the run produced. Both sides of each interaction-state crop are in
that state.

<!-- styleproof-report -->

## 🗺️ StyleProof report

**2 computed-style difference(s) · 3 state-delta difference(s)** across 1 distinct change(s) in 1 changed surface base with an existing baseline.
_**Surface base** = one product UI state; capture keys with `@width` or live-state/popup variants are width or state captures of that base._

## Element-level changes

### `button.btn` · 1 element restyled

_demo-button @ 900_

`padding` `14px 28px` → `18px 32px`<br>
`background-color` `#14b8a6` → `#dc2626`

![before ◀ │ ▶ after](docs/readme/live-report/crops/demo-button-900-4-composite.png)

<sub>◀ before · after ▶ — demo-button @ 900</sub>

![highlighted before ◀ │ ▶ after](docs/readme/live-report/crops/demo-button-900-4-annotated.png)

<sub>🔍 magenta boxes mark each change — changed: `button.btn`</sub>

**`button.btn`**

Style:

| Property           | Before      | After       |
| ------------------ | ----------- | ----------- |
| `padding`          | `14px 28px` | `18px 32px` |
| `background-color` | `#14b8a6`   | `#dc2626`   |

### `a.link` · 1 element restyled `:hover`

_demo-button @ 900_

_Both sides are :hover. Left is the old :hover. Right is the new :hover._

`:hover` `color` `#a5f3fc` → `#fca5a5`

![base :hover ◀ │ ▶ head :hover](docs/readme/live-report/crops/demo-button-900-1-composite.png)

<sub>◀ base :hover · head :hover ▶ — both sides are :hover</sub>

![highlighted base :hover ◀ │ ▶ head :hover](docs/readme/live-report/crops/demo-button-900-1-annotated.png)

<sub>🔍 magenta boxes mark each change — changed: `a.link`</sub>

**`a.link`**

Interactive-state changes:

| State    | Property | Before → After        |
| -------- | -------- | --------------------- |
| `:hover` | `color`  | `#a5f3fc` → `#fca5a5` |

### `a.link` · 1 element restyled `:focus`

_demo-button @ 900_

_Both sides are :focus. Left is the old :focus. Right is the new :focus._

`:focus` `outline-color` `#5eead4` → `#fca5a5`

![base :focus ◀ │ ▶ head :focus](docs/readme/live-report/crops/demo-button-900-2-composite.png)

<sub>◀ base :focus · head :focus ▶ — both sides are :focus</sub>

![highlighted base :focus ◀ │ ▶ head :focus](docs/readme/live-report/crops/demo-button-900-2-annotated.png)

<sub>🔍 magenta boxes mark each change — changed: `a.link`</sub>

**`a.link`**

Interactive-state changes:

| State    | Property        | Before → After        |
| -------- | --------------- | --------------------- |
| `:focus` | `outline-color` | `#5eead4` → `#fca5a5` |

### `a.link` · 1 element restyled `:active`

_demo-button @ 900_

_Both sides are :active. Left is the old :active. Right is the new :active._

`:active` `color` `#2dd4bf` → `#f87171`

![base :active ◀ │ ▶ head :active](docs/readme/live-report/crops/demo-button-900-3-composite.png)

<sub>◀ base :active · head :active ▶ — both sides are :active</sub>

![highlighted base :active ◀ │ ▶ head :active](docs/readme/live-report/crops/demo-button-900-3-annotated.png)

<sub>🔍 magenta boxes mark each change — changed: `a.link`</sub>

**`a.link`**

Interactive-state changes:

| State     | Property | Before → After        |
| --------- | -------- | --------------------- |
| `:active` | `color`  | `#2dd4bf` → `#f87171` |

- [ ] **Approve all changes**

---

_Tick **Approve all changes** to turn the **StyleProof** check green — write access required, and not the pull request author. One tick signs it off. A new push that changes styles or surfaces re-opens it._

**[Quickstart](#quickstart)** ·
**[Read the catch contract](docs/what-it-catches.md)**

## Why

Use StyleProof when a PR can change CSS, design tokens, component classes,
layout, or hidden/open UI states and you want CI to say whether the browser's
rendered styles actually changed. Unit and e2e tests prove behavior; StyleProof
proves the visual contract for the states you declared.

It catches:

- a button recoloured by a token, utility class, CSS module, inline style, or
  design-system change;
- a layout shift at one breakpoint but not another;
- a dropped `:hover`, `:focus`, or `:active` style;
- a modal, menu, listbox, popover, sheet, or toast whose open state changed;
- a supposedly no-op refactor, such as CSS-to-Tailwind, that changed rendered
  output;
- a restyle on an element the PR also re-nested (a wrapper added or removed),
  paired back by geometry so the structural churn cannot hide it;
- a required route, component, or UI state that exists but has no capture.

The end-to-end catch contract lives in
[docs/what-it-catches.md](docs/what-it-catches.md).

## How it works

1. A **surface** is one UI state to certify: a route, tab, modal-open state,
   dropdown-open state, toast-visible state, loading state, etc.
2. You list or auto-discover surfaces in a Playwright-style spec.
3. StyleProof opens each surface at real breakpoint widths and records computed
   styles for every captured element.
4. On a PR, it compares base vs head and reports exactly which rendered styles
   changed.
5. The PR gets a `StyleProof` status: green when nothing changed, red until
   someone approves intentional changes, or failing when certification mode is
   configured.

StyleProof is not a screenshot diff. Screenshots appear in the report so humans
can see the change, but the gate compares browser-computed CSS: resolved
longhands, pseudo-elements, layout boxes, motion longhands, and forced
`:hover`/`:focus`/`:active` deltas.

## Quickstart

### Set up everything

```bash
npx styleproof setup
```

That one command detects npm, pnpm, Yarn, or Bun; installs StyleProof and
Playwright; installs Chromium; scaffolds the capture spec, a dedicated
production-build Playwright config, and **one GitHub workflow**; then verifies
every machine-owned file against the installed release. The default scaffold is
the smallest honest gate: one `pull_request` job captures base and head in the
same run and diffs them — maps live as workflow artifacts, no map-store branch,
no pre-push hook — and the gate runs **advisory**: it reports evidence on every
PR without blocking. Preview the exact operations without writing with
`npx styleproof setup --dry-run`. In a monorepo, target the consumer
application explicitly:

```bash
styleproof setup --project-dir apps/web
```

`--project-dir` changes where dependencies are installed and all setup commands
run. `--dir` remains the capture-spec path inside that project, for example
`--project-dir apps/web --dir e2e/styleproof.custom.spec.ts`.

Opt-in flags reproduce the heavier architectures:

- `--workflow split` — a read-only `pull_request` capture job plus a trusted
  `workflow_run` report job. Required when the repository accepts **fork or
  Dependabot PRs**, whose tokens are read-only.
- `--storage branch` — the SHA-keyed `styleproof-maps` store branch plus the
  pre-push publish hook, so CI restores maps instead of recapturing them.
- `--mode certify` / `--mode review-gate` — fail on any diff, or hold the
  `StyleProof` status red until a reviewer approves (scaffolds the approval
  workflow). `split + branch + review-gate` reproduces the pre-v7 scaffold
  exactly.

Existing scaffolds keep their architecture: a marker in the generated workflow
records the chosen mode, and `styleproof-init --check` / `--upgrade` verify
that mode's file set instead of rewriting it.

### The one CLI

```bash
styleproof capture          # capture this commit from the generated spec
styleproof crawl <url>       # direct URL or rendered-nav crawl
styleproof compare [base]    # fail-closed base/head comparison
styleproof report [base]     # generate the review report on command
styleproof variants          # inspect surface/state variants
styleproof affected          # resolve surfaces affected by source changes
styleproof ci                # CI orchestration: restore probes, cold capture
styleproof store import ...  # migrate a v1 bundle into immutable evidence
styleproof store verify ...  # verify a ref and every referenced byte
styleproof store restore ... # atomically restore a verified ref
```

Run `styleproof --help` for the whole journey or `styleproof <command> --help`
for command-specific options. The existing `styleproof-*` binaries remain as
backwards-compatible aliases for one major version.

### Capture, then compare

```bash
npx styleproof capture    # capture this commit's computed styles
npx styleproof compare    # compare against the base branch
```

`capture` writes the current commit's map under `.styleproof/maps/current`
with a manifest; `compare` restores base and head and fails closed when the
evidence cannot certify. Maps travel as **workflow artifacts** by default —
never committed to the PR branch — or via the opt-in `styleproof-maps` store
branch. Nothing under `.styleproof/` belongs in a commit.

For the hand-wired Action form, the fork/Dependabot split, the map-store and
report branches, the pre-push hook, and every config key and flag, see
[docs/REFERENCE.md](docs/REFERENCE.md).

## Two modes: review or certify

The scaffold's default gate is **advisory** — the evidence posts on every PR
without blocking. These are the two gate modes you opt into:

**Review-gate mode** (`require-approval: true`) is for normal feature work:
every visual change is reported with evidence, the `StyleProof` status stays red
until a reviewer ticks **Approve all changes**, and approved changes become the
new baseline on merge. A surface that exists only on the PR head is still
reviewable: it holds the status red until approved, then becomes part of the
baseline once merged.

**Certify mode** (`fail-on-diff: true`) proves a change touched _nothing_
visual: any difference at all fails the job. It's the job StyleProof was born
for — certifying a CSS-to-Tailwind migration rendered byte-for-byte identical.
Reach for it on any change whose whole promise is "the output is unchanged": a
utility-class migration, a design-system swap, a dependency or build-tooling
bump. Zero diff is the contract; one drifting longhand is a regression to
investigate, not a change to approve.

There's also a third, spec-less use — pointing the one-shot capture at a design
mockup and diffing your build against it until the number hits zero. See
[Match a design pixel-for-pixel](docs/REFERENCE.md#match-a-design-pixel-for-pixel).

## What a green certifies

A passing check is more than "no style changed". Four gates qualify it, and the
report leads with their verdicts:

- **Coverage** — the `expected` registry travels with the captured bundle as a
  ledger, so the gate states its completeness basis: `✓ coverage complete`,
  `✗ coverage INCOMPLETE` (blocks — a registered surface wasn't captured, even
  on an empty diff), or `✗ completeness NOT asserted` (no registry / filtered
  capture — blocks certification unless `--allow-unasserted` diagnostic mode).
- **Determinism** — the ledger records how each capture proved itself
  (`self-checked` / `replayed`); a green from an `unproven` **or unknown**
  capture blocks, because a clean diff of two nondeterministic (or pre-ledger)
  reads could just be luck. Pass `--allow-unasserted` only for explicit
  diagnostic compares (`certifiesFully: false` in JSON).
- **Inventory** — with `inventory: true` (on in `styleproof-init` scaffolds),
  each capture harvests the surface's navigable affordances (links, tabs, menu
  items, keyed by stable identity, not label text). A removal that makes a
  feature unreachable **gates** — in the `styleproof-diff` CLI and in the
  Action, both modes — until acknowledged in `styleproof.inventory.json`
  (`{"<key>": "<why>"}`); a stale acknowledgement is flagged so the ledger
  can't rot. Details and the keying rules:
  [docs/inventory-guard.md](docs/inventory-guard.md). Make it advisory in the
  Action with `"gateInventoryRemovals": false` in `styleproof.config.json`.
  **Without `inventory: true` the check does not run, and StyleProof says so**:
  the report reads `⚠ not checked` rather than `✓ navigable set unchanged`, and
  the Action warns that the gate could not run. An empty inventory diff is
  indistinguishable from "nothing was removed", so a ✓ there would claim a
  guarantee the run never earned.
- **Failed data request**: a data-boundary request that **failed** during capture
  means the fallback UI was captured, not the state its responses drive.
  Gating is the default (`dataResidue: 'gate'`): an unacknowledged failing
  endpoint blocks until declared in `styleproof.data-residue.json`, and a
  stale declaration also fails. Opt down with `dataResidue: 'warn'`. See
  [Failed data request](docs/REFERENCE.md#failed-data-request-a-failed-api-call-is-named-not-swallowed).
- **Product-state identity** — a pair with matching `productState {id, revision}`
  is comparable and can certify. Undeclared legacy pairs stay on the visual-review
  path until you arm the declare gate: add `styleproof.product-state.json`
  (`{"<surface>": "<why>"}`), pass `--legacy-pairs`, or set
  `productState.requireIdentity: true` / `--require-state-identity`. StyleProof's
  own live dogfood arms this ledger so undeclared `home@*` pairs cannot stay
  green. Armed and **undeclared** → fail closed (`CERTIFICATION_FAILED`) in the
  CLI, Action verdict, and PR comment. Armed and **declared** →
  explicit advisory, never a certified green. Details:
  [docs/product-state-comparability.md](docs/product-state-comparability.md).

Those verdicts roll up into one more line the report always states: the
**confidence ledger** (`styleproof-confidence.json`, bundled next to the maps).
It assigns every surface one status — `captured`, `excluded-with-reason`,
`inaccessible` (an auth wall or blocked continuation), `unknown` (declared but
never captured), or `unproven-determinism` — and renders a completeness badge
(`✓ complete`, `⚠ limited`, `⚠ unasserted`, `⚠ unknown`) **separate from the
visual verdict**: a visual PASS and a complete capture are two claims, never one
green. Crawl captures persist the ledger themselves (auth walls travel with the
bundle); spec captures derive it from the coverage ledger; bundles from before
the ledger existed read `⚠ unknown` and are never blocked retroactively. No
coverage percentage is ever invented for surfaces that cannot be enumerated.
The same summary lands machine-readably in `report.json` (`confidence`).

## The boundary

StyleProof certifies only what it captured: a surface that was never captured
has no base and no head map, so its change can never appear in a diff and the
gate stays green having never looked at it. The coverage guard
(`expected`/`exclude`), the confidence ledger, the inventory guard, the
data-residue gate, and product-state identity exist to make every one of those
gaps loud instead of silent — full rules in
[docs/REFERENCE.md](docs/REFERENCE.md).

The sharpest form of the boundary: maps prove only the states the spec
exercises. A restyle confined to a conditional render branch the fixture never
drove — a fault overlay, an empty state — produces byte-identical honest
captures on both sides. Every conditional branch whose styling matters needs a
surface that exercises it; see
[the un-exercised-state gap](docs/REFERENCE.md#the-un-exercised-state-gap-an-honest-green-gate-can-still-miss-a-real-restyle)
and [what the crawler can and cannot reach](docs/REFERENCE.md#what-the-crawler-can-and-cannot-reach--honestly).

## Reference

Every flag, config key, Action input, workflow file, hook behavior, exit code,
and optional layer lives in [docs/REFERENCE.md](docs/REFERENCE.md). Deeper
contracts: [what it catches](docs/what-it-catches.md) ·
[component manifests](docs/component-manifest.md) ·
[evidence store v2](docs/evidence-store-v2.md) ·
[inventory guard](docs/inventory-guard.md) ·
[product-state comparability](docs/product-state-comparability.md) ·
[report delivery](docs/report-delivery-contract.md) ·
[setup server contract](docs/setup.md) ·
[forced-state limits](docs/forced-state-capture.md).

## Contributing

Repository CI runs the full browser suite in two file-level shards alongside the
Node 18/20/22 unit matrix. The `e2e (node 22)` aggregate compares completed test IDs
against a separately collected full inventory and requires the five-run determinism
receipt. Missing, duplicated, skipped, failed, or retried tests fail verification.
The `browser-evidence-node-22` artifact retains the inventory, shard results, and
oracle receipt for 30 days. Local `npm run test:e2e` still runs the complete suite.

The repository also carries a source-bound detection benchmark for
[#447](https://github.com/BenSheridanEdwards/StyleProof/issues/447). The frozen
Phase-0 corpus `styleproof-issue447-phase0-full@2.0.0` holds 23 mutants across
computed-style, forced-state, cross-element, structural, and no-op classes. Run
`npm run bench:detection -- --corpus bench/detection-corpus-v2.json --out <new-dir> --scope full --expect-source-sha $(git rev-parse HEAD)`
from a clean checkout; `--scope diagnostic --case ID[,ID...]` and
`--scope sharded --shard I/N` run bound subsets, and `--scope smoke --case ID`
checks a single case. The committed [full-corpus receipt](docs/proof/issue-447/full-v2-run-1/receipt.json)
recorded 23 requested, 23 executed, 23 valid, 18 detected, 1 missed (a rendered
image change with no computed-style correspondence, by design), 1 no-op false
positive, and 3 no-op true negatives. It is not class-wide recall evidence or
whole-application coverage.

See [CONTRIBUTING](https://github.com/BenSheridanEdwards/StyleProof/blob/main/CONTRIBUTING.md)
for the dev loop, and [AGENTS.md](https://github.com/BenSheridanEdwards/StyleProof/blob/main/AGENTS.md)
(the same file as `CLAUDE.md`) for the operating rules and agent tooling. The repo
is wired for Claude Code with **Ponytail** (default lazy-coding mode), **GitNexus**
(code-intelligence graph — MCP server in [`.mcp.json`](.mcp.json), skills in
`.claude/skills/gitnexus/`), and **Graphify** (`/graphify` knowledge graph). The
GitNexus index (`.gitnexus/`) and Graphify output (`graphify-out/`) are gitignored;
build the index with `npx gitnexus analyze`.

## License

MIT © Ben Sheridan-Edwards
