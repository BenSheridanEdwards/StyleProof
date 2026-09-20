import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Per-test runner timeout. Node 18 rejects `--test-timeout`; Node 20+ accepts it. */
export const NODE_TEST_TIMEOUT_MS = 300_000;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Preload that disables V8 concurrent job tiers in every Node child (#718). */
const NO_CONCURRENT_JOBS_PRELOAD = path.join(ROOT, 'test', 'no-concurrent-jobs.cjs');

export function nodeTestArgs({ nodeMajor = Number(process.versions.node.split('.')[0]), watch = false, files } = {}) {
  const args = ['--test'];
  if (watch) args.push('--watch');
  if (nodeMajor >= 20) args.push(`--test-timeout=${NODE_TEST_TIMEOUT_MS}`);
  args.push(...(files ?? defaultTestFiles()));
  return args;
}

/**
 * Env for the test-runner spawn. NODE_OPTIONS=--require reaches the --test
 * workers and, through env inheritance, every spawnSync'd CLI child — the
 * process layer where a deadlocked V8 job worker otherwise stalls the suite
 * past --test-timeout's reach (the timeout timer cannot fire while the worker
 * is blocked inside a synchronous spawn).
 */
export function nodeTestEnv(env = process.env, preload = NO_CONCURRENT_JOBS_PRELOAD) {
  if (/\s/.test(preload)) return { ...env }; // NODE_OPTIONS cannot quote paths
  const prefix = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : '';
  return { ...env, NODE_OPTIONS: `${prefix}--require ${preload}` };
}

function defaultTestFiles() {
  const dir = path.join(ROOT, 'test');
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => path.join('test', name))
    .sort();
}

function main() {
  const watch = process.argv.includes('--watch');
  const result = spawnSync(process.execPath, nodeTestArgs({ watch }), { stdio: 'inherit', env: nodeTestEnv() });
  process.exit(result.status ?? 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
