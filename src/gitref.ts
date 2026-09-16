import { spawnSync } from 'node:child_process';
import { gitOutput as gitStdout, runGit } from './node-util.js';

const gitOutput = (args: string[]) => gitStdout(process.cwd(), args);

function firstExistingRef(refs: string[]): string | undefined {
  return refs.find(
    (ref) => runGit(process.cwd(), ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status === 0,
  );
}

function baseRefCandidate(ref: string): string {
  const refs = ref.startsWith('origin/') || ref.startsWith('refs/') ? [ref] : [`origin/${ref}`, ref];
  return firstExistingRef(refs) ?? refs[0];
}

function configuredMergeBase(): string {
  const branch = gitOutput(['branch', '--show-current']);
  return branch ? gitOutput(['config', `branch.${branch}.gh-merge-base`]) : '';
}

function ghPrBaseRef(): string {
  const r = spawnSync('gh', ['pr', 'view', '--json', 'baseRefName', '--jq', '.baseRefName'], {
    encoding: 'utf8',
    maxBuffer: 1 << 20,
  });
  return r.status === 0 ? r.stdout.trim() : '';
}

/** Infer a PR/base ref for local and GitHub Actions CLI runs (CLIs map the throw to exit 2). */
export function inferBaseRef(env: NodeJS.ProcessEnv = process.env): string {
  const declared = env.GITHUB_BASE_REF || configuredMergeBase() || ghPrBaseRef();
  if (declared) return baseRefCandidate(declared);
  const fallback = firstExistingRef(['origin/main', 'origin/master', 'main', 'master']);
  if (fallback) return fallback;
  throw new Error(
    'could not infer a base branch (tried GITHUB_BASE_REF, branch.<name>.gh-merge-base, gh pr view, origin/main, origin/master, main, master)',
  );
}
