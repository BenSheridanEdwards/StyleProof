# Proof: a restyle behind a new wrapper is gated (#472)

Two one-shot captures of a static checkout card. The head wraps the button in a
new `div.card__body` **and** changes its background from teal to red. Nothing else
differs.

## Before the fix (StyleProof 6.2.2 `dist/`, same two captures)

```
$ styleproof-diff base head --allow-unasserted
⚠ UNVERIFIED DIAGNOSTIC: 0 reviewable computed-style changes across 1 paired capture(s); content/structure not evaluated
```

The wrapper re-keyed the button's structural path, certification excludes
structure, and the colour regression vanished with the advisory remove+add.

## After the fix

```
$ styleproof-diff base head --allow-unasserted
checkout@1024: 1 element restyled
  body > div:nth-child(1) > div:nth-child(2) > button:nth-child(1)  (.cta)
    background-color: rgb(20, 184, 166) → rgb(220, 38, 38)
✗ 0 DOM change(s), 1 computed-style difference(s), 0 state-delta difference(s) across 1 surfaces
(exit 1)

$ styleproof-report base head --out out
✗ 1 changed surface(s), 1 finding(s)
(exit 1)
```

Report excerpt (`out/report.md`), crops copied here unmodified:

> ### `button.cta` · 1 element restyled
>
> `background-color` `#14b8a6` → `#dc2626`

![before ◀ │ ▶ after](composite.png)

![highlighted before ◀ │ ▶ after](annotated.png)

The `⚠ UNVERIFIED DIAGNOSTIC` line that the report also prints comes from the
two-directory compare having no trusted source SHAs. It is unrelated to this fix.
(The `Release confidence ✗ blocked` line this transcript once showed alongside it
is gone: #475 deleted that layer.)
