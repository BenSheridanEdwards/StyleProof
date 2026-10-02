import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NODE_TEST_TIMEOUT_MS, nodeTestArgs, nodeTestEnv } from './run-node-test.mjs';

/**
 * Unit coverage floor for the package dist/ tree (Node built-in
 * `--experimental-test-coverage`). Measured on tip `6155b54` / main with
 * Node 22.20: 41.49% lines under a dist-only include. Floor = baseline minus
 * ~1.5pt slack. Thresholds + include globs need Node 22.8+ (CI gates on the
 * Node 22 matrix leg).
 */
export const COVERAGE_LINE_FLOOR = 40;
/** Only the package build output — not node_modules dist trees. */
export const COVERAGE_INCLUDE = 'dist/**';
export const COVERAGE_EXCLUDE = '**/node_modules/**';
export const COVERAGE_MIN_NODE = { major: 22, minor: 8 };
/** Coverage instrumentation slows the suite; give each file 2× the unit budget. */
export const COVERAGE_TEST_TIMEOUT_MS = NODE_TEST_TIMEOUT_MS * 2;

/** True when this Node build supports coverage include + line thresholds. */
export function coverageToolSupported(
  nodeMajor = Number(process.versions.node.split('.')[0]),
  nodeMinor = Number(process.versions.node.split('.')[1] ?? 0),
) {
  const { major, minor } = COVERAGE_MIN_NODE;
  return nodeMajor > major || (nodeMajor === major && nodeMinor >= minor);
}

/** CLI args for a coverage-gated unit run, or `null` when the toolchain cannot enforce the floor. */
export function coverageArgs({
  nodeMajor = Number(process.versions.node.split('.')[0]),
  nodeMinor = Number(process.versions.node.split('.')[1] ?? 0),
  floor = COVERAGE_LINE_FLOOR,
  include = COVERAGE_INCLUDE,
  exclude = COVERAGE_EXCLUDE,
} = {}) {
  if (!coverageToolSupported(nodeMajor, nodeMinor)) return null;
  return [
    '--experimental-test-coverage',
    `--test-coverage-include=${include}`,
    `--test-coverage-exclude=${exclude}`,
    `--test-coverage-lines=${floor}`,
  ];
}

function main() {
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  const cov = coverageArgs({ nodeMajor, nodeMinor });
  if (!cov) {
    console.error(
      `check-coverage: needs Node ${COVERAGE_MIN_NODE.major}.${COVERAGE_MIN_NODE.minor}+ ` +
        `for --test-coverage-lines / --test-coverage-include (got ${process.versions.node}). ` +
        'CI enforces the floor on the Node 22 matrix leg; develop with Node 22.13+.',
    );
    process.exit(1);
  }
  // Override timeout after nodeTestArgs so coverage gets the longer budget.
  const base = nodeTestArgs({ nodeMajor });
  const args = [...cov];
  for (const arg of base) {
    if (arg.startsWith('--test-timeout=')) args.push(`--test-timeout=${COVERAGE_TEST_TIMEOUT_MS}`);
    else args.push(arg);
  }
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: nodeTestEnv() });
  process.exit(result.status ?? 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
