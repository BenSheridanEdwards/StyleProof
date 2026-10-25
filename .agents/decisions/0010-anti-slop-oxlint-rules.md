# ADR 0010: Vendored anti-slop rules run in Oxlint beside ESLint

- **Status:** Proposed (accepted by approving the PR)
- **Date:** 2026-10-25
- **Builds on:** [ADR 0008](0008-sign-off-enforcement-changes.md), because this
  changes `ci.yml`, `.husky/pre-push` and the suppression check

## Context

Agents write most of StyleProof's code. [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop)
is a set of Oxlint JS-plugin rules that reject patterns agents produce:
chained or unexplained type assertions, `unknown` that hides a real type,
quadratic reducers and unreadable statement runs. Upstream ships it as code to
vendor, not as an npm package. ESLint cannot load Oxlint JS plugins.

## Decision

1. **Vendor, don't install.** `vendor/anti-slop/` holds upstream commit
   `13909c9e07590f5a85d93c62712259fe14a883f7`, byte-identical; its README
   records the source and how to check it. No npm package with a similar name.
2. **Pin Oxlint.** `oxlint` and `@oxlint/plugins` are exact devDependencies at
   the same version, and move together.
3. **Second linter, anti-slop rules only.** `.oxlintrc.json` turns Oxlint's
   default `correctness` rules off; ESLint stays the general linter.
4. **Error only when clean.** A rule with no findings is `error`; a rule with
   findings is `warn` until its cleanup PR lands, then it flips to `error`.
   `npm run lint:slop` runs `oxlint --quiet`, so only errors fail. Run
   `npx oxlint <files>` to see warnings in the files you touch.
5. **Where it runs:** CI (Node 22 leg), `.husky/pre-push`, `npm run verify`.
   The plugin is TypeScript loaded through Node's type stripping, so the hook
   skips with a warning on a Node older than 22.18.
6. **Suppressions:** an `oxlint-disable` comment follows the ESLint rule: name
   the rules and give a `-- reason` (`npm run check:suppressions`).

## Consequences

- About 2–3 s of lint time and about 15 MB of `node_modules` (one native
  binding per platform).
- The vendored folder is skipped by ESLint, Oxlint and fallow, so it needs
  normal code review: Oxlint runs it with Node's full permissions.
