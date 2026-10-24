# StyleProof quality gates

Browser work may skip only with positive proof that the relevant tracked trees
are identical. An empty filename list is not that proof. There are no path
exemptions, so prose and tooling changes run the browser lanes too.

## Hosted decisions

| Lane                                               | Runs when                                                  | May skip when                                                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Build, unit, coverage, lint, privacy and CLI smoke | Every applicable PR and main push                          | Never by the tree decision                                                                                       |
| E2E shards, E2E evidence and detection corpus      | Every main push; a PR tree differs or its proof is unknown | The verified PR merge tree equals the event base tree                                                            |
| Action, map-store and Phase 1 dogfood              | The merge/base tree decision requires work                 | The same verified tree proof permits skipping                                                                    |
| Live StyleProof dogfood                            | Every eligible PR                                          | Never by the tree decision: it captures head/base content                                                        |
| `required`                                         | Always                                                     | Never; skipped browser jobs require a successful decision job, exactly `false`, and `same-tree:<tree-oid>` proof |

Existing fork, cancellation and manual-dispatch conditions still apply. Advisory
dogfood jobs remain advisory; this does not change branch protection.

Each `changes` job checks out with `fetch-depth: 2` and runs
`node scripts/browser-lanes.mjs --github`, using only Node builtins. On a PR, the
decider verifies `HEAD == GITHUB_SHA`, reads the raw commit's two parents, requires
the first parent to equal the event's base SHA, and compares root tree OIDs.
Non-PR events run without consulting Git. Missing objects, invalid metadata,
unexpected parents or other uncertainty require work. Failure to write outputs
fails the job. The live StyleProof workflow overrides its output to `true`:
a merge can equal base even when the PR head's tree differs from base.

Root trees include names, object IDs, modes, symlinks and gitlinks. No filename
decoding, glob matching, diff inventory or changed-file API controls the decision.
Raw Git reads disable replacement objects, ignore grafted ancestry by reading
commit headers, and clear repository-local Git environment variables.

## Local hooks

| Hook         | Work                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| `pre-commit` | Lint, format, gitleaks when installed, and Fallow over staged changes; CI separately covers build and typecheck |
| `commit-msg` | Commitlint                                                                                                      |
| `pre-push`   | `npm test`, then full `npm run test:e2e -- --workers=4` unless pushed and staged tree proofs permit skipping    |

The local hook shares the pure `browserLanesRequired` function with CI. Every
pushed range must have equal root trees or delete a ref. In addition, the staged
index must equal `HEAD` via `write-tree` and a successful
`diff-index --cached --quiet --ignore-submodules=none` cross-check. Disagreement
or errors cannot justify a skip. A first push, absent stdin, unmerged index or
unborn HEAD runs or blocks; malformed records and unreadable pushed objects
block. Missing Chromium on a selected path blocks the push. The hook propagates
the full browser command's exit status.

The command tests the current checkout. A deletion-only push with an unchanged
index may skip; deleting a tracked file changes the tree and runs browsers.

## Scope and proposed follow-ups

The decision handles tracked content and metadata, Git configuration, replacement
refs and grafts, leaked repository/index/worktree environment, missing objects,
push records and hosted event shapes. It is not protection against a deliberately
modified decider/workflow, a modified Git executable, hash collisions, platform
bugs or bypassed hooks. Review and the existing head-bound enforcement sign-off
remain necessary. The hook does not check out each pushed ref.

These proposals await maintainer agreement; they are not implemented here:

- F1: restore reviewed path exemptions only with a reconstructed-tree proof.
- F2: run local browsers against each pushed commit instead of the current checkout.
- F3: guard the decider under ADR 0008 and consider evaluating base-owned code.
- F4: correct the separate late-tracker wording in `docs/REFERENCE.md`.

## Shared PR body

The eight canonical headings live in `scripts/eight-section-pr-body.mjs` and are
enforced by `scripts/validate-pr-body.mjs`. The PR body must distinguish observed
proof from assumptions and retain warnings and limitations.
