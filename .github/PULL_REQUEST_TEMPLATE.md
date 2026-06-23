## What and why

<!-- What does this change and why? Link any issue. -->

## Proof (required)

<!--
Show the change WORKING — a reviewer must be able to SEE the result here, not just
read a description of it.

- Capture / diff / report changes: paste an EXAMPLE OF THE GENERATED REPORT. Dogfood
  the tool on a small before/after and paste the Markdown, e.g.:
    generateStyleMapReport({ beforeDir, afterDir, outDir })
  Include a real restyle and a `🆕 new surface` when relevant.
- Behaviour / guards / CLI: paste the actual command or test output that demonstrates
  it (e.g. the coverage guard failing on a gap, then passing once covered).

Keep pasted output privacy-clean — no private project names, repos, URLs, or PR numbers.
-->

## Checklist

- [ ] **Pasted proof above** — an example of the generated report, or the command/test output that demonstrates the change
- [ ] `npm run build && npm run typecheck && npm run lint && npm run format:check` pass
- [ ] `npm test` passes (and `npm run test:e2e` if the capture/engine path changed)
- [ ] Added/updated tests for the change
- [ ] Updated the README / CHANGELOG if behaviour or the public API changed
- [ ] If captured output changed, noted that adopters must regenerate baselines
