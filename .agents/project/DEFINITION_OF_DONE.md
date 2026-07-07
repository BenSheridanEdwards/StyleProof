# Definition of Done

A change is done only when it is small, privacy-clean, and proved with
deterministic evidence — tests, build output, typecheck/lint results, a generated
report excerpt, or screenshots/video for UI behaviour. "The gates are green" and
"done" are the same statement. If an item below does not apply, the PR states
`Not applicable` with the technical reason.

## Required proof

- `npm run build && npm run typecheck && npm run lint && npm run format:check`
  pass.
- `npm run privacy:check` passes.
- `npm test` passes.
- `npm run test:e2e` passes when capture, diff, report, Action, or engine
  behaviour changes.
- For package/release changes, `npm pack --dry-run --json` succeeds and the packed
  package contains the expected `dist`, `bin`, docs, changelog, and license files.

## Local gates

- `commit-msg` runs commitlint (Conventional Commits).
- `pre-commit` runs build, typecheck, lint, format check, Fallow, and a
  staged-diff gitleaks scan (skipped with a warning if gitleaks is not installed
  locally; never skipped in CI).
- `pre-push` runs `npm test`.
- `npm run test:e2e` and `npm pack --dry-run --json` stay explicit because they
  depend on the touched surface.

See [`QUALITY_GATES.md`](./QUALITY_GATES.md) for the full gate matrix, including
the CI-only gates (CodeQL, gitleaks full-history, npm audit, PR-body validation,
demo-report freshness, action dogfood).

## Scope and implementation

- The reason for the change is stated in user, product, or technical terms.
- The implementation avoids unrelated refactors, formatting churn, and hidden
  scope expansion.
- New configuration, dependencies, permissions, or public API changes are called
  out.

## Behavioural proof

- User-visible behaviour changes include screenshots (and video where there is
  motion/timing) from the branch under review, embedded inline in the PR body.
- Capture/diff/report changes include a privacy-clean generated report example.
- Behaviour/CLI/guard changes paste the actual command or test output (e.g. a
  coverage guard failing on a gap, then passing once covered).
- Every bug fix ships, in the same change, with the test that would have caught
  it — the test fails on the unfixed code and asserts the user-visible symptom.
- Missing visual proof is allowed only with a technical reason and a stated
  replacement verification method.

## Public surface

- README and `CHANGELOG.md` `[Unreleased]` are updated for public API, CLI,
  workflow, Action, or behaviour changes.
- Action examples point at the current supported major tag.
- New optional API is opt-in and backward-compatible unless the release is
  explicitly marked breaking.

## PR proof

- The PR body uses `.github/PULL_REQUEST_TEMPLATE.md` and preserves its sections
  in order: `Why does this feature exist?`, `What changed?`,
  `Behavioural Proof (with video and screenshots)`, `Verification Summary`.
- The PR title uses Conventional Commits (`type(scope): summary`); no agent, tool,
  author, or source prefixes.
- The Behavioural Proof section either embeds proof inline with `![alt](...png?raw=1)`
  or states `Not applicable` with the technical reason.
- Test command names and pass/fail results are listed. Skipped checks include the
  reason, risk, and owner.

## Privacy and safety

- No private project names, repository names, internal URLs, PR numbers, client
  copy, or real UI/CSS shapes appear in code, tests, fixtures, docs, commits, or
  PR text.
- Do not touch secrets, credentials, publishing settings, or release automation
  without explicit intent and proof.
- Do not open a draft PR for completed work.

## Inline PR Proof Law

Every PR must follow `.agents/skills/pr-inline-screenshot-proof/SKILL.md`.

- The PR body must use `.github/PULL_REQUEST_TEMPLATE.md`; that template carries
  this same proof law.
- Screenshot proof must be committed to the branch, normally under
  `docs/proof/<short-scope>/`.
- The PR body must embed screenshots inline with Markdown image syntax:
  `![Descriptive alt text](https://github.com/OWNER/REPO/blob/BRANCH/docs/proof/SCOPE/file.png?raw=1)`.
- Bare screenshot links, local filesystem paths, relative paths, and "see
  attached" placeholders do not satisfy proof.
- Video or non-image artifacts may be linked, but screenshots must render inline
  in the PR description.
- After creating or editing the PR, inspect the body with
  `gh pr view <number> --json body --jq .body` and confirm screenshot proof
  contains `![`.
- If no rendered or behavioural proof applies, the PR must say `Not applicable` in
  the proof section with the technical reason.
