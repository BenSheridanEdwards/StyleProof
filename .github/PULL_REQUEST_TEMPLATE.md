<!--
Title: Conventional Commits, `type(scope): summary`. No agent prefixes.
Keep these eight `##` headings, in this order. Reviewers and review agents look for them by name.
Write for a reviewer who has five minutes. Prefer behaviour and named symbols over line numbers.
-->

## Why

<!--
One sentence naming which North Star this moves and how.
This repo: StyleProof's North Star (deterministic visual regression via computed CSS, not screenshot diffs).
Link the issue as `Closes #N` or `part of #N` when there is one.
-->

-

## What changed

<!-- Tight diff summary at product-behaviour level, not a changelog. -->

-

## Reviewer view

<!--
Before opening a PR, run the `show-me` skill at `.claude/skills/show-me` (read
REPOSITORY.md / BEHAVIOURPROOF.md when present).

Substantive PRs include one smallest source-verified view that removes review
ambiguity. Allowed shapes: pseudocode, call tree, component tree, file tree,
Mermaid, shape-matched diff, or a one-off HTML artifact under `.show-me/<task>/`
only when those aren't enough.

Trivial PRs write `Not needed: trivial change` (or `Not applicable`) with a short reason.

A view explains shape. It must not replace tests, screenshots, reports,
StyleProof/Behavioural Proof, or the Proof Law. Name the source files, symbols,
states, or commands that verify the view. Prefer inline Markdown over HTML; do
not auto-open or commit HTML views.
-->

-

## Proof

<!--
Behavioural tests that went red then green (name the test and the before/after
result). Include a Proof Law line stating what would falsify this PR.
Embed screenshots for every visible state the change affects, or write
`Not applicable` with the technical reason when there is no rendered surface.
-->

- Tests:
- Proof Law (what would falsify this PR):
- Screenshots:

## Behaviour changes

<!--
One line per intentional change: Given ..., when ..., then ...
Write `None` when existing behaviour is preserved.
-->

- Behaviour change:

## Not asked for

<!--
Anything in the diff the issue did not ask for, or work deliberately left out.
Write `None` when the diff only does what was asked.
-->

- Extra change:

## Review guide

<!-- Where to start reading and why. Riskiest change first. -->

- Start here:

## Verification summary

<!-- Every claim pairs a command with its result. -->

- Commands run:
- Results:
- Unrelated failures:
- Known risks or skipped checks:
