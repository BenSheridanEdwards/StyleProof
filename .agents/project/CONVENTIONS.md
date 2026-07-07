# Conventions

## Code style

- **ESM everywhere.** `"type": "module"`; library in TypeScript, CLIs and scripts
  in `.mjs`. Import compiled paths with `.js` extensions (NodeNext).
- **Prettier is the formatter.** Run `npm run format`; CI runs `format:check`.
  Do not hand-format against it.
- **ESLint is the linter** (flat config). `no-console` is a warning in `src/` (the
  library must not print) and off in CLIs/tests/scripts (console is the interface
  there).
- **`strict` TypeScript.** No new `tsc` errors. `dist/` is generated — never edit
  it or commit it (it is gitignored).

## Naming

- Descriptive, unabbreviated names for public API and new code. Types say what
  they hold (`StyleMap`, `SurfaceDiff`, `CoverageGaps`), not `Data`/`Info`.
- CLI binaries are `styleproof-<verb>`; the exported spec API is
  `define<Thing>Capture`.

## Changes

- **Surgical.** Touch only what the task needs; no drive-by reformatting or
  renames. Match the style of the file you are in.
- **Backward-compatible.** New public API is opt-in; existing specs must keep
  passing. Breaking changes are explicit and versioned.
- **Privacy-clean.** No private project names, repos, PR numbers, internal URLs,
  or real UI/CSS shapes in code, tests, fixtures, docs, commits, or PR text. Use
  generic examples (`home`, `pricing`, `ROUTES`). `npm run privacy:check`
  enforces it; the denylist lives in `.styleproof-privacy-denylist`.

## Commits and branches

- **Conventional Commits** on every commit (`commit-msg` runs commitlint) and on
  the PR title. No agent/tool/author prefixes (`[claude]`, `[agent]`, ...).
- One logical change per commit where practical.

## Tests

- **Every behaviour change ships a test.** Every bug fix ships, in the same
  change, the test that fails on the unfixed code and asserts the user-visible
  symptom.
- Unit tests are Node `--test` `.mjs` files under `test/`, importing from
  `../dist/` (so `npm test` builds first). Pure logic (validators, scanners) is
  tested against its exported function, not only via a subprocess.
- Capture/diff/report/engine changes also run `npm run test:e2e`.

## Docs

- Update `README.md` and `CHANGELOG.md` `[Unreleased]` when public API, CLI,
  workflow, Action, or behaviour changes.
- The demo report under `docs/demo/` is generated — regenerate with
  `npm run demo:report` when you touch capture/diff/report rendering.
