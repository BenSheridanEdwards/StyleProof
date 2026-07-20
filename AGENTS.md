# AGENTS.md

StyleProof is a public, MIT-licensed npm package and GitHub Action that gates
visual CSS changes on a pull request. You declare which app states matter; it
opens them in a real browser, records the browser's computed styles, compares
the PR head against the base branch, and posts a reviewable report. Intentional
visual changes get approved; unexpected ones block. It is framework-agnostic and
must stay backward-compatible and privacy-clean.

This file is the tool-agnostic entry point for every agent and human. Vendor
adapters (e.g. `CLAUDE.md`) defer here and add only vendor-specific content.

## Golden operating rules

- **Think before coding.** State assumptions, surface tradeoffs, ask before
  guessing on architecture, data shape, security, or irreversible changes.
- **Simplicity first.** Write the minimum code that solves the task. No
  speculative features, no single-use abstractions. Prefer stdlib and native
  platform features before adding dependencies.
- **Surgical changes.** Touch only what the task requires. Do not reformat,
  rename, or refactor adjacent code. Match existing style.
- **Deterministic control flow.** Routing, retries, status checks, thresholds,
  and branching belong in code, not model calls.
- **Fail loudly.** Report the exact failure of any command, test, build, or
  hook. Never relabel partial success as done.
- **Never bypass gates.** `--no-verify`/`-n` is forbidden; weakening type,
  lint, or test configuration to turn red green is a violation. See
  `.claude/hooks/block-gate-bypass.sh`.
- **Stay privacy-clean.** Never reference a private project (name, repos, PR
  numbers, internal URLs, or real UI/CSS shapes) in code, comments, tests,
  fixtures, commits, or PR text. `npm run privacy:check` enforces this. Grep the
  diff and the PR body before pushing.
- **Truth rule.** Do not claim a gate exists unless the hook, script, or
  workflow exists and runs on a clean checkout. Label targets as targets.

Full text: [`.agents/AGENT_OPERATING_RULES.md`](.agents/AGENT_OPERATING_RULES.md).

## Evidence quality standard

Before presenting, committing, pushing, or calling work complete:

- Read every visible word in the evidence, including warnings, caveats, badges,
  captions, labels, and status details.
- Test the claim against the source artifact. A green headline, passing check,
  or screenshot is not proof when the underlying content narrows or contradicts
  it.
- Classify evidence honestly as certified, complete, partial, advisory,
  passing-only, stale, or unknown. Never promote a weaker state into a stronger
  claim.
- Inspect the final rendered artifact in the surface and size that users and
  reviewers will actually see. Verify crops, legibility, links, and surrounding
  context.
- After the final change, rerun the applicable gates and verify the live exact
  head: PR body, committed proof assets, hosted checks, and merge state.
- If evidence weakens a claim, fix the evidence or qualify/remove the claim.
  Never hide a warning through cropping, omission, or selective description.

## Commands

| Task             | Command                                                          |
| ---------------- | ---------------------------------------------------------------- |
| Build            | `npm run build`                                                  |
| Typecheck        | `npm run typecheck`                                              |
| Lint             | `npm run lint` (`npm run lint:fix` to autofix)                   |
| Format           | `npm run format` (`npm run format:check` to verify)              |
| Privacy scan     | `npm run privacy:check`                                          |
| Unit tests       | `npm test`                                                       |
| E2E tests        | `npm run test:e2e`                                               |
| Demo report      | `npm run demo:report` (`npm run demo:check` to verify freshness) |
| Dependency audit | `npm audit --audit-level=high`                                   |

## Pointer table

| Read this                                                                        | For                                     |
| -------------------------------------------------------------------------------- | --------------------------------------- |
| [`.agents/README.md`](.agents/README.md)                                         | Index of the agent context layer        |
| [`.agents/project/ARCHITECTURE.md`](.agents/project/ARCHITECTURE.md)             | How the code is laid out and flows      |
| [`.agents/project/CONVENTIONS.md`](.agents/project/CONVENTIONS.md)               | Naming, style, and change rules         |
| [`.agents/project/TECH_STACK.md`](.agents/project/TECH_STACK.md)                 | Languages, deps, and tooling            |
| [`.agents/project/GLOSSARY.md`](.agents/project/GLOSSARY.md)                     | Domain terms (surface, variant, ...)    |
| [`.agents/project/QUALITY_GATES.md`](.agents/project/QUALITY_GATES.md)           | Every gate, tool, when it runs, command |
| [`.agents/project/PR_QUALITY.md`](.agents/project/PR_QUALITY.md)                 | PR body, proof, and title contract      |
| [`.agents/project/DEFINITION_OF_DONE.md`](.agents/project/DEFINITION_OF_DONE.md) | When a change is done                   |
| [`.agents/decisions/`](.agents/decisions/)                                       | Architecture decision records (ADRs)    |
