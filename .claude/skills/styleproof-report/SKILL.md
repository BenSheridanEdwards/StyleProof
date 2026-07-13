---
name: styleproof-report
description: Use when generating the human-readable before/after StyleProof report with cropped screenshots for review — styleproof-report, its base inference and two-directory form, and the opt-in advisory content and React-component layers.
---

# StyleProof — the visual report

One job: turn a diff into something a human reviews. Where `styleproof-diff` is
the pass/fail gate, `styleproof-report` renders each change as before/after
evidence.

## Generate it

```bash
styleproof-report                         # cached maps: current commit vs inferred base
styleproof-report main                    # pin the base ref
styleproof-report <before> <after> --out report   # explicit two-dir form
```

Same base-ref inference and cached-map defaults as `styleproof-diff`. Exits `0`
when nothing changed, `1` when a report was generated (changes or new surfaces),
`2` on usage/capture error — so don't treat a non-zero as failure in scripts.
Output is `report.md` + `crops/`, capped ~400 KB so GitHub renders it;
`--image-base-url` rewrites image links for a published report.

## What a change looks like

Each distinct change is one section: a side-by-side before/after crop from the
same page rectangle, the same crop again with magenta boxes marking exactly what
moved, a plain-English summary (`background brand-cyan → brand-amber`,
`columns: 2 → 3`), then the exact property table folded under a toggle. A change
too small to see at 1:1 also gets a magnified zoom crop, so a sub-pixel tweak
can't slip past. A clean run still prints a receipt: `No visual changes detected.`
New surfaces show as `🆕 new surface`.

The report **leads with the certification gates** — the coverage, determinism,
and 📐 inventory verdicts — so a reviewer sees what the green actually asserts
before the pretty crops. The PR comment itself stays lean (summary + approval
box) and links to the committed full report.

## Opt-in advisory layers (never gate)

Both are **off by default** and **advisory** — they never feed certification, the
`StyleProof` status, or the diff exit code:

- **Content layer** — a pure-style diff is blind to copy, but longer text can
  overflow its box. `defineStyleMapCapture({ …, captureText: true })` +
  `styleproof-report … --include-content` adds a **📝 Content changes** section
  with before/after strings + crops. (Only an element's _own_ text; live-region
  churn auto-excluded.)
- **React component layer** — `captureComponent: true` records the component
  display name + sanitized primitive props, so the report says
  **`React component: Button (variant=primary)`** instead of a bare `<button>`.
  Best against a dev/non-minified target (names are mangled in prod builds).

## Next

`styleproof-ci-gate` posts this on the PR with the approve checkbox;
`styleproof-diff` is the gating half.
