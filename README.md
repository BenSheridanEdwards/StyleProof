# playwright-stylemap

**Prove a CSS refactor changed nothing.** Capture the browser's *computed styles* — every
resolved longhand on every element, every pseudo-element, every forced
`:hover`/`:focus`/`:active` state, swept across your breakpoints — then diff before
against after. If the diff is empty, the refactor is certified: not "looks the same",
but *resolves byte-for-byte the same*.

Built for CSS-to-Tailwind migrations, design-system swaps, stylesheet consolidation,
and any refactor where "trust me, it's identical" isn't good enough.

```
home@1280: 1 element(s) differ
  body > main:nth-child(2) > section:nth-child(5) > a:nth-child(1)  (.cta)
    border-bottom-color: rgb(95, 202, 219) → rgb(229, 231, 235)
    border-bottom-style: none → solid

  [:hover] body > nav:nth-child(1) > a:nth-child(3)
    border-color: rgb(95, 202, 219) → (state no longer changes it)

✗ 1 DOM change(s), 2 computed-style difference(s), 1 state-delta difference(s) across 12 surfaces
```

## Why not screenshots?

Pixel diffing is the right tool for *catching* visual drift, but it cannot *certify* a
refactor, because most of a stylesheet is invisible to a screenshot:

- **Hover, focus, and active states.** A deleted `:hover` rule renders identically
  until a human points a mouse at it. This tool forces each pseudo-class through the
  Chrome DevTools Protocol (`CSS.forcePseudoState`) and records exactly what each
  state changes — including parent-state rules that restyle descendants.
- **Hidden elements.** A closed mobile menu is `display: none` in every screenshot,
  but its panel, items, and animations still have computed styles — and they're
  compared.
- **Between-breakpoint rules.** Screenshots sample two or three viewports. The style
  map sweeps one width per `@media` band, so a dropped `max-width: 680px` override is
  caught even if your screenshot widths never land in that band.
- **Sub-threshold drift.** Every pixel comparison needs a tolerance for antialiasing,
  and a tolerance is a place for a real 1px change to hide. Computed values need no
  tolerance: `13.5px` either equals `13.5px` or it doesn't.
- **Declared motion.** Transitions and animations are captured as declared longhands
  (then frozen so every other value is a settled end state), so changing
  `transition: all .2s` to `.3s` is a diff even though no still image could see it.

Screenshots and style maps complement each other: pixels catch what you forgot to
model, the style map certifies what pixels can't see. Use both.

## How it works

1. **Capture** (`captureStyleMap(page)`) walks every element and records each computed
   longhand, pruned against per-tag UA defaults (measured live in a stylesheet-free
   iframe) so files stay small. Pseudo-elements (`::before`, `::after`, `::marker`,
   `::placeholder`) are included. Interactive elements get each pseudo-class forced
   via CDP, captured as a delta over the element's subtree.
2. **Keys are DOM structure**, never class names — `body > nav:nth-child(3) >
   a:nth-child(2)` — so a migration can rewrite every `class` attribute freely while
   the map stays comparable. If the DOM itself changes, the diff says so loudly: a
   CSS-only refactor must not touch structure.
3. **Diff** (`stylemap-diff before/ after/`) compares every map and reports DOM
   changes, computed-style differences, and state-delta differences, naming the exact
   element and property. Exit code 0 means certified.

