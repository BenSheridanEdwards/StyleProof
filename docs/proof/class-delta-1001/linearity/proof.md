# Class-join linearity guards

Test commit: `70b560d25`. Parent: `a38ddaf50`. Product code, dependencies, workflows, coverage floors and runner settings are unchanged. Main remains `0cc4bd2dc`.

Coverage shard 1/3 rejected a linear 16k replacement-hunk workload at 1,507 ms against a one-second bound; the scoped-gap workload was already near the same bound at 945 ms. The tests now check growth rather than an absolute performance target.

## Converted tests

- `class-join-round1.test.mjs`: string and template extraction up to about 1 MB (two tests).
- `class-join-round2.test.mjs`: scoped-gap classification and negative-evidence lookup, 4k → 16k lines (one test, two timed operations).
- `class-join-round5.test.mjs`: cached replacement-hunk matching, 4k → 16k changed lines.
- `class-join-round6.test.mjs`: flat else-if chains, 2,500 → 10,000 arms, retaining positive roles and no depth gap.
- `class-join-round9.test.mjs`: template extraction, about 1 → 4 MiB, retaining the argument-stack overflow and token-count checks.

The shared test-only helper warms each size once and interleaves three measured runs of N and 4N. Setup and correctness assertions are outside the timed region. It compares the two medians and requires `time(4N) / time(N) < 8`; quadratic growth would be about 16. No noise floor, retries, coverage exemption or adjusted ratio is used. Every measured call retains a 10-second hang ceiling. The outer 4 MiB test timeout is 120 seconds to accommodate eight calls plus checks; it is not the performance assertion. Maximum workload sizes are retained or slightly increased by rounding to a multiple of four.

The audit found no branch-added script-join or report performance assertions. Script-join round15/16 CPU and wall guards already exist on main and are unchanged. Oracle subprocess timeouts and the report pipeline's process/test timeouts are hang guards, not speed targets, and stay unchanged. Historical proof transcripts are preserved.

## Passing checks and quadratic rejection

All six converted tests (seven timed operations) pass under Node 22.23.4 coverage instrumentation. This focused run is a performance/behaviour check, not a repository coverage-floor claim. [Actual output](coverage-focused.txt).

Private copies of the same test files then use the [quadratic mutation helper](quadratic-stub.txt). It caches correct product outputs during the warm-ups and substitutes an observed nested loop for the timed operation, with width `4096 * size / N`. The checksum is written to a global sink so the work is observable. Existing correctness assertions still run against the outputs. This is only an offline mutation copy; no test-time override is added to the branch.

Every converted test fails specifically at the `< 8` ratio assertion: [six failures](quadratic.txt). The first scoped-gap assertion otherwise prevents reaching the second operation, so a separate mutation of only negative-evidence lookup proves that seventh guard also rejects quadratic growth: [negative lookup failure](negative-quadratic.txt). Every measured mutation remains below the 10-second ceiling; the hang guard is not the cause of failure.

| Timed operation             | N → 4N           | Node22 coverage ratio | Quadratic mutation ratio |
| --------------------------- | ---------------- | --------------------- | ------------------------ |
| string literal extraction   | 10,870 → 43,480  | 4.067×                | 15.773×                  |
| template literal extraction | 6,411 → 25,644   | 4.277×                | 15.787×                  |
| scoped gap classification   | 4,000 → 16,000   | 3.774×                | 16.008×                  |
| negative evidence lookup    | 4,000 → 16,000   | 4.601×                | 15.114×                  |
| replacement-hunk matching   | 4,000 → 16,000   | 3.636×                | 16.099×                  |
| flat else-if extraction     | 2,500 → 10,000   | 4.314×                | 16.120×                  |
| four MB template extraction | 27,595 → 110,380 | 4.722×                | 16.145×                  |

[Raw samples](results.json) · [comparison](linearity.html). The chart was inspected at 728 and 390 px with no clipping or console errors. No UI changed, so screenshots/video of product behaviour are not applicable; the passing/failing guard transcripts are the behavioural proof.

## Final verification

`pnpm run verify`: 6,592 tests / 32 suites, all passed, no failures/cancellations/skips/todos; duration 259,191.661917 ms. Launch load 1.58. [Real tail](verify-tail.txt).

The full failed-job reproduction also passes: Node 22.23.4 `scripts/check-coverage.mjs --shard 1/3 --lcov …` uses the standard repository coverage runner, preload, default concurrency, include/exclude rules and shard selection. All 2,915 tests / 15 suites pass, with zero failures, cancellations, skips or todos; 217,770.337292 ms. Launch load 4.23. LCOV was written. This is one shard, not a claim that the three-shard merged coverage gate has run locally. [Summary](shard1-summary.txt) · [timing evidence](shard1-linearity.txt).

In that full shard, replacement-hunk matching has medians 183.080 / 823.081 ms, ratio 4.496×. Scoped classification is 4.012× and negative lookup 5.015×. The workload sizes and semantic assertions are unchanged.

`git diff --check` is clean. The new proof contains only relative transcript paths; full unmodified logs and the mutation copies remain in the run receipt. Product code has an empty diff against the supplied parent head. No new skip, retry, workflow change, dependency or benchmark bypass was added.
