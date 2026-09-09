# The README stops calling its embedded block "unmodified" (#479)

## The claim, before

`README.md` introduced its embedded StyleProof block with:

> The README can carry the crops directly. **This is the unmodified product report**: Save at
> rest comes first, followed by Docs hover, focus, and active.

## What the artifact actually is

`scripts/live-readme-report.mjs` produces that block. Read against it, the claim fails in five
distinct ways — four more than "the sections are reordered".

| # | What the script does | Line |
| - | -------------------- | ---- |
| 1 | Renders `example/demo/index.html`, a single static file, not an application | 18 |
| 2 | Injects `HEAD_CSS`, a hard-coded style change, as the head side | 21–29 |
| 3 | Deletes `report.json` from the published bundle | 77 |
| 4 | Reorders the element-level sections so resting changes come first (`restingChangesFirst`) | 80–96 |
| 5 | Repoints crop links and appends the approval box and caption — so the block is the PR **comment**, not the report | 100–111 |

The README embeds `docs/readme/live-report/comment.md` verbatim, which is the output of (5).

## Verified against a real run

Running the script drives Chromium for real. Every disclosed edit was checked against its fresh
output, not against the committed snapshot:

```
1. report.json dropped from bundle : True
2. crop links repointed in comment : True
3. approval box appended (comment) : True
4. sections reordered, rest first  : True
   order: `button.btn` · 1 element restyled
          `a.link` · 1 element restyled `:hover`
          `a.link` · 1 element restyled `:focus`
          `a.link` · 1 element restyled `:active`
```

The regenerated snapshot was then reverted: refreshing it is a separate change, and this one is
about the claim.

## The claim, after

> The README can carry the crops directly. The block below is a real run, not a mockup:
> `scripts/live-readme-report.mjs` captures `example/demo/index.html` in Chromium twice, injecting
> a fixed CSS change between the captures, then renders the report and the PR comment it would
> post. The block is that comment, with three edits for this page: crop links repointed at
> `docs/readme/live-report/crops/`, element-level sections reordered so Save at rest comes before
> the Docs hover, focus, and active states, and `report.json` left out of the committed bundle.
> Every finding, value, and crop is what the run produced.

Nothing is walked back that was true. The run is genuine, the findings and crops are real, and the
reading order the old sentence described is still described — it is simply no longer presented as
something that happened by itself.

## Why the prose is now pinned, not just corrected

`AGENTS.md` requires that evidence match its claim. A one-off wording fix satisfies that today and
rots tomorrow: delete `restingChangesFirst` and the disclosure becomes false in the other
direction. `test/readme-live-report-provenance.test.mjs` ties each disclosed fact to a detectable
feature of the script and asserts **both** directions —

- the script still injects CSS → the README must still say so;
- the script still reorders / drops `report.json` / repoints crops → each must still be disclosed;
- the script still appends the approval box → the README must still say the block is the comment;
- the script makes exactly **three** edits to the report — asserted as a count, so a fourth edit
  fails the suite until the prose is updated;
- the README must still embed the generated `comment.md` verbatim, which is what licenses "every
  finding, value, and crop is what the run produced";
- and the README must never again say "unmodified", "untouched", "verbatim" or "as-is", nor
  describe the demo page as a real application.

All five cases fail on the old README.
