# TODO

Honest, current-state backlog. Add items with enough context to act without
chat history. Remove an item when it ships (with the test/gate that proves it).

## Considering

- **Coverage floor for the unit suite.** There is currently no coverage
  measurement in CI — `npm test` runs `node --test` with no `--experimental-test-coverage`
  threshold and no reporter gate. Consider adding a measured floor so new code
  cannot silently ship untested. Decide the tool (Node's built-in coverage vs
  `c8`) and a starting threshold from the current baseline, not an aspirational
  number.

- **Wire e2e into `pre-push`.** `pre-push` runs `npm test` (unit) only; the
  Playwright e2e suite runs in CI. Pushing browser/capture changes that pass unit
  but break e2e is caught only after push. Consider running `npm run test:e2e`
  (or a fast subset) on pre-push when capture/diff/report/engine files are staged,
  gated on the browser being installed so it does not block contributors without
  Chromium.

- **Gitleaks in pre-commit is optional locally.** The staged-diff scan
  warn-and-skips when the binary is absent (see `.husky/pre-commit`). This is
  deliberate — contributors are not blocked on a tool they have not installed —
  but it means the only guaranteed secret scan is CI. Consider documenting the
  install in CONTRIBUTING, or vendoring a pinned binary, if local coverage matters
  more than onboarding friction.
