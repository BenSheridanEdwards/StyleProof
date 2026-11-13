# Issue #1003: partial regression coverage

Base SHA: f4032565f2641eca6c074b29a95981dd8ac52e51.
Commit subject: test(reach): guard unmeasured server template evidence.

Added a pure J2 regression fixture containing a server conditional. Both an empty
measured browser capture and an unsupported capture keep its server source
unmeasured despite matching J1 rendering corroboration. These tests pass on the
base implementation; this is a guarantee test, not a demonstrated bug fix.

Validation: pnpm run build; node --test test/script-join-server.test.mjs (2 passed);
focused ESLint and Prettier passed. Full e2e and pre-push were not run, as requested.

Remaining: actual server-rendering e2e fixture, Node webServer detection and
NODE_V8_COVERAGE lifecycle, server coverage mapping and J2 ingestion, and proof
that an unrendered server branch is flagged. Acceptance criteria are not met;
do not put Closes #1003 in a PR body. No PR opened and no push performed.

No changelog.d fragment: no production behavior changed and no clear fragment
requirement was found. No tasks.md change, per task instructions.
