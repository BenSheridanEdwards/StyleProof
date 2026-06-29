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
