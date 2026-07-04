# StyleProof skills (for Claude Code / agents)

These are [Claude Code skills](https://docs.claude.com/en/docs/claude-code) — each
a `SKILL.md` whose `description` tells an agent *when* to load it. They ship with
StyleProof so an agent integrating or driving it has the setup steps and the
hard-won gotchas on hand, instead of re-deriving them from the README each time.

One job per skill; the descriptions are deliberately non-overlapping so they route
cleanly (an agent picks exactly one).

**Start here:** `styleproof` — the orchestrator that ties the whole workflow
together and links the rest.

| Skill | When it fires |
|---|---|
| **`styleproof`** | Stand StyleProof up end-to-end / run it as a whole; choose certify vs match-a-design |
| `styleproof-install` | First-time install + `styleproof-init` scaffold |
| `styleproof-surfaces` | Declare which UI states to certify (+ the coverage guard, auto-discovery) |
| `styleproof-baseline` | Capture + publish the base maps (`styleproof-map`, the map store) |
| `styleproof-ci-gate` | Wire the PR gate (the Action, modes, approve, fork/Dependabot split) |
| `styleproof-prepush` | Local pre-push capture so CI runs report-only |
| `styleproof-capture` | One-shot capture of any URL you point at |
| `styleproof-diff` | Diff two captures; certify 0-change; exit codes |
| `styleproof-report` | The before/after visual review report |
| `styleproof-coverage` | Prove nothing was missed: `--crawl`, full-coverage, gated states |

The canonical reference is always [`README.md`](../../README.md); these skills are
the actionable playbooks distilled from it.
