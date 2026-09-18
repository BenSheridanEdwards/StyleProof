import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Per-test runner timeout. Node 18 rejects `--test-timeout`; Node 20+ accepts it. */
export const NODE_TEST_TIMEOUT_MS = 300_000;

export function nodeTestArgs({ nodeMajor = Number(process.versions.node.split('.')[0]), watch = false, files } = {}) {
  const args = ['--test'];
  if (watch) args.push('--watch');
  if (nodeMajor >= 20) args.push(`--test-timeout=${NODE_TEST_TIMEOUT_MS}`);
  args.push(...(files ?? defaultTestFiles()));
  return args;
}

function defaultTestFiles() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = path.join(root, 'test');
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => path.join('test', name))
    .sort();
}

function main() {
  const watch = process.argv.includes('--watch');
  const result = spawnSync(process.execPath, nodeTestArgs({ watch }), { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
