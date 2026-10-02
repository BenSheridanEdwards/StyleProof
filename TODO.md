# TODO

Honest, current-state backlog. Add items with enough context to act without
chat history. Remove an item when it ships (with the test/gate that proves it).

## Considering

- **Gitleaks in pre-commit is optional locally.** The staged-diff scan
  warn-and-skips when the binary is absent (see `.husky/pre-commit`). This is
  deliberate — contributors are not blocked on a tool they have not installed —
  but it means the only guaranteed secret scan is CI. Consider documenting the
  install in CONTRIBUTING, or vendoring a pinned binary, if local coverage matters
  more than onboarding friction.
