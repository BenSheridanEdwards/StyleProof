# Tasks

## Queued

- Refresh [pull request #1315](https://github.com/BenSheridanEdwards/StyleProof/pull/1315) after visual-first merges: move `[Unreleased]` into `[10.0.0]` and fix the date.
- File the follow-up issues: QA3-02, QA3-03, RV5-06, RV5-08, QA11-01; the [pull request #1317](https://github.com/BenSheridanEdwards/StyleProof/pull/1317) nits and the missing `--version` flag; visual-first QA15-02, QA15-03 and the large-page render slowdown; artifact-storage items 1 to 4 plus the `png.ts` crop size after 10.0.0.
- [Issue #1324](https://github.com/BenSheridanEdwards/StyleProof/issues/1324): counted-clause wording, after 10.0.0.
- [Issue #1319](https://github.com/BenSheridanEdwards/StyleProof/issues/1319): GitHub ignores `.gitattributes` `merge=union` for `CHANGELOG.md`.

## In progress

- Visual-first report (branch `feat/report-visual-first`), round 21 in progress (review round 20 send-back: the header summary keeps report.md's reading order, the summary names one-sided-only pages, CHANGELOG and proof README claims); round 20 done (the unbound report keeps its header, the cap-note and README comment wording, commit-pinned proof images); round 19 done: review round 18 fixes (a lone owner named as main heads it beside a ×N clause, REFERENCE text, the comment-cap note, the source-binding warning, #1321's two assertions), rebased onto bcdc4c81; a fresh QA and review next. T3 thread 78b3b986 (parent), T3 thread 2f8b53f8 (builder). Follow-up: [issue #1324](https://github.com/BenSheridanEdwards/StyleProof/issues/1324). When #1322 lands on main, the visual-first rebase updates `test/content.test.mjs:370` to #1322's behaviour, not the other way round. No pull request yet; it opens unmerged for Ben's crop check.
- Narrower veto fix for label-rename pairing. Mini thread 0dffec52 (`thread:project:cdcc779a-c17f-4d69-996f-c3904aff19ff:0dffec52-7358-410f-b7e5-b93d80033603`). [Pull request #1322](https://github.com/BenSheridanEdwards/StyleProof/pull/1322).

## Waiting

- [Pull request #1315](https://github.com/BenSheridanEdwards/StyleProof/pull/1315), the 10.0.0 release, held until visual-first merges and a pack-and-install smoke test plus a real capture, diff and report pass; Ben ticks enforcement himself.
- [Pull request #1267](https://github.com/BenSheridanEdwards/StyleProof/pull/1267) and [pull request #1269](https://github.com/BenSheridanEdwards/StyleProof/pull/1269), the continuous integration enforcement pull requests, deferred until after 10.0.0.
- Drafts [pull request #1299](https://github.com/BenSheridanEdwards/StyleProof/pull/1299), [pull request #1297](https://github.com/BenSheridanEdwards/StyleProof/pull/1297), [pull request #1288](https://github.com/BenSheridanEdwards/StyleProof/pull/1288), [pull request #1290](https://github.com/BenSheridanEdwards/StyleProof/pull/1290) and [pull request #1285](https://github.com/BenSheridanEdwards/StyleProof/pull/1285), on hold.
- Change Reach clock-control investigation, parked.

## Done

- 2026-11-10: merged [pull request #1323](https://github.com/BenSheridanEdwards/StyleProof/pull/1323) (`tasks.md` and the task-tracking rule) at 18:02 Europe/London (01253bd9).
- 2026-11-10: merged [pull request #1260](https://github.com/BenSheridanEdwards/StyleProof/pull/1260).
- 2026-11-10: merged [pull request #1310](https://github.com/BenSheridanEdwards/StyleProof/pull/1310).
- 2026-11-10: merged [pull request #1311](https://github.com/BenSheridanEdwards/StyleProof/pull/1311).
- 2026-11-10: merged [pull request #1312](https://github.com/BenSheridanEdwards/StyleProof/pull/1312).
- 2026-11-10: merged [pull request #1316](https://github.com/BenSheridanEdwards/StyleProof/pull/1316).
- 2026-11-10: merged [pull request #1317](https://github.com/BenSheridanEdwards/StyleProof/pull/1317).
- 2026-11-10: merged [pull request #1318](https://github.com/BenSheridanEdwards/StyleProof/pull/1318) (identity fix).
- 2026-11-10: merged [pull request #1321](https://github.com/BenSheridanEdwards/StyleProof/pull/1321) by BenSheridanEdwards at 16:50 Europe/London (8e038b61).
- 2026-11-10: closed [pull request #1320](https://github.com/BenSheridanEdwards/StyleProof/pull/1320) (retention default change).
