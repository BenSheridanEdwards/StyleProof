## Why

Make StyleProof comment footers name the action available in the current mode.

## What changed

- Certify and advisory trust failures omit approval wording.
- Partial-baseline footers refer to surfaces named above.
- Clean review footers state check status once.

## Reviewer view

Not needed: a small comment-copy change confined to the footer block in action.yml.

## Proof

- Red: STYLEPROOF_WORKERS=2 node scripts/run-node-test.mjs test/certify-comment-guidance.test.mjs — 10 tests, 8 passed, 2 failed on original action.yml.
- Green: STYLEPROOF_WORKERS=2 node scripts/run-node-test.mjs test/certify-comment-guidance.test.mjs test/action.test.mjs — 118 passed, 0 failed.
- Proof Law: approval wording in certify/advisory trust footers, or repeated baseline SHA details, falsifies this change.
- Screenshots: Not applicable: comment Markdown is exercised through the real Action comment program with mocked GitHub delivery; no layout or browser rendering changes.

## Behaviour changes

- Given a certify or advisory trust failure, the footer names repair without approval guidance.
- Given missing baseline surfaces, the footer references the report above.
- Given a clean review result, the footer names the green check once.

## Not asked for

None. Includes the required short changelog note. No report layout, images, workflows, or src changes.

## Review guide

Start with the mode matrix in test/certify-comment-guidance.test.mjs, then trustGuidance and cleanGuidance in action.yml.

## Verification summary

- Targeted tests: 118 passed.
- Full verify: running; result will be recorded before handoff.
- Full E2E: intentionally not run per task scope; capture and report generation are unchanged.
- No push or PR creation requested. Hosted checks have not run.
