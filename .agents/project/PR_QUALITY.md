# PR quality

Every PR must satisfy the PR quality contract. The machine gate
(`.github/workflows/pr-body.yml`, backed by `scripts/validate-pr-body.mjs`)
enforces the shape; this file explains the intent.

## Title

Conventional Commits: `type(scope): summary` or `type: summary`. No agent, tool,
author, or source prefixes (`[claude]`, `[agent]`, ...). The validator rejects a
non-conforming title.

## Body

Use `.github/PULL_REQUEST_TEMPLATE.md`. These four sections must be present, in
order, and none may be placeholder-only:

1. **Why does this feature exist?** — the user/product/technical reason.
2. **What changed?** — the changed files and behaviour, precisely; new config,
   deps, or public API called out.
3. **Behavioural Proof (with video and screenshots)** — proof a reviewer can SEE.
   Must embed a screenshot inline with `![alt](...png?raw=1)` **or** state
   `Not applicable` with the technical reason.
4. **Verification Summary** — the commands run after the last code change, with
   pass/fail results, and any skipped checks with reason/risk/owner.

### Opening quality

The first paragraph of "Why does this feature exist?" must answer the buyer
questions:

1. What real pain or incident motivated this change?
2. Why does this PR exist — what problem does it solve?
3. Why would the project owner want this in main?

Ticket-dump openings fail the validator:

- ❌ `Fixes #517, #518, #519 in the v2 import pipeline.`
- ❌ `Implements [#520](url) - TDD fixture coverage plan.`
- ❌ `Part of parent chain #491. Closes #513, #514.`
- ❌ `1. Propagate baseline capture failures (#513)\n2. Distinguish new surfaces (#514)`
- ❌ `Closes #500. The system needed this change.`
- ❌ `(#521) This PR addresses the linked issue.`
- ❌ `Resolves #100 by updating the config.`

Buyer-legible openings pass:

- ✅ `Users importing oracle-proven bundles lost their proven status, breaking CI gates. This PR fixes the import pipeline. Fixes #517.`
- ✅ `When a baseline capture fails, reviewers cannot distinguish genuine new surfaces from repair debt. This PR adds classification. Part of #491.`
- ✅ `Reviewers opening a PR could not immediately understand why it mattered — they saw ticket numbers, not user pain. This change gates PR bodies on buyer-legible prose.`

The validator error message:

> "Why does this feature exist?" must open with buyer-legible motivation (what
> pain, why it exists, why merge it). Ticket references (#N) should come after
> the motivation paragraph.

## Proof

- Screenshots are committed to the branch (normally under `docs/proof/<scope>/`)
  and embedded inline; bare links, local paths, and relative paths are not proof.
- Capture/diff/report changes paste a privacy-clean generated report excerpt.
- Behaviour/CLI/guard changes paste real command or test output.
- Every bug fix ships its regression test in the same change.

## Review comprehension

For a non-trivial PR, include the smallest view that lets the reviewer
understand the changed behaviour or structure without reconstructing it from
the diff. Use `/show-me` when it is available. Pick one useful representation,
such as a control-flow sketch, component tree, state transition, sequence, or
focused before-and-after diff. Do not add a diagram to a trivial change.

Every label must trace to real files, symbols, states, or evidence in the PR.
Keep warnings and uncertainty visible. This view explains the change; it does
not replace behavioural tests, StyleProof reports, screenshots, command output,
or exact-head CI.

### Semantic evidence audit

Proof must be true in substance, not merely present:

- Read every visible warning, caveat, label, caption, badge, and status detail.
- Compare the summary claim with the underlying report, command output, or
  source artifact; the underlying artifact wins when they conflict.
- Name the state precisely: certified, complete, partial, advisory,
  passing-only, stale, or unknown.
- Inspect the final rendered PR and evidence at the size a reviewer will see,
  checking crop, context, legibility, links, and asset freshness.
- After the last change, verify the live exact head: body, committed assets,
  hosted checks, and merge state.
- If the evidence undermines the claim, replace the evidence or weaken/remove
  the claim. Cropping or omitting the contradiction is a failure.

## Verification

After creating or editing the PR, confirm the body with
`gh pr view <number> --json body --jq .body` and, for infra changes like this
one, run the validator against the fetched body:

```sh
PR_TITLE="$(gh pr view <n> --json title --jq .title)" \
PR_BODY="$(gh pr view <n> --json body --jq .body)" \
node scripts/validate-pr-body.mjs
```

See [`DEFINITION_OF_DONE.md`](./DEFINITION_OF_DONE.md),
[`../skills/pr-quality-contract/SKILL.md`](../skills/pr-quality-contract/SKILL.md),
and [`../skills/pr-inline-screenshot-proof/SKILL.md`](../skills/pr-inline-screenshot-proof/SKILL.md).
