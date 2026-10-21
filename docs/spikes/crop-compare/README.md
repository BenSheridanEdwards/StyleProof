# Spike: crop compare layout, slider interaction, and report hosting

A throwaway prototype for [#792](https://github.com/BenSheridanEdwards/StyleProof/issues/792) (side-by-side vs
slider) and [#793](https://github.com/BenSheridanEdwards/StyleProof/issues/793) (scrubber vs hover-to-reveal). It
feeds [NORTH_STAR](../../NORTH_STAR.md) § _The redesign_ item 7 and § _Open decisions_ 1 and 2.

It does **not** change product behaviour. Nothing under `src/`, `bin/`, `test/` or `action.yml` changes, and
`docs/spikes/` is not in the package `files` list, so it does not ship. It does **not** settle the decisions. It shows
the options so the owner can decide.

## Open it

Open `docs/spikes/crop-compare/index.html` from a checkout of this repository. It works from `file://`. It is one
self-contained page with inline CSS and JS, no build step, no network and no libraries. The crops load by relative path
(`../../demo/crops/…`, `../../proof/…`), so the page must stay inside the checkout.

Query parameters, for scripted screenshots:

- `?width=1280` fixes the report container at 1280px (desktop preset).
- `?width=390` fixes it at 390px (mobile preset). Every crop uses the slider.
- No `width`: the container fits the window, up to 1280px. Resize the window to see the rule work.
- `?interaction=scrubber` selects the scrubber (the default).
- `?interaction=hover` selects hover-to-reveal.

Example: `index.html?width=390&interaction=hover`. The on-page toggles set the same state. They try to write it back
to the URL; some browsers refuse `history.replaceState` on `file://`, and the toggles still work when they do.

With JavaScript off, every crop renders as a static before/after pair, stacked when two copies do not fit. Nothing
depends on the slider working.

## The crops

All four are real images already committed to this repository. None was made for this spike.

1. **Narrow: `span.content-label` on home@900.** `docs/demo/crops/home-900-content-2-composite.png`, split at
   runtime. Each side 424×180. **Side-by-side at 1280.** A report crop that fits twice. The change (an `Old` → `New`
   label) is small; the demo report adds a 2× zoom for it.
2. **Hard to find: `::marker` colour.** `docs/proof/issue-447/full-v2-run-1/cases/computed-pseudo-marker-color-v2/`
   `before.png` and `after.png` (#447 benchmark render proof). About 640×100 (see the note below). **Slider at 1280
   expected.** A bullet a few pixels wide turns green → red and nothing else moves. This is the real "find the change
   without guessing" test.
3. **Wide: board@800 band.** `docs/proof/rect-inner-scroll/crops/board-800-1-composite.png`, split at runtime. Each
   side 800×424. **Slider at 1280.** A report crop wider than half the container.
4. **Full page: inner-scroll shell at 800px.** `docs/proof/fullpage-inner-scroll/before-unexpanded.png` (800×800) and
   `after-expanded.png` (800×2000). **Slider at 1280.** A real full-page pair with different heights, so it tests a
   tall slider. The pair compares two capture paths, not a CSS edit (see its README); the page says so.

At 390px every crop uses the slider.

Note on sizes: the shell in this session could not run an image tool, so the sizes above come from the proof READMEs,
from the composite geometry below, and from viewing the files. The page does not trust them. It reads each image's
`naturalWidth`/`naturalHeight` at runtime and prints the measured size and the computed mode on every crop. If the
marker pair is narrower than 616px, the page will show it side-by-side at 1280 and say why.

### Split geometry for composites

`docs/demo/crops/*-composite.png` and `crops/*-composite.png` are one image holding both sides. `compositePair` in
[`src/report/png.ts:65-78`](../../../src/report/png.ts) lays them out with `PAD = 20` and `GAP = 28`:

- each panel is `w = (compositeWidth − 68) / 2` wide and `h = compositeHeight − 40` tall;
- before starts at `(20, 20)`; after starts at `(20 + w + 28, 20)`.

So `home-900-content-2-composite.png` (916×220) gives two 424×180 panels at x = 20 and x = 472, and
`board-800-1-composite.png` (1668×464) gives two 800×424 panels at x = 20 and x = 848. The page cuts each panel out
with `background-size` and `background-position` (no copies). The no-JS markup carries these numbers. The script
recomputes them from the loaded file and prints a warning on the crop if the markup disagrees.

## Decision 1: the threshold (#792)

The prototype uses a **crop-size rule**, measured against the report container, not the viewport:

```text
available  = width of the crop area inside the report container (CSS px)
crop width = max(before natural width, after natural width)

if available < 600:                       slider  (mobile: every crop)
else if 2 × crop width + 16 <= available: side-by-side
else:                                     slider
```

At the 1280px preset the container has 16px padding on each side, so `available = 1248` and crops up to 616px wide go
side by side. At 390px, `available = 358`, which is under 600, so every crop slides. The rule is in code, not a config
knob. The page states it at the top, prints each crop's numbers, and re-evaluates on resize (`ResizeObserver`).

What to look at:

- Toggle **Desktop 1280px** and **Mobile 390px**. The narrow crop switches from side-by-side to slider. The others stay
  sliders.
- Choose **Fit window** and make the window narrower. The narrow crop switches below 864px available (2 × 424 + 16).
- Ask whether 2 × width + gap is the right bar, or whether a crop should go side by side only if it also stays above a
  minimum scale.

Why crop size and not viewport width: a viewport rule gives a 424px crop and an 800px crop the same layout on the same
screen, and one of them is then wrong. The crop-size rule includes the viewport anyway, because the container shrinks
with it. The 600px floor covers the one thing crop size alone misses: on a phone, two copies of even a small crop are
too small to compare.

**Prototype recommendation:** crop size against the container, as above. The owner decides.

## Decision 2: the slider interaction (#793)

Both interactions run on the same crops. Switch with **Slider interaction**.

- **Scrubber (default):** a visible track above the crop with a thumb, and a divider line with a grip. Drag either with
  mouse, pen or touch (Pointer Events with pointer capture, so the drag keeps working off the crop). The grip is a
  `role="slider"` with `aria-valuemin`/`max`/`now`, `aria-valuetext` and an `aria-label`. Arrow keys move 1%,
  Shift+Arrow 10%, PageUp/PageDown 10%, Home/End go to the edges. On tall full-page crops the track stays at the top of
  the viewport and the grip stays in view (`position: sticky`).
- **Hover-to-reveal:** the divider follows the mouse across the crop. On touch, a tap or a horizontal drag moves it,
  and a vertical drag still scrolls the page (`touch-action: pan-y`). The grip stays keyboard operable.

What to look at:

- On the `::marker` crop, try to find the change with each interaction before you open "Where is the change?".
- On the full-page crop, scroll down to the magenta band and compare. With hover the divider follows every mouse move,
  so it moves while you scroll and read. The scrubber stays where you left it.
- At 390px, try both on a touch device or with touch emulation.

**Prototype recommendation:** make the scrubber the primary and default interaction, as the owner directed. It works
the same with mouse, touch and keyboard. It stays where the reviewer puts it, which matters on tall crops and when you
take a screenshot to share. Hover is quick for sweeping a small crop with a mouse, but it has no resting state, its
touch behaviour is a fallback that turns into a scrubber anyway, and keyboard users still need the slider. The prototype
keeps hover as a switch so the owner can compare. The lean is to leave it out of the product unless that comparison
shows it finds changes faster. The owner decides.

## Why hosting matters

A slider needs JavaScript. Where the report is opened decides whether JavaScript can run.

What the code does today (read at this commit):

- `writeReportArtifacts` writes `report.html` next to `report.md` and `report.json`
  ([`src/report/sections.ts:328-340`](../../../src/report/sections.ts)). It is a static render of the Markdown with a
  `<style>` block and no script ([`src/report/html.ts`](../../../src/report/html.ts)).
- The default `report-storage` is `artifact` ([`action.yml:31-39`](../../../action.yml)). The whole
  `styleproof-report` directory, including `report.html`, uploads with `actions/upload-artifact`, kept for
  `report-retention-days` (default 30) ([`action.yml:40-42`](../../../action.yml),
  [`action.yml:720-728`](../../../action.yml)). The comment links the artifact on the run
  ([`src/report-delivery.ts:62-79`](../../../src/report-delivery.ts)).
- With `report-storage: branch`, `collectReportFiles` publishes only `report.md`, `report.json` and the crop PNGs to the
  report branch ([`src/report-publish.ts:161-173`](../../../src/report-publish.ts), the list is built at line 166).
  `report.html` is not published. The comment links GitHub's Markdown blob view,
  `https://github.com/<repo>/blob/<sha>/pr-<n>/report.md`
  ([`src/report-delivery.ts:35-38`](../../../src/report-delivery.ts)).

So `report.html` reaches a reviewer only inside the workflow artifact, or in a local `styleproof-report/` run. The blob
view renders Markdown through GitHub's sanitiser. It never runs script and strips arbitrary CSS, so a slider cannot
work there. NORTH_STAR redesign item 6 says branch mode "already renders in-browser"; in the code it renders as
GitHub's Markdown view, not as `report.html`.

## Hosting options

"Unverified" marks facts I took from memory of GitHub's and vendors' documentation and could not check in this session
(no network). Plans and limits change; check them before deciding.

### (a) Status quo: Markdown blob view (branch mode) and artifact HTML (default)

- Private repos: yes.
- Who can see it: anyone with read access to the repo; for a public repo, everyone.
- JS: blob view no. Artifact HTML yes, once downloaded and opened from disk.
- Consumer setup: none beyond today.
- Risk: crops stay on GitHub under repo permissions. Branch mode keeps them in git history until pruned.
- Latency: blob view as soon as the commit lands; artifact as soon as the upload finishes.

### (b) GitHub Pages serving the report branch

- Private repos: Pages on a private repo needs a paid plan (Pro, Team or Enterprise) — unverified. On those plans the
  site is **public** even though the repo is private, unless the org is on Enterprise Cloud and uses private Pages
  access control — unverified.
- Who can see it: a public site is open to anyone with the URL. Private Pages: people with read access — unverified.
- JS: yes.
- Consumer setup: enable Pages and pick a source. A branch source runs GitHub's Pages build (Jekyll unless the branch
  has `.nojekyll`). An Actions source needs a deploy job with `pages: write` and `id-token: write`. A repo has one Pages
  site, so this collides with a repo that already publishes docs on Pages. StyleProof would also have to start
  publishing `report.html` to the branch (today it does not; see above).
- Risk: for most private repos, crops of the app under review become public. That is the main risk. Fork PRs cannot
  deploy (no write token).
- Latency: a build or deploy per publish, usually about a minute; the Pages CDN can serve a stale copy for some minutes
  — unverified.

### (c) raw.githubusercontent.com or htmlpreview-style proxies

- Private repos: raw needs a token in the URL; public proxies can only fetch public repos.
- Who can see it: raw, repo readers; a proxy, anyone, plus the proxy operator.
- JS: raw serves files as `text/plain` (with `nosniff` — unverified header detail), so the browser shows source, not a
  page. Not viable.
- Consumer setup: none, but it does not work.
- Risk: a third-party proxy fetches and may log the report. A token in a URL leaks access.
- Latency: immediate.

### (d) Workflow artifact HTML download (today's default storage)

- Private repos: yes.
- Who can see it: signed-in users with read access to the repo. Download needs sign-in even on public repos —
  unverified.
- JS: yes, after unzip and open from disk. This spike shows `file://` is enough for a slider viewer.
- Consumer setup: none; it is the default.
- Risk: crops stay on GitHub and expire with retention (30 days by default here; GitHub's maximum depends on plan and
  repo settings — unverified). Nothing is written to git history.
- Latency: available as soon as the upload finishes, but download, unzip and open is three steps, and there is no
  inline view.

### (e) External static host (S3 + CloudFront, Cloudflare Pages, Netlify, Vercel)

- Private repos: yes, if the host's access control is set up.
- Who can see it: whoever the host lets in. The default for most is anyone with the URL. Access control (Cloudflare
  Access, Netlify or Vercel password or SSO) is often a paid tier — unverified.
- JS: yes.
- Consumer setup: an account, a deploy secret in the repo, a deploy step and access-control config. Fork PRs do not get
  secrets.
- Risk: crops of the app leave GitHub for a third party. CI holds a deploy secret. It adds a service to an Action that
  needs none today.
- Latency: seconds to a minute per deploy — unverified.

### (f) Open locally with a CLI

`gh run download` (or a future StyleProof helper, not built) fetches the artifact and opens `report.html`.

- Private repos: yes. Who can see it: whoever can download the artifact. JS: yes.
- Consumer setup: `gh` installed and signed in.
- Risk: same as (d).
- Latency: one command instead of three clicks.

### (g) Gist, PR comment, check-run summary

All render sanitised Markdown. No JS, so no slider. They suit the static fallback only.

### Hosting recommendation

1. **Keep the artifact as the default**, and make an interactive `report.html` the thing inside it. It works for
   private repos, keeps crops on GitHub under repo permissions, writes nothing to git history, and needs no setup. The
   spike shows the viewer can be one self-contained file that runs from `file://`, so it needs no host. The cost is the
   download and unzip. A later CLI helper (option f) could cut that to one command.
2. **Offer GitHub Pages as an opt-in, documented for public repos only.** It gives a one-click in-browser report. Do
   not recommend it for private repos unless the owner confirms the org has private Pages: on most paid plans a Pages
   site from a private repo is public, which would publish crops of an unreleased app. It also needs `pages: write` and
   `id-token: write`, collides with an existing Pages site, and adds a deploy delay.
3. **Do not use raw or proxy URLs, or an external host, by default.** Raw cannot render HTML. Proxies and external
   hosts move private crops to a third party and need secrets.
4. **Whatever is chosen, keep the static fallback.** The PR comment and `report.md` keep the static side-by-side
   Markdown with PNG crops. That is the only view that works in GitHub's blob view, in email notifications and with
   JavaScript off, and it is the evidence of record. The slider is an enhancement on top of it, never a replacement.

This also bears on NORTH_STAR open decision 3 (whether the in-browser viewer replaces the PR comment). The hosting limits
above argue that the comment stays as the thin summary with static crops.

## Limits of this spike

- Prototype code, not product code. No tests. It will not be maintained.
- Only four crops. Real reports can have dozens; scroll and load cost are not measured.
- Not checked in Safari, Firefox or on a real phone in this session.
- The hosting facts marked unverified need checking against current GitHub and vendor documentation.
