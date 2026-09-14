import { defineConfig } from 'styleproof';

/**
 * StyleProof-on-StyleProof. Declares the real demo surfaces this repository
 * captures in advisory dogfood CI. This is not a certify-by-default gate.
 *
 * Surfaces live in `example/styleproof.spec.ts` and render `example/demo`
 * (static HTML, no auth). The synthetic Action contract suite remains
 * `.github/workflows/action-dogfood.yml`.
 */
export default defineConfig({
  // Observe signal on StyleProof's own UI PRs. Never block merge from this file.
  blocking: 'advisory',
  requireApproval: false,
  spec: 'example/styleproof.spec.ts',
  dirtyAllow: ['docs/**', '.github/**', '.agents/**', '.claude/**', 'CHANGELOG.md', 'README.md'],
});
