# Action blocker repair

## Scope

- Base: `299b917b6c0630e791cf64243968558f4ea6b08b`
- Branch: `neo/action-blocker-repair`
- Worktree: `/Users/agents/Agents/Neo/workspace/worktrees/styleproof-action-blocker-repair`
- Changed runtime surface: `action.yml` only.
- Test surface: `test/action.test.mjs`.
- No report identity/budget, version, permissions, credentials, docs, push, PR, or merge changes.

## Repair

1. The approval gate now derives its boolean from the canonical `steps.verdict.outputs.reviewable-changed` output instead of referencing the undefined `changed` identifier.
2. The terminal trust step fails closed when a prepublication verdict exists but required report binding/publication does not succeed. It also fails closed for required PR comment delivery and, in approval mode, required status delivery.
3. Intentional non-PR delivery skips and certify-mode status skips remain non-failures. A root failure before any verdict remains `CERTIFICATION_FAILED` rather than being relabelled as publication failure.

## TDD evidence

### RED

- Extracted the base Action approval gate and executed it under Node 22: exit 1, `ReferenceError: changed is not defined`. Independent reproduction source: `299b917b6c0630e791cf64243968558f4ea6b08b:action.yml:463-477`.
- Added an executable test that extracts the actual approval-gate `github-script` body and runs clean, changed, and approved fixtures. Before the runtime fix, the clean fixture raised the same `ReferenceError`.
- Added an executable terminal-trust matrix. Before the trust fix, binding/publish skipped after a clean prepublication verdict returned `CLEAN` instead of `REPORT_PUBLICATION_FAILED`; required PR delivery skipped/cancelled also returned `CLEAN`.

### GREEN

- `node --test test/action.test.mjs`: 40/40 pass on the final code (also included in the full suite). Parent corroborating log: `/Users/agents/Agents/Neo/workspace/artifacts/styleproof-ci-trust/parent-action-tests.log`.
- `npm test` under Node `v22.22.2`: 1214/1214 pass, 0 fail. Full log: `/Users/agents/Agents/Neo/.hermes/profiles/neo/cache/terminal-output/out-1788686057-79274-e540.log`.
- `npm run typecheck`: pass.
- `npm run lint`: pass.
- `npm run format:check`: pass.
- `npm run privacy:check`: pass, 355 public text files scanned.
- `npm audit --audit-level=high`: pass, 0 vulnerabilities.
- `git diff --check`: pass.
- Composite Action YAML is parsed and its embedded scripts are exercised by `test/action.test.mjs`; standalone `actionlint action.yml` is not applicable because actionlint treats a composite Action metadata file as a workflow and rejects valid top-level `inputs`, `outputs`, and `runs`.
- E2E browser capture is not applicable: this slice changes Action orchestration and executable Action tests, not capture/rendering code.

## Full-suite transient diagnosis

An earlier normal `npm test` attempt reported 54 failures. Programmatic classification of the preserved log found 51 `code: ENOSPC` failures and 102 `ENOSPC` mentions; the first assertion failed after Git reported `fatal: Could not write new index file`. The exact first test passed alone unchanged in 23.94 s, and the subsequent unchanged normal full command passed 1214/1214. This supports a transient disk/load-sensitive run, but no broader environmental claim is required for acceptance. Failed-run log: `/Users/agents/Agents/Neo/.hermes/profiles/neo/cache/terminal-output/out-1788685485-79274-88c0.log`.

## Remaining risks / deferred work

- Executable tests run the exact embedded `github-script` bodies against deterministic mocks; they do not make live GitHub API calls.
- The first-adoption CLI test ran near its unchanged 30-second timeout when isolated (23.94 s here; 28.52 s in the parent run), so it remains load-sensitive even though the final normal full suite passed.
- Report identity/budget and near-limit report binding are intentionally deferred to the separate report slice; this repair does not add an unverified evidence-relocation claim.
