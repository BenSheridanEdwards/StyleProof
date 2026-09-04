# The approve workflow refuses a self-approval (#477)

Both transcripts come from the real program embedded in
`example/styleproof-approve.yml`. The GitHub API is stubbed so the workflow can run
outside Actions; the parsing, the guards, the commit status, the box rewrite and the
reply are the shipped code path. The same program is executed by
`test/approve-workflow.test.mjs`.

The pull request is authored by `@pr-author`. `@a-reviewer` is a second person with
write access. The reviewed commit matches the report SHA in every case.

## Before — on `main`

An author with write access signs off their own visual changes, and an author who
merely edits an already-approved comment takes over the sign-off.

```
1. The author (@pr-author) ticks their own box
  StyleProof → SUCCESS  "Approved by @pr-author"
  box        → - [x] **Approve all changes** — _approved by @pr-author_

4. The author edits a comment @a-reviewer already ticked
  StyleProof → SUCCESS  "Approved by @pr-author"
  box        → - [x] **Approve all changes** — _approved by @pr-author_
```

The audit trail now reads as a review. It was not one.

## After

```
1. The author (@pr-author) ticks their own box — REFUSED
  StyleProof → FAILURE  "Needs a reviewer other than @pr-author"
  box        → - [ ] **Approve all changes** — _self-approval by @pr-author refused_
  reply      → @pr-author — you opened this pull request, so ticking your own
                **Approve all changes** box cannot sign off its visual changes. …

2. The author ticks again — refused again, but the reply is not repeated
  StyleProof → FAILURE  "Needs a reviewer other than @pr-author"
  box        → - [ ] **Approve all changes** — _self-approval by @pr-author refused_

3. A reviewer (@a-reviewer) ticks — signed off
  StyleProof → SUCCESS  "Approved by @a-reviewer"
  box        → - [x] **Approve all changes** — _approved by @a-reviewer_

4. The author edits a comment @a-reviewer already ticked — REFUSED, no transfer
  StyleProof → FAILURE  "Needs a reviewer other than @pr-author"
  box        → - [ ] **Approve all changes** — _self-approval by @pr-author refused_

5. The author unticks — always allowed
  StyleProof → FAILURE  "Tick "Approve all changes" to sign off"

6. Solo repo, STYLEPROOF_ALLOW_SELF_APPROVAL='true' — the author may sign off
  StyleProof → SUCCESS  "Approved by @pr-author"
  box        → - [x] **Approve all changes** — _approved by @pr-author_

7. Typo, STYLEPROOF_ALLOW_SELF_APPROVAL='TRUE' — fails closed
  StyleProof → FAILURE  "Needs a reviewer other than @pr-author"
  box        → - [ ] **Approve all changes** — _self-approval by @pr-author refused_
```

## What each case establishes

| # | Case | Why it matters |
| - | ---- | -------------- |
| 1 | Author ticks | The reported defect. The status never goes green and the box is put back, so the comment cannot read as approved beside a red check. |
| 2 | Author ticks again | The refusal is not a one-shot, and the reply is deduplicated per reviewed commit so an insistent tick cannot spam the thread. |
| 3 | Reviewer ticks | The normal path is untouched. |
| 4 | Author edits an approved comment | GitHub reports only the editor, so without this the author inherits a reviewer's sign-off. |
| 5 | Author unticks | Withdrawing a sign-off only moves the gate red, so the author is never blocked from it. |
| 6 | Solo opt-in | `STYLEPROOF_ALLOW_SELF_APPROVAL: 'true'` restores the old behaviour deliberately. |
| 7 | Typo in the opt-in | Anything but the exact string `'true'` refuses. |

Two further guards are covered by the tests rather than shown here: a login match is
case-insensitive (`@PR-Author` is refused), and a pull request whose author cannot be
resolved is treated as a self-approval and refused.
