# Agent Operating Rules

These rules bind every agent (and human) working in this repository. `AGENTS.md`
summarises them; this is the full text.

## Behavioural Rules

### Think Before Coding

State assumptions before writing code. Surface tradeoffs. Ask before guessing on
architecture, data shape, security, or irreversible changes. Push back when a
simpler approach exists.

### Simplicity First

Write the minimum code that solves the task. No speculative features. No
abstractions for single-use code. Prefer stdlib and native platform features
before adding abstractions or dependencies. If the solution looks
over-engineered, simplify it.

### Surgical Changes

Touch only what the task requires. Do not reformat, rename, or refactor adjacent
code unless it is required for the change. Match existing style.

### Goal-Driven Execution

Define success before implementation. Keep working until that definition is met
and verified. Do not ask for step-by-step instructions when the path can be
inferred.

### Deterministic Control Flow

Do not use model calls for deterministic decisions. Routing, retries, status
checks, thresholds, and branching rules belong in code.

### Hard Token Budgets

For long tasks, set a clear investigation budget. If the budget is reached
without a verified solution, write findings and next steps to `PROGRESS.md` and
stop cleanly.

### One Agent, One Directory

Parallel agents must use separate git worktrees or directories. No two agents
should mutate the same checkout at the same time.

### Checkpoint Multi-Step Work

For tasks longer than three steps, create or update `PROGRESS.md` with: completed
work, findings, next action, blockers, and verification status.

### Fail Loudly

If a command, test, build, hook, or assumption fails, report the exact failure.
Do not relabel partial success as done. Passing tests only count when they cover
the changed behaviour.

### Unique Skill Descriptions

Each skill must describe exactly one job. If two skills could be selected for the
same reason, rename or split them before relying on them.

### Separate Research From Implementation

If a task needs broad reading or multiple source lookups, do research first and
produce a compact report. Start implementation from that report, not from a
sprawling context window.

### Scoped Hooks Only

Hooks must have explicit scope: file extension, path, command, or session event.
Avoid unconditional hooks on every tool call. Batch logging to session end where
possible.

## What Not To Touch Without Explicit Approval

- Secrets, credentials, tokens, keys, and local environment files.
- Production configuration, deployment settings, billing, permissions, and
  security controls.
- Generated artifacts or snapshots unless the task explicitly requires updating
  them.
- Public publishing, releases, package publication, or external messaging.
- Destructive git operations including branch deletion, force-push, and history
  rewrite.

## Truth Rules

- Do not claim a gate exists unless the hook, script, or workflow exists and runs
  on a clean checkout.
- Do not describe target architecture as current fact; label aspirations as
  targets.
- Never report "installed" from filesystem presence alone — prove the command,
  hook, or workflow runs.
- Never bypass gates: `--no-verify` is forbidden, and weakening type, lint, or
  test configuration to turn red green is a named violation.

## Default Success Criteria

A task is not done until the changed behaviour is verified by deterministic
evidence: tests, build output, typecheck/lint results, screenshots/video for UI
behaviour, or another concrete artifact that does not depend on the model's
judgment.
