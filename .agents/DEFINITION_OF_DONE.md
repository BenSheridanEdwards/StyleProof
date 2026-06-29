# Definition of Done

For StyleProof package changes, done means the change is small, privacy-clean,
and proved with deterministic evidence.

## Required proof

- `npm run build && npm run typecheck && npm run lint && npm run format:check`
  pass.
- `npm test` passes.
- `npm run test:e2e` passes when capture, diff, report, Action, or engine behavior
  changes.
- For package/release changes, `npm pack --dry-run --json` succeeds and the packed
  package contains the expected `dist`, `bin`, docs, changelog, and license files.

## Local gates

- Pre-commit runs build, typecheck, lint, format check, and Fallow.
- Pre-push runs `npm test`.
- `npm run test:e2e` and `npm pack --dry-run --json` stay explicit because they depend on the
  touched surface.

## Public surface

- README and `CHANGELOG.md` `[Unreleased]` are updated for public API, CLI,
  workflow, Action, or behavior changes.
- Action examples point at the current supported major tag.
- New optional API is opt-in and backward-compatible unless the release is
  explicitly marked breaking.

## PR proof

- The PR body uses `.github/PULL_REQUEST_TEMPLATE.md`.
- The required Proof section includes real command output or a generated report
  excerpt, not just a sentence saying tests passed.
- Capture/diff/report changes include a privacy-clean generated report example
  when relevant.

## Privacy and safety

- No private project names, repository names, internal URLs, PR numbers, client
  copy, or real UI/CSS shapes appear in code, tests, fixtures, docs, commits, or
  PR text.
- Do not touch secrets, credentials, publishing settings, or release automation
  without explicit intent and proof.
- Do not open a draft PR for completed work.

## Inline PR Proof Law

Every PR must follow `.agents/skills/pr-inline-screenshot-proof/SKILL.md`.

- The PR body must use `.github/PULL_REQUEST_TEMPLATE.md`; that template carries this same proof law.
- Screenshot proof must be committed to the branch, normally under `docs/proof/<short-scope>/`.
- The PR body must embed screenshots inline with Markdown image syntax:
  `![Descriptive alt text](https://github.com/OWNER/REPO/blob/BRANCH/docs/proof/SCOPE/file.png?raw=1)`.
- Bare screenshot links, local filesystem paths, relative paths, and "see attached" placeholders do not satisfy proof.
- Video or non-image artifacts may be linked, but screenshots must render inline in the PR description.
- After creating or editing the PR, inspect the body with `gh pr view <number> --json body --jq .body` and confirm screenshot proof contains `![`.
- If no rendered or behavioural proof applies, the PR must say `Not applicable` in the proof section with the technical reason.
