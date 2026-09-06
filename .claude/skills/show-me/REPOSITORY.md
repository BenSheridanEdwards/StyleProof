# Repository guidance

These repository rules override conflicting instructions in `SKILL.md`.

- Use a view for a non-trivial pull request when it removes review ambiguity.
- Choose the smallest useful view. Verify it against the source, and name the source files, symbols, states, or commands.
- Do not require a view for a trivial pull request.
- A view explains evidence. It never replaces tests, screenshots, reports, source links, warnings, or uncertainty.
- Prefer inline text, a diff, a tree, or Mermaid. Use HTML only when those formats cannot make the point clear.
- Write permitted HTML under `.show-me/<task>/`. Do not open it automatically. Do not publish or commit it. Open it only when the user asks.
- Do not add a runtime dependency for a view.
