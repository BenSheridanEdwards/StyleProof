# StyleProof 7.0.0 release candidate verification

These are local, self-attested results for the source hashes in
`package-audit.json`. Publication has not occurred. Hosted checks on the final PR
head remain the independent release gate.

| Command or check                                         | Result                                                                                                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                                                 | Passed; no vulnerabilities                                                                                                                                                |
| Build, typecheck, lint, format and privacy checks        | Passed                                                                                                                                                                    |
| `npm test` with Node 22.22.2                             | 1,204 passed; zero failed or skipped                                                                                                                                      |
| `npm run test:e2e` with Node 22.22.2                     | 221 passed; one non-Chromium-only test skipped in the Chromium project                                                                                                    |
| `npm run demo:check`                                     | Passed; committed demo is current                                                                                                                                         |
| `npm audit --audit-level=high`                           | Passed; no vulnerabilities                                                                                                                                                |
| `npm pack --dry-run --json` and actual `npm pack --json` | Matching integrity and file inventory; 156 files                                                                                                                          |
| Generated example upgrade                                | A generated report workflow changed to `@v6` was restored to `@v7` by `styleproof-init --upgrade --external-server`; `styleproof-init --check --external-server` exited 0 |

The package contains its compiled runtime, CLI entry points, setup and
forced-state guides, README, changelog and license. The deleted Phase 0 and
Release Confidence modules and guides are absent. The package audit records the
actual tarball digest; it is not a published npm artifact identity.

## Failures retained during preparation

- Updating scaffold assertions to expect `@v7` before changing the template
  produced six failures and 107 passes. Each failure found the old `@v6` report
  Action. The final unit run includes these assertions.
- The first full unit run under Node 26.0.0 had 1,202 passes and two failures.
  One was the existing benchmark test comparing a noncanonical macOS temporary
  path against the canonical production result; this PR fixes that assertion.
  The other was an owned CLI subprocess stuck during native Node shutdown after
  writing its result. A process sample showed the main thread waiting for a V8
  worker; stopping that single process let the failed suite finish. No product
  workaround or gate relaxation was added. Final validation used Node 22.22.2,
  matching the major version of the primary CI lane.
- The initial browser run could not launch the required Chromium revision.
  Installing the exact Playwright browser dependency allowed the full rerun.
  Expected negative-fixture warnings about incomplete captures remain visible in
  the test output and do not certify those fixture captures.

The one locally skipped test checks unsupported forced-state evidence on a
non-Chromium browser. The hosted CI configuration includes its separate Firefox
project. A renderer exiting successfully is not itself certification: source
binding, coverage, determinism and partial-baseline verdicts still apply.
