# Agent guide — StyleProof

StyleProof is a **public, MIT, npm-published** library + GitHub Action. Keep it
framework-agnostic, backward-compatible, and privacy-clean.

## Prove every change in the PR description (required)

A change isn't done until the PR description **shows it working** — a reviewer must
be able to **see the result**, not just read a description of it.

- **Capture / diff / report changes:** paste an **example of the generated report**.
  Dogfood the tool on a small before/after and paste the Markdown:

  ```js
  import { generateStyleMapReport } from 'styleproof';
  generateStyleMapReport({ beforeDir, afterDir, outDir }); // → reportMdPath
  ```

  Include a real restyle and a `🆕 new surface` when relevant.

- **Behaviour / guards / CLI:** paste the actual command or test output that
  demonstrates it (e.g. the coverage guard failing on a gap, then passing once
  covered; `discoverNextRoutes` output; the generated scaffold).

The PR template has a **Proof** section — fill it in. "Tests pass" is not proof a
reviewer can see; the output is.

## Before opening a PR

- `npm run build && npm run typecheck && npm run lint && npm run format:check` pass.
- `npm test` passes; `npm run test:e2e` too if the capture/engine path changed.
- Tests added/updated for the change.
- README + CHANGELOG (`[Unreleased]`) updated if the public API or behaviour changed.
- New optional API stays opt-in so existing specs are unaffected.

## This is a public repo — stay privacy-clean

Never reference a private project (its name, repos, PR numbers, internal URLs, or
real UI/CSS shapes) in code, comments, tests, fixtures, commit messages, or PR text.
Use generic examples (`home`, `pricing`, `ROUTES`). Grep the diff and the PR body
before pushing.
