import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NODE_TEST_TIMEOUT_MS, nodeTestArgs, nodeTestEnv } from './run-node-test.mjs';

/**
 * Local unsharded coverage keeps its legacy 40% floor: Node merges V8 ranges
 * before projecting lines. CI unions LCOV line hits instead; its 80% floor
 * leaves ~7 points below the hosted 86.78% baseline, comparable to the old
 * ~8 points below main's unsharded 47.96%. Those baselines include Node's
 * in-shard loader-transform merge bug; shards now union raw process hits.
 * The unsharded path still uses Node's merge. Flags need Node 22.8+.
 */
export const COVERAGE_LINE_FLOOR = 40;
export const MERGED_COVERAGE_LINE_FLOOR = 80;
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
  shard,
  lcov,
} = {}) {
  if (!coverageToolSupported(nodeMajor, nodeMinor)) return null;
  if ((shard || lcov) && (!/^[1-3]\/3$/.test(shard ?? '') || !lcov)) {
    throw new Error('check-coverage: use --shard i/3 --lcov <file>');
  }
  return [
    '--experimental-test-coverage',
    `--test-coverage-include=${include}`,
    `--test-coverage-exclude=${exclude}`,
    ...(shard
      ? [`--test-shard=${shard}`, '--test-reporter=spec', '--test-reporter-destination=stdout']
      : [`--test-coverage-lines=${floor}`]),
  ];
}

/** Reject transformed scripts and sources outside the package build output. */
function coverageSource(processCoverage, script, readSource) {
  if (!script.url.startsWith('file:')) return null;
  const file = fileURLToPath(script.url);
  const relative = path.relative(process.cwd(), file).replaceAll('\\', '/');
  if (!relative.startsWith('dist/') || relative.split('/').includes('node_modules')) return null;
  if (Object.hasOwn(processCoverage['source-map-cache'] ?? {}, script.url)) return null;
  const source = readSource(file);
  if (script.functions[0]?.ranges[0]?.endOffset !== source.length) return null;
  return { relative, source };
}

/** Node keeps newlines and lets the last fully spanning range set each count. */
function processLineHits(script, source) {
  let offset = 0;
  const lines = source.split(/(?<=\n)/).map((text) => {
    const start = offset;
    offset += text.length;
    return { start, end: offset, count: 0 };
  });
  for (const range of script.functions.flatMap((fn) => fn.ranges)) {
    for (const line of lines) {
      if (range.startOffset <= line.start && range.endOffset >= line.end) line.count = range.count;
    }
  }
  return lines.map((line) => Number(line.count > 0));
}

/** Project each process independently, then union hits from on-disk dist sources. */
export function lineHitsFromV8(processes, readSource) {
  const union = new Map();
  for (const processCoverage of processes) {
    for (const script of processCoverage.result) {
      const eligible = coverageSource(processCoverage, script, readSource);
      if (!eligible) continue;
      const hits = union.get(eligible.relative) ?? new Map();
      processLineHits(script, eligible.source).forEach((hit, index) => {
        hits.set(index + 1, hits.get(index + 1) || hit);
      });
      union.set(eligible.relative, hits);
    }
  }
  return union;
}

function main() {
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  const argv = process.argv.slice(2);
  if (argv.length && (argv.length !== 4 || argv[0] !== '--shard' || argv[2] !== '--lcov')) {
    throw new Error('check-coverage: use --shard i/3 --lcov <file>');
  }
  const cov = coverageArgs({ nodeMajor, nodeMinor, shard: argv[1], lcov: argv[3] });
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
  const env = nodeTestEnv();
  const raw = argv[1] ? fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-v8-')) : null;
  if (raw) env.NODE_V8_COVERAGE = raw;
  let status;
  try {
    const result = spawnSync(process.execPath, args, { stdio: 'inherit', env });
    status = result.status ?? 1;
    if (raw) {
      const processes = fs
        .readdirSync(raw)
        .filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(fs.readFileSync(path.join(raw, name), 'utf8')));
      const hits = lineHitsFromV8(processes, (file) => fs.readFileSync(file, 'utf8'));
      const records = [...hits].map(
        ([file, lines]) =>
          `SF:${file}\n${[...lines].map(([line, hit]) => `DA:${line},${hit}`).join('\n')}\nend_of_record\n`,
      );
      fs.writeFileSync(argv[3], records.join(''));
      if (!hits.size) status = 1;
    }
  } finally {
    if (raw) fs.rmSync(raw, { recursive: true, force: true });
  }
  process.exit(status);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
