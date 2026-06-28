import { spawnSync } from 'node:child_process';

/** A readable failure inferring a base branch — CLIs map this to exit 2. */
export class GitRefError extends Error {}

function git(args: string[]) {
  return spawnSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
}

function gitOutput(args: string[]): string {
  const r = git(args);
  return r.status === 0 ? r.stdout.trim() : '';
}

function refExists(ref: string): boolean {
  return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status === 0;
}

function firstExistingRef(refs: string[]): string | undefined {
  return refs.find(refExists);
}

function baseRefCandidate(ref: string): string {
  const refs = ref.startsWith('origin/') || ref.startsWith('refs/') ? [ref] : [`origin/${ref}`, ref];
  return firstExistingRef(refs) ?? refs[0];
}

function ghPrBaseRef(): string {
  const r = spawnSync('gh', ['pr', 'view', '--json', 'baseRefName', '--jq', '.baseRefName'], {
    encoding: 'utf8',
    maxBuffer: 1 << 20,
  });
  return r.status === 0 ? r.stdout.trim() : '';
}

/** Infer a PR/base ref for local and GitHub Actions CLI runs. */
export function inferBaseRef(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GITHUB_BASE_REF) {
    return baseRefCandidate(env.GITHUB_BASE_REF);
  }

  const branch = gitOutput(['branch', '--show-current']);
  if (branch) {
    const configured = gitOutput(['config', `branch.${branch}.gh-merge-base`]);
    if (configured) {
      return baseRefCandidate(configured);
    }
  }

  const prBase = ghPrBaseRef();
  if (prBase) return baseRefCandidate(prBase);

  const fallback = firstExistingRef(['origin/main', 'origin/master', 'main', 'master']);
  if (fallback) return fallback;

  throw new GitRefError(
    'could not infer a base branch (tried GITHUB_BASE_REF, branch.<name>.gh-merge-base, gh pr view, origin/main, origin/master, main, master)',
  );
}
