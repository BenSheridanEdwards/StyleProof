# Why does this feature exist?

<!-- The user, product, or technical reason for the change. Link any issue. -->

-

# What changed?

<!-- The changed files and behaviour, precisely. Call out new config, deps, or public API. -->

-

# Behavioural Proof (with video and screenshots)

<!--
Show the change WORKING — a reviewer must SEE the result here.

- Capture / diff / report changes: the repo ships a LIVE demo report rendered by
  the current code at docs/demo/report.md. If you touched capture/diff/report
  rendering, run `npm run demo:report`, commit docs/demo/, and link it here.
- UI changes: embed screenshots inline with `![alt](https://github.com/OWNER/REPO/blob/BRANCH/docs/proof/SCOPE/file.png?raw=1)`.
- Behaviour / guards / CLI: paste the actual command or test output (e.g. a guard
  failing on a gap, then passing once covered).
- If nothing renders, write `Not applicable` with the technical reason.

Keep pasted output privacy-clean — no private project names, repos, URLs, or PR numbers.
-->

- Video:
- Screenshots:
- Behaviour tests:

# Verification Summary

<!-- Commands run AFTER the last code change, with pass/fail results. -->

- Definition of Done: followed `.agents/project/DEFINITION_OF_DONE.md`.
- Commands run:
- Results:
- Known risks or skipped checks:

## Checklist

- [ ] **Proof above** — linked the regenerated `docs/demo/report.md`, or pasted the command/test output that demonstrates the change
- [ ] If you changed capture/diff/report rendering, ran `npm run demo:report` and committed `docs/demo/`
- [ ] `npm run build && npm run typecheck && npm run lint && npm run format:check` pass
- [ ] `npm test` passes (and `npm run test:e2e` if the capture/engine path changed)
- [ ] Added/updated tests for the change
- [ ] Updated the README / CHANGELOG if behaviour or the public API changed
- [ ] If captured output changed, noted that adopters must regenerate baselines
- [ ] Followed `.agents/project/DEFINITION_OF_DONE.md` and `.agents/skills/pr-inline-screenshot-proof/SKILL.md`
- [ ] Screenshots are committed and embedded inline with `![alt](...png?raw=1)`, or the proof section says `Not applicable` with the technical reason
- [ ] The PR body has no bare screenshot links, local paths, relative paths, or proof placeholders
