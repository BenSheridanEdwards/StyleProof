# Progress

## Completed: gate-truthfulness audit + off-origin crawl guard (4.3.0)

## Completed

- Adversarial audit of the diff/gate subsystem (exit codes, surface pairing,
  volatile handling, ledger auditing, inventory guard, Action wiring).
- Removed surfaces now exit 1 as `REMOVED`, never exit 3 as "new".
- Corrupt coverage ledger exits 2; ledger-less residue footer named truthfully.
- Volatile-excluded count and both-sides-skipped forced-state layer surfaced in
  output and --json.
- Stale inventory allowances gate (CLI and Action), mirroring residue.
- Action fails closed on undefined diff exit codes and hard-gates
  coverage/determinism/residue failures post-approval.
- Both crawls refuse off-origin redirect targets.
- Dogfooded the released 4.2.0 end to end: consumer init→map→store→restore→diff
  round trip, base-checkout SHA labeling under PR event env, multi-page CLI
  crawl edge cases, and a real Next.js app capture that caught a single hover
  tint change with zero noise.

## Findings

- Head-side auto-volatile subtrees suppressed real changes with zero trace at
  the gate; the count existed in the library result but the CLI dropped it.
- Deleting or corrupting the head ledger disarmed coverage, determinism, and
  residue at once, and the residue footer blamed the warn opt-out.
- action.yml mapped crash exit codes (127/137/143) to "no changes" = green.
- A deleted route exited 3 under the "new surfaces" banner.
- A same-origin nav link that 302s off-origin was captured as app content.

## Verification Status

- 442 unit tests and full Playwright e2e suite pass; new regression tests pin
  every fix at gate level (not just library level).
