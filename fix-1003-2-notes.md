# #1003 server coverage follow-up

Implementation SHA: 3263cc38c (shutdown flush), following 1505061ad (post-teardown collection and persistence).

The map wrapper reads Node V8 coverage after Playwright finishes, maps local app sources through source maps, stores compact evidence inside existing scriptReach, and removes raw V8 files. Existing J2 consumes those entries without a new join or schema. Instrumented servers receive graceful shutdown plus a signal preload because forced shutdown and Node's default signal exit do not flush coverage.

Validation:

- `pnpm run build` passed.
- `node --test test/server-coverage.test.mjs test/script-join-server.test.mjs` passed: 6 tests, including both first-slice no-server-evidence cases.
- `pnpm exec playwright test test/server-coverage.e2e.spec.ts --workers=2` passed: 1 outer scenario plus 1 nested request. A real Node webServer renders Home; Offer is never-rendered; Home is reached with J1 corroboration; removing execution evidence leaves it unmeasured. The scenario also verifies persisted capture entries.
- The absent-directory unit test failed before its reader existed. The default-shutdown e2e failed with zero scripts before adding graceful shutdown and the signal flush.
- Commit hooks passed lint, formatting, gitleaks, Fallow audit/health and commitlint. Earlier lint/complexity and fixture failures were corrected. Test output contains ambient NO_COLOR/FORCE_COLOR warnings.

Limits: only readable source-mapped local app scripts supply server evidence; missing maps and unreadable coverage supply no positive evidence. Server evidence spans the capture run, not an individual surface navigation. The e2e exercises the same persistence helper called by the wrapper, rather than invoking the full map CLI. Full-suite/hosted acceptance is not claimed. No full Playwright suite, pre-push, push, PR, amend, release changes or tasks.md edits were performed.

No changelog fragment: no clear fragment requirement was found in the repo guidance read; omitted under the task's instruction. No `Closes #1003` claim has been added.
