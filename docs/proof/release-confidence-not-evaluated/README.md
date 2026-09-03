# Proof: a clean compare no longer opens with "Release confidence ✗ blocked" (#474)

Two `styleproof-capture` runs of the **same** static page (URL-only, no spec file),
compared with `styleproof-report base head --out out`. Same two directories, same
command, before and after this change.

![Before: report.md opens with "✗ blocked (absent-legacy; integrity; manifest-absent)" and stderr says "release confidence projection failed". After: report.md opens with "⚠ not evaluated (projection refused — the head capture ran without a StyleProof spec file …)" and stderr names the reason spec-hash-unbound.](composite.png)

## What was wrong

- No manifest existed, so nothing was "blocked" by a finding. The projection had
  refused because a URL-only capture stamps `specHash: "missing"` — there is no
  spec file to bind a release scope to.
- `ReleaseConfidenceProjectError` carried no reason, so the CLI could only say
  "projection failed" and the report could only print the raw presence token.

## What changed

- The error now carries a fixed `reason` literal. The CLI and `report.md` render one
  fixed sentence per literal; unknown values fall back to a generic sentence and
  never echo input.
- `report.json` `releaseConfidence` is byte-for-byte unchanged (`absent-legacy`,
  `blocking: true`, `manifest-absent`). The exit code is still 1. The Action gate
  reads the JSON, so it decides exactly as before.

Rendered from real CLI output in the same container; `docs/demo/report.md` (the
committed demo report) shows the same line change.
