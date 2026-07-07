# StyleProof

**StyleProof is a PR gate for visual CSS changes.** You tell it which app states
matter. It opens those states in a real browser, records the browser's computed
styles, compares the PR head against the base branch, and posts a reviewable PR
report. Intentional visual changes get approved; unexpected ones block or fail.

[![npm version](https://img.shields.io/npm/v/styleproof.svg)](https://www.npmjs.com/package/styleproof)
[![CI](https://github.com/BenSheridanEdwards/StyleProof/actions/workflows/ci.yml/badge.svg)](https://github.com/BenSheridanEdwards/StyleProof/actions)
[![license](https://img.shields.io/npm/l/styleproof.svg)](https://github.com/BenSheridanEdwards/StyleProof/blob/main/LICENSE)

## Contents

- [Why](#why)
- [How it works](#how-it-works)
- [Quickstart](#quickstart)
- [What the PR gets](#what-the-pr-gets)
- [Two modes: review or certify](#two-modes-review-or-certify)
- [Coverage: what you own, what's discovered](#coverage-what-you-own-whats-discovered)
- [Declaring surfaces](#declaring-surfaces)
- [Deterministic by default](#deterministic-by-default)
- [Any styling system, real breakpoints](#any-styling-system-real-breakpoints)
- [Match a design pixel-for-pixel](#match-a-design-pixel-for-pixel)
- [Forks and Dependabot](#forks-and-dependabot)
- [Optional: content layer](#optional-content-layer-advisory)
- [Optional: React component layer](#optional-react-component-layer-advisory)
- [Optional: selective remap](#optional-selective-remap-advisory)
- [Reference](#reference)
  - [Blocking without branch protection](#blocking-without-branch-protection)
- [Contributing](#contributing)
- [License](#license)

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
- a required route, component, or UI state that exists but has no capture.

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

Maps travel via the SHA-keyed `styleproof-maps` branch (or a CI artifact for
forks) — **never as files committed to the PR branch**. Committed maps show up
as changed files in every review, and because every PR writes the same paths,
each merge forces every other open PR to rebase. `.styleproof/` and
`stylemaps/` are gitignored to keep that door shut.

## Quickstart

### 0. Install

```bash
npm install -D styleproof @playwright/test
npx playwright install chromium
```

Requires **Node ≥ 18** (ESM), **`@playwright/test` ≥ 1.40** (peer dep). Forced states are Chromium-only.

### 1. Scaffold the gate

```bash
npx styleproof-init
```

`styleproof-init` detects your app and wires **surface discovery** for you — there is nothing to hand-list:

- **Next.js** — it discovers your routes (`app/` + `pages/`) at run time and derives _both_ the captured surfaces and the coverage guard from them, so a route you add later is captured automatically, never a guard failure.
- **Any other app** — it scaffolds a **nav crawl**: StyleProof loads `/`, reads the rendered `<a href>` links, and captures every same-origin surface they point to. The surface set _is_ the nav, so it can't drift from it.

Either way the generated spec runs as-is. It also wires everything around it so the gate behaves the same locally and in CI:

- a dedicated **`playwright.styleproof.config.ts`** that builds and serves a **production build** (never a flaky dev server), scopes discovery to the StyleProof spec, and captures surfaces **in parallel** (`fullyParallel`) without disturbing your app's existing Playwright config;
- widths you never set — **omit `widths`** and StyleProof sweeps your app's real `@media` breakpoints automatically;
- determinism you never set up — network settle, frozen clock, animation freeze, and framework-noise filtering are all on by default (see [Deterministic by default](#deterministic-by-default));
- `.gitignore` entries for `.styleproof/`, `test-results/`, and `playwright-report/`;
- a **cache-first CI workflow** that restores reusable maps from the `styleproof-maps` branch and generates the report without a browser when both maps are already built;
- a **pre-push hook** (`.husky/` if present, else `.githooks/`) that captures each pushed commit and publishes the bundle to the `styleproof-maps` branch — CI's hot path stays report-only, and maps never get committed to the PR branch;
- the **approval workflow** (`styleproof-approve.yml`) that turns the `StyleProof` status green when a reviewer ticks **Approve all changes** — so the review gate is complete, not half-wired (it activates once the init PR merges, since GitHub runs `issue_comment` workflows only from your default branch).

### 2. Capture, then diff

```bash
npx styleproof-map    # capture this commit's computed styles
npx styleproof-diff   # compare against the base branch
```

`styleproof-map` captures the current commit into `.styleproof/maps/current`,
writes a manifest, and uploads the bundle
to the dedicated `styleproof-maps` branch when the working tree was clean and a
git remote is available. Nothing under `.styleproof/` belongs in the PR branch.
HAR recordings are removed before upload by default so private API responses do
not land in the map store. Keep them locally only for an explicit record/replay
workflow with `styleproof-map --keep-har` (or `STYLEPROOF_KEEP_HAR=1`).

`styleproof-diff` restores the base and head maps from `styleproof-maps`
automatically: in GitHub Actions it uses the PR base/head SHAs; locally it checks
`branch.<name>.gh-merge-base`, then the current GitHub PR base via `gh pr view`
(handy for stacked PRs), then `origin/main`, `origin/master`, `main`, and
`master`. Pin the base with `styleproof-diff main` or `styleproof-diff master`.

**That's the whole loop.** The map is built outside CI by default: the
pre-push hook `styleproof-init` installs runs `styleproof-map` on every push
that can affect render (skip one with `STYLEPROOF_SKIP_CAPTURE=1 git push`).
On the PR, CI first restores the base/head bundles and only generates the
report — no build, no browser. If either bundle is missing or incompatible,
CI recaptures both sides in the same pinned environment before reporting.
Correctness wins over a stale cache, but the hot path is report-only.

> **Same-environment note.** Computed styles depend on the browser build and installed fonts, so maps are only comparable when captured in the same runtime environment. StyleProof records a compatibility key to select the right cached bundle and refuses to compare maps captured under different browser/platform settings; CI then recaptures both sides instead of producing a bogus report. Each capture also records the **real browser build** (`browser().version()`) in its manifest — the npm `@playwright/test` version is only a proxy, and the actual Chromium binary can change while it holds constant (a `playwright install` re-download, a different `PLAYWRIGHT_BROWSERS_PATH`, a CI image bump). When both sides carry it, a differing build refuses to compare (exit 2, both builds named) instead of walling the PR with false diffs. This guard needs a `styleproof-manifest.json` on **both** sides; a two-directory `styleproof-diff`/`styleproof-report` where either side lacks one (e.g. a legacy committed-map workflow that ships maps but no manifest) can't verify the environment, so it prints a one-line notice to stderr naming the bare side(s) and compares anyway — exit code unchanged. **Installed fonts are your responsibility:** they are noisy across machines (user-installed families, OS updates, and no cheap cross-platform enumeration), so StyleProof does not fingerprint them — capture both sides on the same fonts, which is what CI's pinned image already gives you.

**Want the local side-by-side report** (not just a pass/fail diff)? Run `npx
styleproof-report` after `styleproof-map`; it uses the same inferred base ref and
the same cached-map defaults as `styleproof-diff`. Pin the base with
`styleproof-report main` or keep the manual form with `styleproof-report before
after --out report`.

### 3. Wire it by hand instead (optional)

`styleproof-init` scaffolds **both** the report workflow _and_ the
`styleproof-approve.yml` handler that flips the `StyleProof` status when a
reviewer ticks the box. GitHub only runs `issue_comment` workflows from the
default branch, so the checkbox goes live the moment you merge the init PR — no
manual copy. If you wire it by hand instead, restore or capture two dirs first,
then use the Action on those dirs:

```yaml
# .github/workflows/styleproof.yml
- uses: actions/checkout@v4
- run: npx styleproof-map --restore --sha "${{ github.event.pull_request.base.sha }}" --dir base --base-dir __stylemaps__
- run: npx styleproof-map --restore --sha "${{ github.event.pull_request.head.sha }}" --dir head --base-dir __stylemaps__
- uses: BenSheridanEdwards/StyleProof@v3
  with:
    baseline-dir: __stylemaps__/base
    fresh-dir: __stylemaps__/head
    require-approval: true # review-gate mode (omit / use fail-on-diff: true to certify)
```

Only for this hand-wired path: copy [`example/styleproof-approve.yml`](https://github.com/BenSheridanEdwards/StyleProof/blob/main/example/styleproof-approve.yml) to `.github/workflows/` **on your default branch** (GitHub only runs `issue_comment` workflows from there, so the approval checkbox is inert until it's merged). `styleproof-init` writes this file for you, so you can skip this step if you used it.

**Prefer to always capture in CI?** For a repo with many outside contributors on different machines, StyleProof can capture **both** base and head in CI and diff them there. See **[Forks and Dependabot](#forks-and-dependabot)** for that flow (it's also the fork-safe split). The default cache-first flow is faster for same-repo teams because the pre-push hook builds the head map before CI starts.

**Want to skip work safely?** Skip the **whole** StyleProof workflow only for
changes that cannot affect rendered output, such as docs-only edits, using your
CI provider's native path filters. Do not skip individual surfaces from a
StyleProof run based on a changed-file guess: shared CSS, tokens, resets,
themes, layout primitives, and runtime styling can repaint any surface, and a
missed surface would certify green without being measured. If you want faster
feedback, order the highest-signal surfaces first in your spec, but still let
the full sweep finish before treating the gate as passed.

```yaml
on:
  pull_request:
    paths-ignore:
      - '**/*.md'
      - 'docs/**'
      - '.github/ISSUE_TEMPLATE/**'
```

## What the PR gets

On every PR, StyleProof posts a small summary comment that links to the committed
full report. The report groups each distinct visual change with:

- before/after crops from the same page rectangle;
- highlighted crops that box the changed element;
- a plain-English summary such as `columns: 2 -> 3` or
  `background brand-cyan -> brand-amber`;
- the exact computed CSS properties that changed.

In review-gate mode, one **Approve all changes** checkbox turns the `StyleProof`
status green for that commit. Clean runs still leave a receipt: `No visual
changes detected.` New surfaces are shown as new baselines and require approval;
coverage gaps are handled by `expected`. When a PR **adds** an element, the
report shows its **full resting computed style** (background, padding, font,
radius, …), value-only, in addition to any interaction-state deltas — so a new
element's whole look is reviewable, not just its `:hover` changes.

### What a report looks like

One change — the hero CTA recoloured cyan → amber — appears as a single section in the report: a side-by-side before/after cropped screenshot, the same crop again with magenta boxes marking exactly what changed, a one-line summary, then the exact property change folded under a toggle. A change too small to see at 1:1 (say a 2px icon tweak) also gets a magnified zoom crop, so a sub-pixel change can't slip past a reviewer.

![A StyleProof report: the CTA button before (cyan) and after (amber), side by side](https://raw.githubusercontent.com/BenSheridanEdwards/StyleProof/main/docs/demo-composite.png)

📄 **[See a full live report](docs/demo/report.md)** — rendered by the current code with real images (clean before/after, the highlighted twin, a magnified zoom for a sub-pixel change, and a `🆕 new surface`). It's regenerated and verified on every PR (`npm run demo:report`), so it always reflects exactly what StyleProof produces today.

As it renders in the committed report (a plain-English bullet first — naming the theme token and showing the hex with a live colour swatch — then the exact table inside the toggle). The PR comment itself stays lean — a summary plus the approval box — and links here:

```text
### `a.btn-solid` · 1 element restyled
_landing @ 1280_

- **`a.btn-solid`** — background `brand-cyan` (`#5fcadb`) → `brand-amber` (`#f59e0b`)

▾ Show the property change
   | Property         | Before    | After     |
   | background-color | #5fcadb   | #f59e0b   |
```

## Two modes: review or certify

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
[Match a design pixel-for-pixel](#match-a-design-pixel-for-pixel).

## Coverage: what you own, what's discovered

The important boundary: **StyleProof only certifies states it can reach.** It
diffs the surfaces your spec lists or discovers — so a page nobody added to
either set is invisible to the gate. Its change has no base capture _and_ no
head capture, so it never appears in any diff, and the status goes green having
never looked at it. This is the one thing the captures can't catch on their
own: a capture that was never taken.

Auto-discovery keeps the boring inventory out of your hands where it can be
inferred safely: Next.js routes, crawlable links, component files, semantic
popups, one-step variants, breakpoints, and volatile/live candidates. You own
the app-specific list of states that matter:

- routes and views belong in `surfaces`;
- open states belong in `variants` or `popups`;
- loading/loaded/empty/error states belong in `liveStates`;
- component catalogs can be wired through `discoverComponentFiles`;
- required-but-not-yet-captured states belong in `expected`, where the coverage
  guard fails until they are captured or explicitly excluded with a reason.

That boundary is deliberate. StyleProof should not guess destructive flows,
auth-only fixtures, or which product state your component needs. It should make
missing coverage loud.

`expected` is what makes it loud. Declare your app's route/view universe in
`expected` and StyleProof emits a coverage-guard test in your **normal** suite
(it runs even without `STYLEMAP_DIR` — it's a static check, no browser). It
fails when `expected` and your captured surfaces diverge — a route you listed in
`expected` with no surface and no `exclude` entry fails as missing coverage, so
a registry entry can't quietly ship uncaptured:

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

What's guarded depends on how `expected` is fed —

- **Next.js:** auto-covered. `styleproof-init` derives both `surfaces` and
  `expected` from the same `discoverNextRoutes()` call, so a new static route lands
  in both at once — captured and expected together, with nothing to keep in sync.
- **Link-crawled SPAs:** pass `expected` to `defineCrawlCapture` and the crawl
  reconciles it against the _rendered nav_ (the route universe for such an app),
  both directions — a new linked route with no `expected` entry fails, and an
  `expected` route the nav stopped linking fails. This runs inside the capture, so
  it fires when you capture (unlike the Next guard, which runs in your plain suite).
- **Other frameworks:** point `expected` at your own route registry.
- **Modals, dropdowns, toasts:** guarded only for the state keys you enumerate in
  `expected` (e.g. `dashboard-dialog-open`) — nothing discovers UI states for you.

## Declaring surfaces

Discovery captures every route your app links to. It deliberately **won't
guess** app-specific states — a modal's open state, an auth-gated view, a
destructive flow, a loading/error render — because guessing one wrong is worse
than flagging it missing. Those are the only things you list by hand, and you
add them to the spec `styleproof-init` already generated. This section covers
each kind.

### Next.js routes: wired for you

Run `styleproof-init` in a Next.js project and the generated spec discovers your routes (App Router `app/` + Pages Router `pages/`) at run time and derives **both** the surfaces and `expected` from that same `discoverNextRoutes()` call. Because they share one source, a static route you add later is captured and expected in the same step — auto-covered, never a guard failure, with nothing to keep in sync. The guard exists for the cases where the two genuinely diverge: a dynamic `[param]` route (it can't be navigated without a value, so it's placed in `exclude` with a reason rather than captured), a registry you hand-maintain instead of the live call, or a route you drop from `surfaces` while it's still `expected`:

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

### Single-route SPAs: crawl the nav

Filesystem discovery can't see a surface that isn't a page — a tab SPA where every view is `/?tab=overview` on one `app/page.tsx`, or anything client-routed. There the surfaces exist only in the rendered nav, as its links. `defineCrawlCapture` discovers them at run time: it loads a root URL, reads its same-origin `<a href>`s, and captures each — so the surface set _is_ the nav, with no list to hand-maintain (and so none to drift).

```ts
import { defineCrawlCapture } from 'styleproof';

defineCrawlCapture({
  from: '/', // crawl the app root for links
  match: /\?tab=/, // keep just the tab views (omit to take every same-origin link)
  widths: [1440, 1024, 768],
  dir: process.env.STYLEMAP_DIR,
});
```

Each discovered link becomes a surface keyed by its URL (`/?tab=overview` → `overview`; pass `key` for a different scheme). The app only has to render its nav as real `<a href>` links — a button-only nav (`<button onClick>`) exposes nothing to crawl. Replay, self-check and clock-freeze behave exactly as for explicit surfaces; one Playwright test runs the whole sweep (the link set isn't known until the page renders).

Pass `expected` (a route registry) to turn the crawl into a coverage guard: the crawl reconciles the rendered link set against it, both directions — a rendered link with no `expected` entry fails as a new route with no owner, and an `expected` route the nav stopped linking fails as a nav regression. For a link-crawled SPA the rendered nav _is_ the route universe, so this is the same list-vs-ledger discipline as the spec guard with the nav as the source of truth. Because the link set isn't known until the page renders, this reconciliation runs _inside the capture test_ — so it fires when you capture (`STYLEMAP_DIR` set), not in every `npm test`, unlike the static Next guard. A link that renders conditionally (behind auth or a feature flag) would otherwise make the guard flaky either direction; list it in `exclude` (`key → reason`) to opt it out visibly — an `exclude` key in neither `expected` nor the rendered nav fails as stale, so the ledger can't rot. Omit `expected` and the crawl keeps its default: capture what the nav links to, assert no completeness.

```ts
defineCrawlCapture({
  from: '/',
  expected: ['index', 'pricing'], // the routes the nav must link to
  exclude: { admin: 'feature-flagged, renders only for staff' },
  dir: process.env.STYLEMAP_DIR,
});
```

### Component inventory: fail when the catalog misses a component

StyleProof cannot render arbitrary component files by itself across frameworks;
props, providers, loaders, portals, and app shell context are app-owned. What it
can do reliably is inventory component files and make your catalog/story route
prove it has a capture for each one:

```ts
import { componentCatalogSurfaces, defineStyleMapCapture, discoverComponentFiles } from 'styleproof';

const COMPONENTS = discoverComponentFiles({
  roots: ['src/components'],
  ignore: [/\/icons\//],
});

defineStyleMapCapture({
  surfaces: componentCatalogSurfaces(COMPONENTS, {
    url: (component) => `/styleproof/components/${component.key}`,
    widths: [390, 1024],
  }),
  expected: COMPONENTS.map((component) => component.key),
  exclude: {
    'component-payment-card': 'needs a billing provider fixture',
  },
  dir: process.env.STYLEMAP_DIR,
});
```

Use Storybook, Ladle, a framework route, or a tiny app-specific catalog for
`/styleproof/components/:key`. The inventory feeds both `surfaces` and
`expected`, so a new component file appears immediately and CI fails until it has
a rendered surface or an explicit exclusion.

### Dialogs, popovers and menus: capture the open state as a variant

StyleProof cannot guess which app-specific button opens a modal, but once you
tell it the interaction, it compares matching states on base and head
(`home-dialog-open` to `home-dialog-open`). Keep these under the route/view that
owns them:

```ts
const SURFACES: Surface[] = [
  {
    key: 'home',
    go: (page) => page.goto('/'),
    variants: [
      {
        key: 'dialog-open',
        go: async (page) => {
          await page.getByRole('button', { name: /open settings/i }).click();
          await page.getByRole('dialog').waitFor();
        },
      },
      {
        key: 'popover-open',
        go: async (page) => {
          await page.getByRole('button', { name: /more/i }).click();
          await page.locator('[popover], [role="menu"]').first().waitFor();
        },
      },
    ],
  },
];
```

Non-live `variants` add captures; the owning surface still captures too. Use
`liveStates` instead when the default live state is too fuzzy and only pinned
states such as `loading`, `loaded`, `empty`, or `error` should be compared.

### Popups, discovered automatically

When `popups: true` is enabled, StyleProof also tries visible safe triggers and
captures opened dialogs, menus, listboxes, modal roots, popovers, tooltips, and
toast/status roots. Each saved map includes `overlays` proof metadata for
semantic roots that were actually present in the computed-style map, so tests can
assert a capture reached `role="dialog"`, `aria-modal`, `role="menu"`,
`role="listbox"`, or hot-toast text.

Triggers are enumerated once per surface and every reopen re-binds to that same
element by identity — its DOM path **and** its accessible label — never by
position. Between popups the surface is reset (Escape + `go()`) and the reset is
verified: if an overlay a previous popup left behind is still visible (Escape
closes dialogs, not toasts or status regions), or an enumerated trigger
disappeared or changed identity (e.g. a same-tag sibling shifted in earlier),
that candidate is **skipped loudly** — a `styleproof:` warning names the popup and
why — instead of capturing contaminated state or keying a popup under the wrong
trigger. Dismiss the leaking overlay in the surface's `go()`, or capture it as an
explicit variant.

### Harvest one-step variants

Routes are not the whole UI: drawers, tabs, dialogs, empty form errors, selects,
and other one-step states need their own captures. `styleproof-variants` opens a
running app, tries semantic controls (`[aria-expanded]`, tabs, summaries,
selects, required forms, etc.), captures a baseline and post-action StyleMap, and
keeps only actions that change computed styles. It also reports live-state
candidates that need fixtures or opt-outs.

```bash
styleproof-variants --base-url http://localhost:3000 --route / --route settings=/settings
```

Use it as a manifest generator, not a replacement for review. To refresh that
manifest as part of the map loop, pass the same crawl inputs to `styleproof-map`;
it runs the crawler before Playwright captures the maps:

```bash
styleproof-map --crawl-base-url http://localhost:3000 --crawl-route / --crawl-route settings=/settings
```

The app must already be reachable at `--crawl-base-url`. If Playwright's
`webServer` is the thing starting the app, keep route-link crawling inside the
capture run with `defineCrawlCapture`.

```json
{
  "routes": [
    {
      "key": "settings",
      "url": "/settings",
      "variants": [
        {
          "key": "plan-selected",
          "action": "select-option",
          "selector": "select[aria-label=\"Plan\"]",
          "value": "pro"
        }
      ],
      "liveStates": [{ "key": "status", "fixtureRequired": true }],
      "skipped": []
    }
  ]
}
```

```ts
defineStyleMapCapture({
  surfaces: [
    {
      key: 'settings',
      go: (page) => page.goto('/settings'),
      variants: [
        {
          key: 'plan-selected',
          go: (page) => page.locator('select[aria-label="Plan"]').selectOption('pro'),
        },
      ],
    },
  ],
});
```

Destructive labels are skipped, duplicate computed-style outcomes are deduped,
and `--strict` exits non-zero when live-state fixtures or skipped candidates
remain unresolved.

### Live UI states: capture each state, not an average

StyleProof automatically detects semantic live-state candidates (`aria-live`,
`role=status`, `role=alert`, `aria-busy=true`) and keeps stable ones in the
normal diff. If a stream, poll, or live region represents product states you
want certified (`loading`, `loaded`, `empty`, `error`), list only those pinned
states with `liveStates`. StyleProof writes separate captures such as
`dashboard-loading@1440` and `dashboard-loaded@1440`, so the base branch's
loading state compares to the feature branch's loading state, and loaded
compares to loaded.

```ts
defineStyleMapCapture({
  dir: process.env.STYLEMAP_DIR,
  surfaces: [
    {
      key: 'dashboard',
      go: (page) => page.goto('/dashboard'),
      widths: [1440, 768],
      liveStates: [
        {
          key: 'loading',
          setup: (page) =>
            page.route('**/api/widgets', (route) => route.fulfill({ json: { status: 'loading', widgets: [] } })),
        },
        {
          key: 'loaded',
          setup: (page) =>
            page.route('**/api/widgets', (route) =>
              route.fulfill({ json: { status: 'loaded', widgets: [{ label: 'Revenue' }] } }),
            ),
        },
      ],
    },
  ],
});
```

## Deterministic by default

A style diff only means something if both sides saw the same inputs; otherwise live-data drift (a backend blip, a `5m ago` timestamp, a status chip that flips) reads as a style change on a PR that touched no CSS. StyleProof handles this for you — **no fixtures required**:

- **Record / replay.** The base capture records each surface's data responses (anything matching `**/api/**`) to a HAR; the head capture replays them, so the head renders _its_ code against the _base's_ data — the app's own JS/CSS still load live. Backend down during a run? Both sides replay the same recording, so there's no phantom diff. Point the head capture at the base's recording with `STYLEPROOF_REPLAY_FROM=<base dir>` (set on the head capture); tune the data boundary with `STYLEPROOF_REPLAY_URL` / `replayUrl` if your API isn't under `/api`.
- **Frozen clock.** `Date.now()` / `new Date()` are pinned to a fixed instant, so time-derived styling (`stale > 1h → red`) can't drift. Timers keep running, so settling still works.
- **Self-check** — captures each surface twice and fails if they differ, so a replay gap or unseeded randomness surfaces as a clear _"non-deterministic capture"_ error, never as a phantom change on an unrelated PR. **On by default while recording** (where live nondeterminism shows up); off on the replay run, which renders against the recorded HAR and is deterministic by construction. `STYLEPROOF_SELFCHECK=1` forces it on for both; `selfCheck: false` opts out.
- **Framework noise is skipped by default.** Non-visual and framework-injected elements never count as a change — `<meta>`/`<title>`/`<script>`/`<style>`/… (which Next.js streams into the body then hoists) and live regions like Next's `next-route-announcer`. A real stylesheet change still shows up in the affected elements' computed styles, not in the `<style>` tag. Add your own selectors with `ignore` — they extend this default, they don't replace it.
- **Layout-equivalent margin noise is normalised.** If the browser reports
  horizontal auto-centering margins (`margin-left`/`margin-right` and logical
  equivalents) differently but the captured document-space rectangle is
  identical, StyleProof treats that as the same rendered layout, including in
  forced `:hover`/`:focus`/`:active` deltas. If the box moves or resizes, the
  margin change still reports.

> Replay covers data the page _fetches_. If your app **server-renders** differently per environment (SSR feature flags, locale), still capture both sides with the same server env so the rendered HTML matches.

**Live pages just work when the intended state is deterministic.** Before each capture, StyleProof settles the page, and the settle is **network-aware**: it holds while the page's data requests are in flight (excluding long-lived `EventSource`/WebSocket streams, which never finish) _and_ until the computed-style map stops changing. So async content (a fetch backfilling a grid, an SSE stream) is captured **loaded, not mid-load** — and, crucially, it **can't false-settle on the loading state before a slow backend's response arrives**. That's the failure mode of a fixed wait: against a slow server (e.g. a dev server under CI load) a timer settles on the loading skeleton one run and the loaded deck the next — a phantom diff / self-check flake. Waiting on the actual request removes it.

Anything still moving on its own after that is detected as a volatile region and excluded from direct element comparison, so a stream or ticker never reads as a change just because its value changed. That is not the same as certifying every state of the live UI: an ignored or volatile subtree can still change `html`/`body` layout if its height changes. When those states matter, make them deterministic `liveStates` (`loading`, `loaded`, `empty`, `error`) and capture each on both branches. Self-check and reports automatically mention detected live-state candidates when volatile layout drift appears. `defineStyleMapCapture` arms the request tracker before each `go()` automatically; for a direct `captureStyleMap` call, arm one before you navigate with `trackInflightRequests(page)` and pass `{ pendingRequests }`. Disable or tune with `{ stabilize: false }` / `{ stabilize: { quietFor, timeout, waitForRequests } }`.

**At a glance — almost everything is automatic.** The few knobs exist only for what StyleProof can't know about your app, and each says why:

| Handled for you — zero config                               | How                                                                                      |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| In-flight data, fonts, late layout                          | network-aware settle holds until requests finish _and_ the computed styles stop changing |
| Animations, transitions, real hover/focus, caret            | frozen / neutralised before the map is read; forced states are captured separately       |
| Clock-derived styling (`stale > 1h → red`)                  | `Date.now()` / `new Date()` frozen to a fixed instant                                    |
| Framework & non-visual noise (`<script>`, route announcers) | skipped by default                                                                       |
| Layout-equivalent horizontal auto margins                   | ignored only when the captured element rectangle is unchanged                            |
| Semantic live-state candidates (`aria-live`, `role=status`) | auto-detected and kept in the diff when stable                                           |
| Live / volatile regions (tickers, third-party embeds)       | auto-detected as still-moving and excluded from direct element comparison                |
| Non-deterministic capture (replay gap, unseeded randomness) | self-check flags it _while recording_, with a named error                                |

| You set this — only because it's app-specific | Why it exists                                                                                                                                                                                                                                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STYLEPROOF_REPLAY_FROM` (record / replay)    | Base and head capture at different times against a live backend; replaying the base's recorded data pins the head to the same inputs, so the diff is **your code, not data drift**. The one piece of real setup.                                                                                         |
| `replayUrl` / `STYLEPROOF_REPLAY_URL`         | Your data endpoints aren't under `**/api/**`.                                                                                                                                                                                                                                                            |
| `ignore: ['.selector']`                       | You want a region gone **explicitly** — auto-exclude already handles most live regions, but a known-noisy element reads clearer named.                                                                                                                                                                   |
| `liveStates: [{ key, setup, go }]`            | A live feature has real states to certify. Capture each state on base and head (`surface-loading`, `surface-loaded`) instead of relying on a single moving page state.                                                                                                                                   |
| `variants: [{ key, setup, go }]`              | Non-live deterministic variants, such as nav-open, modal-open, toast-visible, or overlay-expanded states.                                                                                                                                                                                                |
| `popups: true`                                | Visible click-triggered overlays should be discovered automatically. Captures each matching trigger's persistent dialogs, modal roots, popovers, menus, listboxes, toast/status roots, and open data-state overlays as `surface-popup-XX`; keep hover-only or destructive states as explicit `variants`. |
| `clockTime`                                   | Your styling keys off a **specific** date, not just "now".                                                                                                                                                                                                                                               |
| `stabilize: { quietFor, timeout }`            | An unusually slow surface needs a longer quiet window before the map is read.                                                                                                                                                                                                                            |

### Data residue: a failed data request is named, not swallowed

A subtler gap than a _missing_ surface is a surface that renders the **wrong** state, silently. If a surface requests a data endpoint that nothing routes — no fixture, no `liveStates` — the request falls through and **fails during capture**, so the view paints its _fallback_ branch. Every capture then embeds that fallback; the state its real responses would drive is never captured, and a restyle confined to it ships green. StyleProof used to watch that request fail and say nothing.

Now it names it. During a spec-driven capture, any request matching the data boundary (`replayUrl`, default `**/api/**`) that **fails** — a network error, or a 4xx/5xx — is:

- **warned on stderr, always** (zero-config), naming the surface and endpoint, what it means (the fallback branch was captured; the response-driven states are unproven), and what to do — fixture it with `page.route`/`liveStates`, or acknowledge it;
- **recorded on the capture** (`StyleMap.dataResidue`) so `styleproof-diff` and the report's certification block surface it, deduped per surface·endpoint across widths and the self-check re-run;
- **gated only when you opt in.** Set `dataResidue: 'gate'` on the spec and an _unacknowledged_ failing endpoint blocks the diff (exit 1). Acknowledge intentional ones in `styleproof.data-residue.json` (`{"<surface·endpoint>": "why"}`) — they render as visible opt-outs — and a **stale** acknowledgement (the endpoint no longer fails or isn't present) also fails, so the ledger can't rot. The same `exclude`-ledger discipline as the [inventory guard](docs/inventory-guard.md).

A 2xx endpoint that merely wasn't fixtured is **never** flagged: in recording mode every live response is legitimately recorded, so a blanket "uncontrolled" flag would fire on every healthy record run. Only _failures_ are residue. And StyleProof never synthesises the missing state for you — declaring an app's data states stays app-owned (see the un-exercised-state gap this pairs with). A capture with no failing data request is byte-identical, so existing setups are unaffected.

```ts
// Off by default — warn-only. Opt into the gate:
defineStyleMapCapture({ surfaces: SURFACES, dir: process.env.STYLEMAP_DIR, dataResidue: 'gate' });
```

## Any styling system, real breakpoints

StyleProof reads the browser's **computed styles** — the values it actually resolves — never your source CSS. Tailwind, CSS Modules, styled-components, Sass, vanilla CSS, inline styles: all produce the same computed output, and that's what it diffs. Elements are keyed by **DOM structure, not class name**, so a refactor that rewrites every `class` still lines up element-for-element.

Breakpoints are detected the same way: omit `widths` on a surface and StyleProof reads your app's real `@media` breakpoints from the **loaded CSSOM** at capture time and sweeps one viewport per band — no config. It's framework-agnostic for the same reason the diff is: it reads the rules the browser actually parsed, not your source, so Tailwind / CSS Modules / Sass / vanilla all resolve to the same `@media` boundaries. And it's authoritative **or it fails** — an unreadable cross-origin stylesheet throws rather than silently miss a band; it never guesses. Pin `widths` explicitly when you want a fixed sweep, or to cover a JS-only (`matchMedia`) breakpoint that has no CSS rule.

## Match a design pixel-for-pixel

When you build a design in production, "looks the same" is a judgement call — and small gaps ship. `styleproof-capture` makes it an objective check: point it at the **design** (a deployed mockup, a static export, a standalone HTML file), point it at your **build**, and diff. Zero diff means the production UI renders _identically_ to the design; anything else is named exactly, down to the computed style, so you know precisely what's still off.

```bash
styleproof-capture https://example.com/pricing --key pricing --widths 1440,1024,768 --out design
styleproof-diff design .styleproof/maps/current   # design vs build — zero diff = pixel-identical
```

You watch one number as you implement: the diff starts large and shrinks toward zero, and it hits zero the moment the built page matches the design. It's the objective version of putting the mockup and the app side by side and squinting.

(`styleproof-map` is the spec-driven flow for your own app's surfaces, with the coverage guard, map store, and record/replay; `styleproof-capture` is the one-shot for a page you just point at.) It writes `design/pricing@1440.json.gz` (+ `.png`), the same shape any capture writes, so `styleproof-diff` compares it against anything. Omit `--widths` to auto-detect the page's own `@media` breakpoints; pin them for a page whose CSS is cross-origin (a font stylesheet, say), since detection reads every sheet and fails loudly rather than guess. `--wait <selector>` holds until the intended state is on screen; `--ignore <selector>` skips a live region. Capture both sides in the same browser + fonts, since that's what "identical" is measured against.

### Crawl the whole interactive design: `--crawl`

A design is mostly _behind clicks_ — modals, drawers, popovers, tabs that don't exist in the DOM until you open them. A single capture sees only the landing state. `--crawl` maps the rest for you: point it at the URL and it drives every non-destructive control, keeps whatever opens a structurally new surface, and recurses into it — a modal's tabs, a drawer's sub-views, a popover's panels — capturing each under a derived key. No spec, no selectors, no hand-holding.

```bash
styleproof-capture https://example.com --crawl --out design    # maps every reachable surface
styleproof-diff design .styleproof/maps/current                # diff the whole surface vs your build
```

It's **exhaustive by default**: the crawl stops when there is nothing left to drive — every control tried once, every structurally new surface captured — not at a budget. Dedup bounds the normal case — controls dedup by selector, surfaces by a structural fingerprint, so a finite UI runs out of new surfaces — and the `--max-depth` cap bounds the pathological one: an append-generator (a composer that appends a fresh-identity node per click) never repeats a fingerprint, so dedup can't stop it; the depth cap (16 by default) does. `--max-depth` / `--max-actions` / `--max-states` are otherwise deliberate throttles. It's deterministic (document order; the same surface reached two ways is captured once) and self-settling — it waits for an async app (React/Vue/Babel that boots after `load`) to mount before reading, so a bare crawl of a client-rendered page still captures the mounted UI.

What makes exhaustive affordable is that the sweep works **in place**: standing in a state, each control is clicked right where the page is, and a cheap DOM fingerprint decides what happened — a no-op click costs nothing, and only a state-changing click pays a reset (fresh navigation + replay of the click-path), which is then **verified by fingerprint** so children are never attributed to the wrong parent. New surfaces are captured at every width the moment they're reached — a deep or animated click-path is never re-driven to capture, so it can't be the thing that drops a surface. Progress streams as it goes, one line per captured surface. And it's **parallel by default** — `--workers <n>` (default 4) sweeps states concurrently on isolated browser contexts with the exact same surface set as a serial crawl (dedup is shared; children only enter the queue when their parent's sweep completes); `--workers 1` if you want byte-stable dup-key attribution.

**And it proves nothing was missed.** After the crawl, StyleProof compares every class the page's own stylesheets define (read from the parsed CSSOM) against the classes actually rendered across the captured surfaces, and prints what — if anything — was never seen. `--require-full-coverage` turns any residue into exit code 4, so "the design is fully covered" is a CI-checkable property, not a judgement call. What's left is either dead CSS (delete it) or a state the crawl couldn't reach (drive it with a spec, or file the gap).

**Destructive-looking controls (delete, deploy, pay, revoke…) are never clicked** — mapping must not mutate; states gated behind one of those need a spec. Prefer the spec-driven `defineStyleMapCapture` when you want stable, named keys and the coverage guard; reach for `--crawl` to map a design (or a third-party page) you don't have a spec for.

### Data states, out of the box

Every data-driven page has states that almost never sit on a click path: the **loading skeleton** and the **error render**. The crawl captures both automatically — it watches the entry page's data requests, then re-loads once with them **stalled** (the skeleton is the settled state, captured as `loading`) and once with them **fulfilled as 500** (captured as `error`). States that render identically to the base (e.g. server-rendered pages) dedup away silently. On by default; `--no-data-states` to skip. Deeper data states — a specific empty list, a partial payload — are fixture territory: model them as `liveStates`/`variants` in a spec.

### Input-gated states: `--setup`

A crawler clicks and selects; it does not guess your password. States behind typed input — a login, an unlock code, a seeded search — become crawlable with a deterministic setup file, run after **every** fresh navigation so each reset re-establishes the gate identically:

```json
[
  { "action": "fill", "selector": "#user", "value": "${CAPTURE_USER}" },
  { "action": "fill", "selector": "#pass", "value": "${CAPTURE_PASS}" },
  { "action": "click", "selector": "#sign-in" },
  { "action": "waitFor", "selector": ".dashboard" }
]
```

```bash
CAPTURE_USER=demo CAPTURE_PASS=… styleproof-capture https://example.com --crawl --setup login.json --out design
```

`${ENV_VAR}` in `value`/`url` is interpolated from the environment at load time — **credentials never live in the file, the shell history, or the captured maps.** A non-optional step that fails aborts the crawl loudly (a half-established gate must never silently crawl the ungated page); mark a step `"optional": true` when it legitimately may not apply (a cookie-session app that shows the login form only once).

### What the crawler can and cannot reach — honestly

The crawl's vocabulary is **click, select, neutral typing, scrolling, and your setup steps** — and it sweeps the page's real `@media` breakpoints automatically when you give it none. Within it, mapping is exhaustive. Outside it, states are not reached by crawling — and the coverage verifier is what keeps that honest: anything unreached is _named_, never silently missed.

| State                                                                        | Reached by                                                                                                                                                                            |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Click-opened surfaces (modals, drawers, popovers, tabs, toggles)             | crawl, automatically                                                                                                                                                                  |
| Mode × sibling combinations (a tab's edit state, a decided list's other tab) | crawl — family retry                                                                                                                                                                  |
| Loading / error data states of the entry page                                | crawl — automatic data states                                                                                                                                                         |
| Login / unlock / typed input                                                 | `--setup` steps                                                                                                                                                                       |
| `:hover` / `:focus` / `:active` styling                                      | the forced-state layer of every capture                                                                                                                                               |
| Deeper data states (empty, partial, streaming)                               | spec `liveStates` / `variants` with fixtures                                                                                                                                          |
| States behind destructive actions                                            | a spec, deliberately — the crawl never clicks them                                                                                                                                    |
| Drag-and-drop, keyboard-shortcut, scroll-triggered states                    | a spec driving them explicitly                                                                                                                                                        |
| Components not mounted anywhere in the UI                                    | a component catalog page (each component per prop-state is a surface — Storybook/Ladle stories work; `discoverComponentFiles` fails CI when a component file has no captured surface) |

The rule of thumb: **a rendered state is a function of props, data, and input.** Control all three — mock the data, script the input, mount the component — and every state a component can render is a capturable surface. The verifier tells you, by name, which ones you haven't controlled yet.

## Forks and Dependabot

If you **always capture in CI** rather than restoring maps from `styleproof-maps` (a better fit when many outside contributors push from different machines), the simplest setup runs the whole gate in one `pull_request` job that captures base + head and diffs them. That job needs a **write** token to push the report branch, post the comment, and set the `StyleProof` status. That's fine for same-repo PRs, but **fork and Dependabot PRs run with a read-only `GITHUB_TOKEN`** (GitHub's security default for untrusted PRs). So the job can't post the status — and a required `StyleProof` check then sits `pending` forever, blocking the PR even though a dependency or fork change usually touches no UI at all.

Fix it by splitting capture from reporting, the way the approve workflow is already split out:

- **[`example/styleproof-capture.yml`](example/styleproof-capture.yml)** runs `on: pull_request` with a **read-only** token and no secrets — safe to run untrusted PR code. It only builds, captures the style maps, and uploads them as an artifact.
- **[`example/styleproof-report.yml`](example/styleproof-report.yml)** runs `on: workflow_run` (after capture finishes) from your **default branch** with a write token. It downloads the artifact and does the diff, comment, and status — but **never checks out or runs the PR's code**, only the trusted style-map data.

That last point is why this works where `pull_request_target` does not: StyleProof builds and serves the PR's head, so running it under `pull_request_target` would hand a write token (and your secrets) to untrusted code — the exact supply-chain risk StyleProof exists to help you catch. The `workflow_run` split keeps the privileged half away from PR code entirely.

**Where the PR identity comes from.** The report stage comments on the PR and sets the `StyleProof` status against a specific PR number and head commit, so those values have to be trustworthy. It takes them from the trusted `workflow_run` event — `head_sha`, then the event's `pull_requests`, with a commit→PR lookup against that **same trusted head SHA** for fork PRs (whose association the event doesn't carry directly) — and **never** from the downloaded artifact. The artifact is produced by the untrusted capture job, so treating anything in it as identity would let a malicious PR point the privileged comment and status at a victim PR or an arbitrary commit (a confused-deputy attack). The artifact therefore carries only the style-map captures, consumed purely as diff input.

Copy both `capture` and `report` files to `.github/workflows/` (the `report` one must be on your default branch, like `styleproof-approve.yml`), then require the `StyleProof` status in branch protection. A single combined `pull_request` job that captures base + head and diffs them is fine for repos that never see fork or bot PRs; this split is only needed for untrusted PRs.

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

## Optional: selective remap (advisory)

On a large app, capturing every surface on every PR is the slow part. `affectedSurfaces` answers the question that lets you skip most of it: **given the files a change touched, which declared surfaces could have rendered differently?** Everything it doesn't return can reuse its restored base map.

It is **opt-in and never part of the default gate** — the gate still captures every surface and lets the map be the oracle. This is a helper for wiring a faster pre-push/CI path yourself, and it is built to be wrong only in the safe direction: when it cannot _prove_ a surface is unaffected, it returns the sentinel `'all'` (re-capture everything). A global stylesheet or token, a vanilla (unscoped) stylesheet, a `createGlobalStyle`, a design-system config, an unbounded `import(x)`, or a file it can't place — all resolve to `'all'`.

The module graph is an **input**, so StyleProof stays framework-agnostic and adds no dependency. Produce it with any tool whose output you can shape into `{ from, to }` edges — [dependency-cruiser](https://www.npmjs.com/package/dependency-cruiser)'s `modules[].dependencies[]` maps directly:

```ts
import { affectedSurfaces } from 'styleproof';
import { readFileSync } from 'node:fs';

// A dependency-cruiser run: `depcruise src --no-config --output-type json`
const cruise = JSON.parse(readFileSync('dc.json', 'utf8'));
const graph = cruise.modules.flatMap((m) =>
  (m.dependencies ?? []).map((d) => ({ from: m.source, to: d.resolved, dynamic: d.dynamic })),
);

const result = affectedSurfaces({
  changedFiles: ['src/components/PriceTable.tsx'], // e.g. `git diff --name-only origin/main`
  surfaces: { home: 'src/pages/Home.tsx', pricing: 'src/pages/Pricing.tsx' },
  graph,
  files: cruise.modules.map((m) => m.source),
  readFile: (p) => readFileSync(p, 'utf8'),
});
// → Set { 'pricing' }  (capture only these; reuse the base map for the rest)
// → 'all'              (some change couldn't be bounded — capture everything)
```

Two honest limits, both resolving to `'all'`: a computed `import(`../dir/${x}`)` is treated as a bundler **context module** (every file under that dir is a possible target, so precision there is directory-level, never a miss); and a CSS-Module (`.module.scss`/`.module.sass`) that carries a Sass `@use`/`@forward` load resolves to `'all'`, because those pull in a partial the JS import graph can't bound. One honest **residual** stays `'scope'` by design: the CSS-in-JS global list (`createGlobalStyle`, `injectGlobal`, `globalStyle`, …) must match the libraries you use — an allowlist can't fail closed on an _unknown_ member, so an unrecognized global API in a `.tsx` is the one way a scoped verdict could be unsound. Treat an unsupported styling system as a reason to skip selective remap. Because a PR-time miss would be silent, always let `main` (or a scheduled run) capture **all** surfaces as the trust-but-verify net.

### Show the skip list, then wire the pre-push hook

Before you trust a skip, print it. `explainAffectedSurfaces(result, allSurfaceKeys)` renders the verdict as reviewer-checkable lines — which surfaces re-capture and which reuse their restored base map — and takes an optional reason string for the `'all'` case:

```ts
import { affectedSurfaces, explainAffectedSurfaces } from 'styleproof';

const result = affectedSurfaces(/* … */);
console.log(explainAffectedSurfaces(result, Object.keys(surfaces)));
```

A scoped change (only `dashboard`'s subtree touched) prints:

```
selective remap: ON → re-capture 1, reuse 2 from base
  ↻ dashboard (re-capture — a changed file reaches it)
  ✓ home (reuse base map — no changed file reaches it)
  ✓ pricing (reuse base map — no changed file reaches it)
```

A global/token change fails closed to a full re-capture:

```
selective remap: OFF → re-capture all 3 surface(s) — src/tokens.css is a global (unscoped) stylesheet
  ↻ dashboard (re-capture)
  ↻ home (re-capture)
  ↻ pricing (re-capture)
```

Wired into a pre-push hook, the whole recipe is: diff the changed files, produce the graph, ask `affectedSurfaces`, print the skip list, then capture only the subset and reuse the base maps restored from `styleproof-maps` for the rest.

```sh
#!/usr/bin/env sh
# .husky/pre-push (opt-in; the default CI gate still captures every surface)
CHANGED=$(git diff --name-only origin/main...HEAD)
npx dependency-cruiser src --no-config --output-type json > dc.json
node scripts/selective-remap.mjs "$CHANGED" dc.json   # affectedSurfaces + explain + capture subset
```

`scripts/selective-remap.mjs` is yours to own — it maps `dc.json` into `{ from, to }` edges (as above), calls `affectedSurfaces`, prints `explainAffectedSurfaces`, then captures only the returned keys and copies each reused surface's restored base map forward. `main` re-captures everything, so a PR-time miss is still caught at merge.

## Reference

**Action `BenSheridanEdwards/StyleProof@v3`** — key inputs:

| Input              | Default      | Purpose                                                                             |
| ------------------ | ------------ | ----------------------------------------------------------------------------------- |
| `fresh-dir`        | _required_   | PR-head captures restored from `styleproof-maps` or freshly captured in CI.         |
| `baseline-dir`     | _required_   | Base-branch captures dir restored from `styleproof-maps` or freshly captured in CI. |
| `require-approval` | `false`      | Review-gate mode: set the `StyleProof` status instead of failing.                   |
| `fail-on-diff`     | `true`       | Certify mode: fail on any diff. Ignored when `require-approval` is true.            |
| `status-context`   | `StyleProof` | Commit-status name. Must match the approve workflow and branch protection.          |

Outputs: `changed` (`"true"` when any existing surface changed, or a new surface needs approval), `report-url`. Other inputs (`report-branch`, `github-token`) have sensible defaults — see [`action.yml`](https://github.com/BenSheridanEdwards/StyleProof/blob/main/action.yml).

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

| Option        | Default                     | Purpose                                                                                                                                                                                                                                                                                                |
| ------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `surfaces`    | _required_                  | Page states to certify — each `{ key, go, widths?, ignore?, height?, liveStates?, variants?, popups? }`. `go(page)` drives to a settled state. Omit `widths` to auto-detect the app's `@media` breakpoints and sweep one width per band.                                                               |
| `liveStates`  | _none_                      | Optional pinned live product states. Each `{ key, setup?, go?, widths?, height?, ignore? }` becomes `<surface>-<state>` and is labeled as a live state in reports.                                                                                                                                     |
| `variants`    | _none_                      | Optional non-live deterministic states under a surface. The base surface still captures; each variant becomes `<surface>-<variant>` so base/head compare matching states.                                                                                                                              |
| `popups`      | `false`                     | Optional automatic popup capture. Set `true` or `{ max, triggers, overlays, timeoutMs }` to click visible safe triggers and save each opened overlay state as `<surface>-popup-XX`; maps include `overlays` proof metadata for captured semantic roots.                                                |
| `expected`    | _none_                      | Your route/view/state/component universe. Emits a coverage-guard test (runs without a capture dir) that fails when a required key has no surface and isn't excluded.                                                                                                                                   |
| `exclude`     | `{}`                        | `key → reason` for routes deliberately not captured. Keeps the guard green for known gaps; a key absent from `expected` fails the guard, so the ledger can't go stale.                                                                                                                                 |
| `dir`         | `STYLEMAP_DIR`              | Output label (`base`/`head`); the spec is **inert until set**, so it sits safely beside your other specs.                                                                                                                                                                                              |
| `replayFrom`  | `STYLEPROOF_REPLAY_FROM`    | Baseline dir whose recorded responses to replay. Unset → this run **records** its HAR for the comparison to use.                                                                                                                                                                                       |
| `replayUrl`   | `**/api/**` (`…REPLAY_URL`) | URL glob for the data boundary to record/replay; everything else (JS/CSS/fonts) loads live so the code runs.                                                                                                                                                                                           |
| `dataResidue` | `'warn'`                    | Name data-boundary (`replayUrl`) requests that **fail** during capture (network error / 4xx/5xx — the fallback branch got captured). Always warned + recorded; `'gate'` also blocks the diff on an unacknowledged one. See [Data residue](#data-residue-a-failed-data-request-is-named-not-swallowed). |
| `freezeClock` | `true`                      | Pin `Date.now()`/`new Date()` so time-derived styling can't drift; timers keep running so settling still works.                                                                                                                                                                                        |
| `clockTime`   | `2025-01-01T00:00:00Z`      | The frozen instant.                                                                                                                                                                                                                                                                                    |
| `selfCheck`   | on while recording          | Capture each surface twice and fail on any difference — proves the capture is deterministic. Off on the replay run; `STYLEPROOF_SELFCHECK=1` forces both.                                                                                                                                              |
| `screenshots` | `true`                      | Save full-page screenshots for the report's before/after crops.                                                                                                                                                                                                                                        |
| `baseDir`     | `__stylemaps__`             | Output root directory.                                                                                                                                                                                                                                                                                 |

Non-visual and framework-injected elements (`<meta>`/`<title>`/`<script>`/`<style>`/… and `next-route-announcer`) are skipped automatically; a surface's `ignore` adds to that default, it doesn't replace it.

**Capture env vars** (wire CI without editing the spec):

| Env                         | Purpose                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `STYLEMAP_DIR`              | Output label; the capture is skipped entirely when unset.                                                             |
| `STYLEPROOF_BASEDIR`        | Output root dir (runner default `__stylemaps__`; `styleproof-map` CLI default `.styleproof/maps`).                    |
| `STYLEPROOF_SCREENSHOTS`    | `0` to skip full-page screenshots. The CLI keeps screenshots by default so reports can crop maps restored from cache. |
| `STYLEPROOF_REPLAY_FROM`    | Baseline dir to replay recorded data from — set this on the **head** capture.                                         |
| `STYLEPROOF_REPLAY_URL`     | Override the `**/api/**` data-boundary glob.                                                                          |
| `STYLEPROOF_SELFCHECK`      | `1` to capture each surface twice and fail if the two differ.                                                         |
| `STYLEPROOF_UPLOAD`         | `1` to require map-store upload; `0` to capture locally only.                                                         |
| `STYLEPROOF_CACHE_BRANCH`   | Map store branch (default `styleproof-maps`).                                                                         |
| `STYLEPROOF_SKIP_CAPTURE`   | `1` to skip the scaffolded pre-push capture/publish hook for one push.                                                |
| `STYLEPROOF_CRAWL_BASE_URL` | App URL for the optional pre-map `styleproof-variants` crawl.                                                         |
| `STYLEPROOF_CRAWL_ROUTES`   | Comma-separated routes for the optional pre-map crawl, e.g. `/,settings=/settings`.                                   |
| `STYLEPROOF_CRAWL_STRICT`   | `1` to fail the optional pre-map crawl on live-state fixtures or skipped candidates.                                  |

**CLIs** (every flag accepts `--flag value` and `--flag=value`; `--help` lists all):

- `styleproof-init` — scaffold the gate: the capture spec, a dedicated `playwright.styleproof.config.ts` (production-build `webServer`, parallel capture), `.gitignore` cache entries, the cache-first report workflow, the approval workflow, and the pre-push publish hook. One command. Generated commands follow the repo's lockfile (`bun.lock`/`bun.lockb`, `pnpm-lock.yaml`, `yarn.lock`, or npm by default), respect pnpm/Corepack version pins, and detect Vite/Next production preview commands instead of assuming every repo has `start`.
- `styleproof-map` — capture the current commit's computed-style map through Playwright. By default it writes `.styleproof/maps/current`, keeps screenshots for reports, writes a manifest, and uploads to `styleproof-maps` outside CI when the working tree was clean and a git remote exists. Pass `--crawl-base-url` plus repeated `--crawl-route` to run `styleproof-variants` before capture, `--no-upload`, `--restore --sha <commit>`, `--spec`, `--dir`, `--base-dir`, or `--no-screenshots` for custom flows.
- `styleproof-diff` — the certify gate. With no args, it restores cached maps for the current commit and inferred base (`GITHUB_BASE_REF`, `branch.<name>.gh-merge-base`, `gh pr view`, then main/master fallbacks); `styleproof-diff main` / `styleproof-diff master` pins the base; `styleproof-diff <beforeDir> <afterDir>` keeps the manual two-directory form for CI fallback captures. Exits `0` certified (identical); `1` on a reviewable diff — computed-style/DOM/state differences, and equally an unacknowledged inventory removal, an unacknowledged failing data endpoint under an armed `dataResidue: 'gate'`, an incomplete coverage registry, or an unproven-determinism capture; `2` on a usage/capture error (including a **missing map** — a bundle that claims to exist yet holds zero captures, i.e. a `styleproof-manifest.json` present with no maps, on either side, or a head capture that produced nothing; refused loudly rather than mislabelled as all-new — **and** the no-args case where the cached base map can't be restored at all: no map-store remote, no cached bundle, nothing to compare. A "nothing was compared" outcome always exits `2`, never a soft `0` that would read as certified; the error names the two ways forward — run in CI where the base is restorable, or use the two-directory form); `3` when only new surfaces are present (no baseline for _those_ surfaces to diff against — new surfaces against an existing baseline, or a base dir with no manifest at all, meaning no baseline was ever captured: the first-adoption review path; approval policy decides whether to gate). A clean run prints `0 changed surfaces across N captured surface(s)`, and `--json` includes `compared`. The human output **groups the same way the report does**: surfaces that changed identically collapse into one finding (with the per-surface count on its header), longhands fold into shorthands, and size/position-derived longhands fold behind a `(+N derived longhands)` count — so one real change reads as one entry, not dozens of raw lines. A change that rode the shared frame every view draws (a persistent nav/header/footer) is promoted to a "🧱 Global chrome change" callout up top. `--json` stays the complete, unchanged machine contract — every surface and every raw longhand — regardless of the human grouping.
- `styleproof-report` — render the diff to a Markdown report with before/after crops. With no args, it reports cached maps for the current commit against the inferred base; `styleproof-report main` / `styleproof-report master` pins the base; `styleproof-report <beforeDir> <afterDir> --out <dir>` keeps the manual two-directory form. Add `--include-content` for the opt-in, advisory content section (see above).
- `styleproof-capture` — one-shot capture of any URL (a design mockup, a deployed page) without a spec; `--crawl` maps every reachable surface. See [Match a design](#match-a-design-pixel-for-pixel).
- `styleproof-variants` — crawl a running app for one-step state variants and write `styleproof.variants.generated.json`. Pass `--base-url`, repeat `--route`, and use `--strict` when unresolved skipped/live candidates should fail automation.

A programmatic API is also exported — `captureStyleMap`, `diffStyleMaps`, `generateStyleMapReport`, and the breakpoint helpers `detectViewportWidths` / `widthsFromBoundaries`, among others. For the capture internals, the approve-workflow trust model, and how to contribute, see [CONTRIBUTING](https://github.com/BenSheridanEdwards/StyleProof/blob/main/CONTRIBUTING.md) and the [`example/`](https://github.com/BenSheridanEdwards/StyleProof/tree/main/example) workflows.

## Contributing

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
