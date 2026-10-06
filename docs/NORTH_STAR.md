# StyleProof North Star

> Last updated: 2026-10-05. Drafted from a grilling session with Ben Sheridan-Edwards. Open for review.

## What StyleProof is

StyleProof's job is a **deterministic way to see visual regressions on the frontend**. It opens the app states you care about in a real browser, compares base and head by **computed CSS** — resolved longhands, pseudo-elements, layout boxes, motion longhands, and forced `:hover`/`:focus`/`:active` deltas — and posts the evidence to the pull request. Intentional changes get approved. Unexpected changes block.

StyleProof is **not a screenshot diff**. Screenshots appear in the report so humans can see the change, but they are evidence for the reader, not the comparison the gate runs on. The gate compares browser-computed styles, which makes it deterministic across environments — no antialiasing or rasterisation flake — and safe as a required CI check.

## Who it's for

Developers and CI. A reviewer scanning a PR comment, not a certification checklist. The report is built for the person who has to decide: approve this change, or investigate it.

## The end state

A deterministic visual report that shows **all visual changes with 100% confidence**. The report must be:

- **Deterministic** — the same inputs produce the same output, every time, across runners.
- **Complete** — every declared surface is captured; a registered-but-uncaptured surface fails the gate rather than passing silently.
- **Actionable** — every finding names the element and the exact property that changed, so a reviewer can act without opening a browser.

## What the report contains

- **Verdict first** — `N change(s) need review`, then the named change cards (human label, selector, surface@width, token story).
- **One change = one card** — distinct restyles group together; `currentColor` follow-ons nest under the primary property.
- **One primary before/after** — optional highlight overlay (and zoom) sit under a collapsed toggle, not three duplicate carousels.
- **Product-state warning** — when identity is unproven, a plain-language warning sits above the fold next to the verdict; it is omitted when proven.
- **Evidence collapsed** — green certification stays hidden; only failures/warnings appear, under a default-collapsed Evidence section.
- **Action footer** — review-gate / migration modes keep the existing **Approve all changes** checkbox (no new GitHub APIs). Advisory mode stays non-blocking.

## The redesign (from the grilling session)

The current report is honest and well-engineered, but it is a **markdown comment**, not a visual report. The content is right; the presentation is wrong for the end state. The redesign:

1. **Crops are the product.** A reviewer opens the report to see what changed, not to read a status. The crop is the main event — full-width, before/after side by side — with the verdict demoted to a thin strip at the top.
2. **Confidence strip at the top.** Either `100% confidence` or a plain-language warning about what to fix to improve the result. Not a wall of gate jargon — one line a human can act on.
3. **`currentColor` collapse.** Eight identical rows cascading from one color change is noise. Collapse them into a single row with a count, or nest them under the primary property. That alone cuts the Link hover card from nine rows to two.
4. **Highlight overlay on by default** in the in-browser viewer, not buried under a toggle. It is the single most useful thing in the report — seeing exactly what changed — and hiding it by default tells the reviewer the wrong thing about where the value is.
5. **Property tables drop to secondary detail**, collapsed or on demand.
6. **In-browser report is the primary artifact**; the PR comment becomes a thin summary — verdict, change count, one line per change, link to the full report. The `report-storage: branch` mode already renders in-browser; that is the path.
7. **Layout rule for crops:** side-by-side for small crops; a slider between the two images for full-page captures (wider than roughly half the report container). A static divider is not enough — the slider needs a scrubber or hover-to-reveal so the reviewer can find the change without guessing.

## Two modes: review or certify

- **Review-gate mode** (`require-approval: true`) — every visual change is reported with evidence; the `StyleProof` status stays red until a reviewer ticks **Approve all changes**; approved changes become the new baseline on merge.
- **Certify mode** (`fail-on-diff: true`) — proves a change touched *nothing* visual. Any difference at all fails the job. Zero diff is the contract.

## What a green certifies

A passing check is more than "no style changed." Four gates qualify it:

- **Coverage** — the `expected` registry travels with the captured bundle as a ledger; a registered-but-uncaptured surface blocks.
- **Determinism** — the ledger records how each capture proved itself; a green from an unproven capture blocks.
- **Inventory** — navigable affordances keyed by stable identity; a removal that makes a feature unreachable gates until acknowledged.
- **Failed data request** — a data-boundary request that failed during capture means the fallback UI was captured; gating is the default.
- **Product-state identity** — a pair with matching `productState {id, revision}` is comparable and can certify.

## Open decisions

1. Threshold for side-by-side vs slider — viewport width or element bounding box? Automatic, not a config knob.
2. Hover-to-reveal vs scrubber for the slider interaction.
3. Whether the in-browser viewer replaces the PR comment entirely or the comment stays as the thin summary.

## What this document is not

A roadmap. Milestones come after this North Star is agreed and committed.