Custom properties (`--*`) are deliberately ignored: they are inputs, not outcomes.
Every visual effect of a variable lands in a real longhand that *is* compared — so
renaming a token is invisible, while changing what an element resolves to is not.
(This also silences Tailwind's `--tw-*` machinery.)

## Quickstart

```sh
# not yet on npm — install from GitHub:
npm i -D github:BenSheridanEdwards/playwright-stylemap @playwright/test
```

(A runnable version of the spec below lives in [`example/`](example/).)

Write a capture spec listing your **surfaces** — each one a deterministic page state
plus the viewport widths to sweep:

```ts
// e2e/stylemap.spec.ts
import { defineStyleMapCapture, type Surface } from 'playwright-stylemap';

const SURFACES: Surface[] = [
  {
    key: 'home',
    go: async (page) => {
      await page.goto('/', { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
    },
    ignore: ['.live-feed'],        // nondeterministic regions, skipped entirely
    widths: [1280, 768, 390],      // one per @media band of the route's CSS
  },
  {
    key: 'home-menu-open',         // states matter: model them as surfaces
    go: async (page) => {
      await page.goto('/', { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'Menu' }).click();
    },
    widths: [390],
  },
];

defineStyleMapCapture({ surfaces: SURFACES, dir: process.env.STYLEMAP_DIR });
```

Then certify a refactor — **always against a production build**, dev servers inject
their own styles:

```sh
STYLEMAP_DIR=before npx playwright test stylemap   # capture the baseline
# ...refactor your CSS...
STYLEMAP_DIR=after  npx playwright test stylemap   # capture again
npx stylemap-diff __stylemaps__/before __stylemaps__/after
```

An empty diff is the certificate. A non-empty diff names every element, property, and
state that drifted.

## Visual reports: side-by-side crops for PR review

When the diff is *intentional*, you don't want a wall of longhands — you want to look
at it. `stylemap-report` turns a diff into a reviewable report: it finds the
**outermost changed element** (descendants of other changed elements fold into their
ancestor), merges nearby regions, zooms out with padding, crops the before/after
full-page screenshots at identical dimensions, and stitches them into one labelled
side-by-side image per change:

![before ◀ │ ▶ after](docs/demo-composite.png)

<sub>◀ before  ·  after ▶ — grey bar = before, blue bar = after</sub>

…followed by exactly what changed, including state deltas no screenshot could show:

```
- body > main … > a:nth-child(3)  (.sc-run.reveal.d2…)
  - border-top-color: rgb(31, 113, 128) → rgb(217, 162, 74)
  - [:hover] border-top-color: rgb(95, 202, 219) → (state no longer changes it)
```

The whole imaging pipeline is Playwright + Node — **no browser interaction**. Captures
save a full-page screenshot next to each map by default (disable with
`screenshots: false`), so the committed baseline carries both the facts and the pixels;
generating a report never rebuilds the old code.

```sh
stylemap-report <beforeDir> <afterDir> --out report/ [--image-base-url <url>]
```

writes `report.md` (renders the composite images), `report.json` (machine-readable),
and `crops/*.png` (composite + the individual before/after crops).

### PR comments via GitHub Action — works in private repos

The repo ships a composite action that diffs against your committed baseline and, on
changes, commits the report to a branch and links it from a PR comment:

```yaml
- name: Capture style maps
  run: STYLEMAP_DIR=ci npx playwright test stylemap

- name: Style-map report
  uses: BenSheridanEdwards/playwright-stylemap@main
  with:
    baseline-dir: e2e/__stylemaps__/baseline
    fresh-dir: e2e/__stylemaps__/ci
    # report-branch: stylemap-reports   # default
    # fail-on-diff: 'true'              # default
```

The comment links to **`📊 View the side-by-side visual report →`**, and the property
diff sits in a `<details>`. The job fails while changes are unapproved; **approving =
regenerating the committed baseline** from the new build and pushing it with the PR.
The comment updates in place on every push and flips to ✓ when the diff is clean.

#### Why a link, not an image embedded in the comment body

This is the one GitHub-imposed subtlety. There are two ways an image can appear on a
PR, and they have **opposite** privacy behaviour:

| Placement | How GitHub fetches it | Private repo |
| --- | --- | --- |
| In a **comment body** (`![](url)`) | anonymously, via the Camo proxy | a private URL **404s → broken image**; only a public URL renders |
| In a **committed file** (`report.md` with relative `crops/…`) | through **your authenticated session** | **renders inline** — same as a private README's images |

So the action commits the report and links it: you click once and see the side-by-side
crops rendered inline, with no public hosting and no browser. (Embedding the image
*directly in the comment body* of a private repo is genuinely impossible from CI —
GitHub's only private-friendly image URL is `user-attachments`, whose upload endpoint
rejects API tokens with HTTP 422 and requires a logged-in browser session. If you want
that, an AI agent with browser access — e.g. Claude Code with the Chrome MCP — can
upload via the web UI; CI cannot.)

## CI gate

Commit a baseline capture (the `.json.gz` files are small — a content-heavy page
gzips to ~80 KB), then have CI capture fresh and diff:

```yaml
- name: Style-map regression
  run: |
    STYLEMAP_DIR=ci npx playwright test stylemap
    npx stylemap-diff e2e/__stylemaps__/baseline e2e/__stylemaps__/ci
```

After an *intentional* style change, regenerate the committed baseline and commit it
with your diff — the gate is a ratchet, not a freeze.

**Capture baselines in CI's environment.** Anything that changes what renders —
feature flags, API tokens that gate a panel, env-dependent copy — must match between
the baseline capture and CI's fresh capture. If your local `.env` makes the page
render more than CI will, baselines captured locally can never pass on the runner.
(Ask how we know.)

## What this caught in production

This tool was extracted from a real CSS-to-Tailwind migration (~680 lines of bespoke
CSS across four stylesheets, certified to zero diff). Every one of these was caught by
the style map and invisible or ambiguous to pixels:

- **A base-layer reset eating button borders.** `button { border: none }` in the
  global stylesheet meant `border` + `border-color` utilities (width and color only)
  rendered *no border at all* — the style stayed `none`. Every bordered button needed
  an explicit `border-solid`. The diff named all of them.
- **`grid-cols-2` is not `1fr 1fr`.** Tailwind's `repeat(2, minmax(0, 1fr))` removes
  the min-content floor. One panel had been quietly *overflowing* its grid track by
  8px; the utility version clamped it, reflowing 50 elements. Also: on
  `display: none` elements the two forms serialize differently, so hidden layouts
  diverge even when visible ones match.
- **`outline-none` is not `outline: none`.** Tailwind's utility is a 2px transparent
  outline (an accessibility affordance). The forced-`:focus` capture flagged three
  new longhands the original never set.
- **Shorthand resets.** `border-bottom: none` resets style *and* color to initial;
  zeroing just the width (`border-b-0`) leaves the preflight's gray `solid` behind.
  Same story for `hover:shadow-*` (prepends ring placeholders), `rounded-full`
  (`9999px` vs `50%`), `items-start` (`flex-start` vs `start`), and named font
  utilities (dropped fallbacks from the stack).
- **A dropped `:hover` rule on a link** that every screenshot tool sailed past,
  because nothing hovers in a screenshot.

## API

```ts
import {
  captureStyleMap, saveStyleMap, loadStyleMap,
  defineStyleMapCapture, diffStyleMaps, diffStyleMapDirs, generateStyleMapReport,
} from 'playwright-stylemap';

// Capture the current page state (drive it there first). Each element carries
// its document-space bounding box, so reports can crop screenshots around it.
const map = await captureStyleMap(page, { ignore: ['.live-feed'] });

// Persist / read (.json or .json.gz by extension).
saveStyleMap('maps/home@1280.json.gz', map);
const before = loadStyleMap('maps/home@1280.json.gz');

// Generate capture tests from a surface list (see Quickstart). Saves a
// full-page screenshot per capture unless screenshots: false.
defineStyleMapCapture({ surfaces, dir: process.env.STYLEMAP_DIR, baseDir: '__stylemaps__' });

// Structured diffing and report generation, same engines as the CLIs.
const findings = diffStyleMaps(before, map);
const { surfaces, counts } = diffStyleMapDirs('maps/before', 'maps/after');
generateStyleMapReport({ beforeDir: 'maps/before', afterDir: 'maps/after', outDir: 'report' });
```

CLIs:

- `stylemap-diff <beforeDir> <afterDir> [--max N] [--json <file>]` — exit 0
  identical, 1 differences, 2 usage error.
- `stylemap-report <beforeDir> <afterDir> --out <dir> [--image-base-url <url>]` —
  exit 0 no changes, 1 report generated, 2 usage error.

## Caveats

- **Chromium only** for the forced-state capture (it uses CDP). Base captures work in
  any Playwright browser.
- **Same machine, same browser version** for before/after captures: computed values
  are far less platform-sensitive than pixels, but font metrics can differ across
  OSes.
- Layout-derived values (used track sizes, element heights) are part of the map — by
  design. If text content changes between captures, expect diffs; capture the same
  build state.
- Forced-state capture is O(interactive elements × 3 states); a content-heavy page
  takes a few seconds per surface.

## License

MIT © Ben Sheridan-Edwards
