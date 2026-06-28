## What and why

<!-- What does this change and why? Link any issue. -->

## Proof (required)

<!--
Show the change WORKING — a reviewer must be able to SEE the result here, not just
read a description of it.

- Capture / diff / report changes: the repo ships a LIVE demo report rendered by
  the current code at docs/demo/report.md (real images: clean before/after, the
  highlighted twin, the zoom crop for a tiny change, and a `🆕 new surface`). If you
  touched capture/diff/report rendering, run `npm run demo:report` and commit the
  result — the diff then shows reviewers the ACTUAL new output (CI fails if it's
  stale). Link to docs/demo/report.md here, and add any extra before/after if useful.
- Behaviour / guards / CLI: paste the actual command or test output that demonstrates
  it (e.g. the coverage guard failing on a gap, then passing once covered).

Keep pasted output privacy-clean — no private project names, repos, URLs, or PR numbers.
-->

## Checklist

- [ ] **Proof above** — linked the regenerated `docs/demo/report.md`, or pasted the command/test output that demonstrates the change
- [ ] If you changed capture/diff/report rendering, ran `npm run demo:report` and committed `docs/demo/`
- [ ] `npm run build && npm run typecheck && npm run lint && npm run format:check` pass
- [ ] `npm test` passes (and `npm run test:e2e` if the capture/engine path changed)
- [ ] Added/updated tests for the change
- [ ] Updated the README / CHANGELOG if behaviour or the public API changed
- [ ] If captured output changed, noted that adopters must regenerate baselines
