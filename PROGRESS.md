# Report truth and major release

## Success

- A clean style comparison never claims that rendered screenshots or content are identical.
- The Action can opt into advisory content/structure reporting and publishes that evidence durably.
- The public trust state names style certification, not visual identity.
- Regression tests cover clean style plus changed content/structure.
- A breaking major release is published and Fleet pins its exact npm package and Action commit.
- Fleet dogfood proves the final report at the exact pull-request head.

## Completed

- Reconciled Fleet PR 1218 against its exact base/head captures and identified the overbroad report semantics.
- Created isolated branch `codex/fix-report-truth` from StyleProof `origin/main` at `a812264` (v5.0.2).
- Read repository operating, architecture, quality, PR, and Definition of Done contracts.
- Ran GitNexus impact analysis: report wording and content rendering are low-risk, report-generator-local changes.
- Added failing regression coverage for clean style evidence with changed content/structure, then implemented the v6 contract.
- Renamed the clean trust state to `NO_REVIEWABLE_STYLE_CHANGES` and the review gate to `STYLE_REVIEW_REQUIRED`.
- Added the Action's opt-in `include-content` input and durable `content-changes` output/report receipt.
- Replaced every active `No visual changes` claim with wording limited to reviewable computed styles on semantically matched elements.
- Bumped the package, generated Action examples, and release documentation to `6.0.0` / `v6`.
- Generated a privacy-clean content-only report under `docs/proof/report-truth/`.

## Current contract

- Computed-style certification and content/structure evidence are explicitly separate.
- Content/structure comparison is advisory and opt-in; it never changes the style verdict.
- Both disabled and enabled content states are named in the CLI, report, Action comment, and JSON receipt.
- The Action dogfood workflow asserts the content-only case end to end.

## Next

- Run the final gate chain on the finished tree.
- Commit, push, and open a merge-ready StyleProof pull request with direct report proof.
- Merge and verify the `6.0.0` npm/GitHub release.
- Pin Fleet to the immutable v6 Action commit and package, then dogfood the report on Fleet's exact pull-request head.

## Blockers

- None.

## Verification

- `npm test` — 666 passed, 0 failed.
- `npm run test:e2e` — 121 passed, 0 failed.
- Focused content/report/Action suite — 125 passed, 0 failed.
- `npm run build`, `npm run typecheck`, `npm run lint`, `npm run format:check` — passed on the final code tree.
- `npm run privacy:check` — passed across 190 public text files.
- `npm run demo:check` — passed; committed demo artifacts are current.
- `npm audit --audit-level=high` — 0 vulnerabilities.
- `npm pack --dry-run --json` — package `styleproof@6.0.0`, 93 entries, expected runtime and demo artifacts present.
- GitNexus final change detection — high fan-out because `generateStyleMapReport` is the entry point for ten report-generation flows; no capture/storage/matching flows are affected. Full unit and browser coverage above is green.

---

# Off-canvas report proof

## Completed

- Audited recent adopter dogfood runs, bot comments, report Markdown/JSON, maps, action logs, and rendered crops.
- Reproduced a report that embedded unrelated visible pixels for a fully off-canvas changed element.
- Added regression coverage for representative selection and mixed visible/off-canvas regions.
- Fixed report rendering so off-canvas findings retain property audits but emit no misleading crop.
- Regenerated the privacy-clean demo report with the corrected limitation notice.
- Fixed the action dogfood comment so its final synthetic failure fixture cannot
  be mistaken for a certification result about the triggering pull request.

## Next

- Open the pull request and verify its hosted checks and merge state.

## Blockers

- None.

## Verification

- `npm run build && node --test test/report.test.mjs` — 95 passed, 0 failed.
- `npm run build`, `npm run typecheck`, `npm run lint`, `npm run format:check` — passed.
- `npm run privacy:check`, `npm run demo:check`, `npm audit --audit-level=high`, and `npm pack --dry-run --json` — passed.
- `npm test` — 670 passed, 0 failed.
- `npm run test:e2e` — 121 passed, 0 failed.
- GitHub-rendered demo report inspected at the exact branch; committed proof shows the off-canvas audit without an unrelated crop.
