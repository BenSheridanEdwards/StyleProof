// Pre-push unit tests: only the test files the pushed commits can reach. The full suite runs in CI.
//
// A test is selected when it changed, or when a changed file is reachable from it through relative
// string specifiers ('../dist/x.js', new URL('../.github/workflows/ci.yml', …)), following imports
// inside dist/, bin/ and scripts/. A src/x.ts change maps to dist/x.js. Shared inputs (manifests,
// tsconfig, the test runner, test helpers) or a code change no test reaches runs the whole suite.
import { runWithTmp } from './run-tmp.mjs';
import { nodeTestArgs, nodeTestEnv } from './run-node-test.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPECIFIER = /['"`](\.\.?\/[^'"`\s$]+)['"`]/g;
const WHOLE_SUITE = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^tsconfig[^/]*\.json$/,
  /^\.nvmrc$/,
  /^scripts\/run-(node-test|tmp)\.mjs$/,
  /^test\/(?!.*\.test\.mjs$)/,
  /^vendor\//,
];
const CODE = /^(src|bin|scripts)\//;

export function referencedPaths(file, text) {
  const found = new Set();
  for (const [, specifier] of text.matchAll(SPECIFIER)) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    if (!resolved.startsWith('../')) found.add(resolved);
  }
  return [...found];
}

function buildOutput(file) {
  return file.startsWith('src/') ? file.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js') : file;
}

function reachable(test, read) {
  const seen = new Set([test]);
  const queue = [test];
  while (queue.length > 0) {
    const file = queue.pop();
    for (const next of referencedPaths(file, read(file))) {
      if (seen.has(next)) continue;
      seen.add(next);
      if (/^(dist|bin|scripts)\//.test(next)) queue.push(next);
    }
  }
  return seen;
}

/** { mode: 'all' | 'some' | 'none', files } for the changed repo-relative paths. */
export function selectUnitTests({ changed, tests, read }) {
  if (changed.some((file) => WHOLE_SUITE.some((pattern) => pattern.test(file)))) return { mode: 'all', files: tests };
  const targets = new Set(changed.map(buildOutput));
  const closures = new Map(tests.map((test) => [test, reachable(test, read)]));
  const files = tests.filter((test) => [...targets].some((target) => closures.get(test).has(target)));
  const reached = new Set([...closures.values()].flatMap((closure) => [...closure]));
  const unmapped = changed.filter((file) => CODE.test(file) && !reached.has(buildOutput(file)));
  if (unmapped.length > 0) return { mode: 'all', files: tests };
  return files.length > 0 ? { mode: 'some', files } : { mode: 'none', files: [] };
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
}

async function main() {
  const [base] = git('merge-base', 'origin/main', 'HEAD');
  const changed = git('diff', '--name-only', `${base}..HEAD`);
  const tests = fs
    .readdirSync(path.join(ROOT, 'test'))
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => `test/${name}`)
    .sort();
  const read = (file) => {
    const absolute = path.join(ROOT, file);
    return fs.statSync(absolute, { throwIfNoEntry: false })?.isFile() ? fs.readFileSync(absolute, 'utf8') : '';
  };
  const { mode, files } = selectUnitTests({ changed, tests, read });
  if (mode === 'none') {
    console.log('  no unit test reaches the pushed changes; CI runs the full suite.');
    return;
  }
  console.log(
    mode === 'all'
      ? '  shared inputs changed: running the whole unit suite.'
      : `  ${files.length} of ${tests.length} test files reach the pushed changes.`,
  );
  process.exitCode = await runWithTmp(process.execPath, nodeTestArgs({ files }), { env: nodeTestEnv() });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
