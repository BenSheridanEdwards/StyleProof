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

Elements that changed the same way form one section: a plain-English name, one
sentence built from the captured values ("All 3 card titles change text colour
from dark indigo to dark red."), a small **Where** map that rings them on the
page (the only image StyleProof draws on), an unedited before/after crop of the
same page rectangle for each changed state ("While hovered"), and the exact CSS
under **Show the CSS**. A clean run still prints a receipt: `No visual changes
detected.` New surfaces show as `🆕 new surface`.

The report opens with one summary line (how many changes, on which pages and
widths) and states in plain words anything that blocks certification. Internal
diagnostics stay in `report.json`. `report.html` is the same report as a browser
page with light and dark themes. The PR comment carries the summary and every
change section; on a public repository with `report-storage: branch` it also
shows the Where maps and crops, and elsewhere the sections are text with a link
to the full report.

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
