import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** @typedef {{kind:'same-tree', tree:string} | {kind:'deleted'} | {kind:'differs'} | {kind:'unknown', reason:string}} Proof */

/** Only a nonempty, complete set of positive proofs permits a skip. */
export function browserLanesRequired(proofs) {
  if (!Array.isArray(proofs) || proofs.length === 0) return true;
  for (const proof of proofs) {
    if (proof?.kind === 'deleted') continue;
    if (proof?.kind !== 'same-tree' || typeof proof.tree !== 'string' || !oidPattern.test(proof.tree)) return true;
  }
  return false;
}

/** Read raw objects from cwd, never from an inherited repository or index. */
export function makeGit(cwd) {
  // Even discovering the local variable names must not open an inherited Git directory.
  const discoveryEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const local = spawnSync('git', ['--no-replace-objects', 'rev-parse', '--local-env-vars'], {
    cwd,
    env: { ...discoveryEnv, GIT_NO_REPLACE_OBJECTS: '1' },
    encoding: 'utf8',
  });
  const names = local.stdout?.trim().split(/\r?\n/);
  if (local.error || local.status !== 0 || !names?.length || names.some((name) => !/^GIT_[A-Z0-9_]+$/.test(name))) {
    return () => ({ ok: false, stdout: '', status: local.status, stderr: local.stderr ?? local.error?.message ?? '' });
  }
  const env = { ...process.env };
  for (const name of names) delete env[name];
  env.GIT_NO_REPLACE_OBJECTS = '1';
  return (args) => {
    const result = spawnSync('git', ['--no-replace-objects', ...args], { cwd, env, encoding: 'utf8' });
    return {
      ok: !result.error && result.status === 0,
      stdout: result.stdout ?? '',
      status: result.status,
      stderr: result.stderr ?? result.error?.message ?? '',
    };
  };
}

/** Resolve a root tree, rejecting missing objects and malformed output. */
export function treeOf(git, rev) {
  const result = git(['rev-parse', '--verify', '--end-of-options', `${rev}^{tree}`]);
  const tree = result.stdout.trim();
  if (!result.ok || !oidPattern.test(tree)) throw new Error('tree-unavailable');
  return tree.toLowerCase();
}

/** Read only the raw commit header, which is unaffected by grafts. */
export function parentsOf(git, oid) {
  if (typeof oid !== 'string' || !oidPattern.test(oid)) throw new Error('invalid-commit');
  const result = git(['cat-file', 'commit', oid]);
  if (!result.ok) throw new Error('commit-unavailable');
  const header = result.stdout.split('\n\n', 1)[0];
  if (!/^tree [0-9a-f]{40}(?:[0-9a-f]{24})?\n/.test(`${header}\n`)) throw new Error('invalid-commit-header');
  return header
    .split('\n')
    .filter((line) => line.startsWith('parent '))
    .map((line) => {
      const parent = line.slice(7);
      if (!oidPattern.test(parent)) throw new Error('invalid-parent');
      return parent.toLowerCase();
    });
}

/** A failure can require proof or fail the job, but can never authorize a skip. */
export function decideGithub(options = {}) {
  try {
    const { eventName, sha, event, git } = options ?? {};
    if (eventName !== 'pull_request') {
      const name = typeof eventName === 'string' && /^[a-z_]+$/.test(eventName) ? eventName : 'unknown';
      return { lanes: true, proof: `run:event-${name}` };
    }
    const base = event?.pull_request?.base?.sha;
    if (typeof base !== 'string' || !oidPattern.test(base)) return { lanes: true, proof: 'run:no-base' };
    const head = git(['rev-parse', '--verify', 'HEAD']);
    if (!head.ok) return { lanes: true, proof: 'run:git-error' };
    const oid = head.stdout.trim().toLowerCase();
    if (typeof sha !== 'string' || !oidPattern.test(sha) || !oidPattern.test(oid) || oid !== sha.toLowerCase()) {
      return { lanes: true, proof: 'run:checkout-mismatch' };
    }
    const parents = parentsOf(git, oid);
    if (parents.length !== 2 || parents[0] !== base.toLowerCase()) {
      return { lanes: true, proof: 'run:not-merge-of-base' };
    }
    const tree = treeOf(git, oid);
    const proof = tree === treeOf(git, base) ? { kind: 'same-tree', tree } : { kind: 'differs' };
    const lanes = browserLanesRequired([proof]);
    return { lanes, proof: lanes ? 'run:tree-differs' : `same-tree:${tree}` };
  } catch {
    return { lanes: true, proof: 'run:git-error' };
  }
}

function githubMain() {
  let decision;
  try {
    const eventName = process.env.GITHUB_EVENT_NAME;
    decision = decideGithub({
      eventName,
      sha: process.env.GITHUB_SHA,
      event:
        eventName === 'pull_request' ? JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : undefined,
      git: eventName === 'pull_request' ? makeGit(process.cwd()) : undefined,
    });
  } catch {
    decision = { lanes: true, proof: 'run:event-error' };
  }
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `lanes=${decision.lanes}\nproof=${decision.proof}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === '--github') {
  githubMain();
}
