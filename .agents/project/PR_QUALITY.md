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

## Proof

- Screenshots are committed to the branch (normally under `docs/proof/<scope>/`)
  and embedded inline; bare links, local paths, and relative paths are not proof.
- Capture/diff/report changes paste a privacy-clean generated report excerpt.
- Behaviour/CLI/guard changes paste real command or test output.
- Every bug fix ships its regression test in the same change.

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
