// Enforce Conventional Commits on every commit message (via .husky/commit-msg)
// and, indirectly, on PR titles (a squash-merge inherits the commit subject).
// See .agents/project/QUALITY_GATES.md for where this gate runs.
export default { extends: ['@commitlint/config-conventional'] };
