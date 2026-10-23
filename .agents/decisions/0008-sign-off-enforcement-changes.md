# ADR 0008: Ben signs off every change to a gate file

- **Status:** Proposed (accepted by approving the PR)
- **Date:** 2026-10-21
- **Builds on:** [ADR 0007](0007-adopt-the-agentic-repo-template.md), whose
  decision 8 this records, and [ADR 0005](0005-commit-statuses-over-checks-api.md)
- **Source:** the public AgenticRepoTemplate repository, its ADRs 0023 and 0024,
  `scripts/enforcement-approval.mjs`, its test, and
  `.github/workflows/enforcement-approval.yml`

## Context

The rules table in [`../README.md`](../README.md) names a check for each rule,
and rule 6 says weakening a gate to turn red green is a violation. Nothing
enforced rule 6 itself. A PR could edit `.husky/pre-commit`, a workflow, or
`eslint.config.js`, and it reached `main` on an ordinary review. An agent that
hits a red gate is the author most likely to write that PR.

The template's gate asks its maintainer to sign off such a change, binds the
sign-off to the head commit, and was hardened against a series of wrong-tick
paths on real PRs (template ADR 0024 lists them). It needs a workflow, a script
and a branch-protection change, so it has its own ADR.

## Decision

Port the template's gate, adapted to StyleProof.

### Which files ask

Only the files that run the gates. Any change to one asks: adding, editing,
deleting or renaming it, and a mode-only change. The first matching row in
`GUARDS` names the area.

| Area                      | Files                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Enforcement-approval gate | `.github/workflows/enforcement-approval.yml`, `scripts/enforcement-approval.mjs`, `test/enforcement-approval.test.mjs` |
| CI workflows              | the rest of `.github/workflows/**`                                                                                     |
| Git hooks                 | `.husky/**`                                                                                                            |
| Lint config               | `eslint.config.js`, `commitlint.config.js`                                                                             |
| Repo checks               | `scripts/check-suppressions.mjs`, `scripts/check-context-layer.mjs`                                                    |

Each is code or shell, which can loosen a gate in ways a text diff cannot rank,
and the gate never runs PR code. So unlike the template, which ranks
`biome.json` changes and lets a tightening through, every edit here asks.
StyleProof has no JSON lint config to rank, so the template's JSON judge is not
ported. A PR that lists 3000 files or more, the most the files API returns, also
asks, because the gate cannot see every guarded file.

Everything else changes without a sign-off: `src/`, docs, `.agents/`,
`.claude/`, `package.json`, `tsconfig.json`, `.prettierrc.json`, Fallow config,
and the rest of `scripts/` and `test/`, including `scripts/browser-lanes.mjs`.

### Who signs off, and for which commit

- `APPROVER` is `BenSheridanEdwards`. The status turns green only on the comment
  edit event whose sender is that GitHub user (`type: User`) and whose change
  turns the current head's unticked box into a ticked one, with nothing else
  changed. The gate compares the event's `changes.body.from` and new body with
  the comment it would render for the head, and checks that the live comment
  still has that body and that edit's `updated_at`.
- The box reads `Approve these enforcement changes at <sha>`. Every push gives a
  new head, so the gate rewrites the comment unticked and the new head waits
  for a new tick.
- Any other edit clears the box, including a tick by anyone else, whom the
  comment then names. On a fresh tick the gate labels the box with the ticker's
  profile name, login, and the London time; it writes the label for people and
  never reads it as a sign-off.

### StyleProof's idioms

- **A commit status, context `enforcement-approval`** (ADR 0005), written with
  `repos.createCommitStatus` and read back with `listCommitStatusesForRef`.
  Only a status whose `creator.login` is `github-actions[bot]` counts.
- **Pending, not failure, while it waits.** The template posts `failure`.
  Nothing is wrong with the PR; it waits on a person, and `pending` says so. A
  required `pending` status blocks a merge exactly as `failure` does. The
  StyleProof review gate keeps `failure`, because its approve workflow reads
  that state back; this gate is a separate context.
- **The approve workflows' trust checks.** Like `styleproof-approve-reusable.yml`,
  the job runs only for an edit of a comment whose author is a `Bot` with login
  `github-actions[bot]`, and the script re-reads that author from the API before
  trusting the comment, so a ticked lookalike posted by a person or another app
  is ignored. Unlike the approve workflow, the job does not drop edits by bots:
  this gate must clear their ticks too.
- **`pull_request_target`**, so `main`'s copy of the workflow and script judge
  every PR, forks included. The job checks out `main`'s script alone, with
  `persist-credentials: false`, and reads the PR's files through the API.
- **Tests** are `node:test` in `test/enforcement-approval.test.mjs`: the guard
  table, the comment, every wrong-tick path below, `run` end to end against an
  in-memory GitHub, the `--git` CLI on a real repository, and the workflow's
  triggers and trust conditions.

### Wrong-tick paths the tests pin

From template ADR 0024. Each could show a ticked box or a green status without
a fresh tick by Ben on the current head:

1. The gate carries a tick forward. It builds every body from scratch; a later
   run keeps a label only when the gate's own latest status for that head is
   Ben's sign-off.
2. A tick for an older head, including one that races a push.
3. Someone else ticks, or leaves a tick. There is one gate comment, so no
   second comment can be edited into a ticked box.
4. Ben edits other text and keeps the tick.
5. A forged head, label, or sign-off line.
6. A status on another commit. The gate reads the head live.
7. Runs out of order: an untick and a re-tick seconds apart both end unticked.
8. A rerun of an old tick run after an untick.
9. A comment the gate did not write, or its own comment with the marker
   removed.
10. A run that never ran. The concurrency group sits on the job, so an edit of
    any other comment cannot cancel a queued gate run.

### Paths that stay open

- Anyone acting with Ben's GitHub credentials ticks as Ben, an agent included.
- A workflow on any branch of this repository posts statuses and edits comments
  as `github-actions[bot]`, the gate's own author, so it can forge a green
  status and a labelled box. Closing this needs an author only the gate can use,
  a repository settings change. ADR 0005 records the same limit for the review
  gate.
- Between an edit and the run that clears it, the comment shows what the editor
  typed. The status is the record, not the comment.

## Consequences

- `pull_request_target` and `issue_comment` run the default branch's copy, so
  the gate starts once this lands on `main`. The PR that adds it cannot show
  its own status.
- Every change to a gate file waits for Ben's tick, tightening included. Raising
  a lint rule to `error` asks too; Ben ticks it quickly.
- The gate reports; it does not block. **Manual step for Ben:** add
  `enforcement-approval` to the required status checks for `main` in branch
  protection. Until then a PR can merge while the status is pending.
- A change to the gate's own script, test or workflow asks, so the rules that
  judge the next PR change only with Ben's tick.
- A loosening hidden in a `package.json` script, `tsconfig.json`, or another
  script a workflow runs is not flagged. The required gates still run on every
  PR, and review of the diff catches a weakened script.
