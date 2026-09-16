// Shared kit for every styleproof-* command: declarative flags, generated help,
// usage errors, and child-process plumbing.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const binDir = path.dirname(fileURLToPath(import.meta.url));

/** Print `<name>: <message>` and exit (2 = usage error by default). */
export function fail(name, message, code = 2) {
  console.error(`${name}: ${message}`);
  process.exit(code);
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Run `main`; any thrown error becomes `<name>: <message>` + exit code. */
export async function run(name, main, { exitCode = 1 } = {}) {
  try {
    await main();
  } catch (error) {
    fail(name, errorMessage(error), error?.exitCode ?? exitCode);
  }
}

/**
 * Define a command from a flag table. Each flag: `{ help, value?, repeat?, default?, negate?, required? }`.
 * A flag with `value` takes `--k v` or `--k=v`; without it, the flag is boolean (`--no-k` when `negate`).
 * `parse(argv)` yields `{ opts, args, passthrough }`; `-h/--help` prints the generated help.
 */
export function defineCli({ name, alias, summary, usage, flags, notes = [], positionals = false }) {
  const help = renderHelp({ name, alias, summary, usage, flags, notes });
  const parse = (argv = process.argv.slice(2)) => {
    if (argv.some((a) => a === '-h' || a === '--help')) {
      process.stdout.write(help);
      process.exit(0);
    }
    const opts = initialOptions(flags);
    const args = [];
    let passthrough = [];
    for (let i = 0; i < argv.length; i++) {
      const raw = argv[i];
      if (raw === '--') {
        passthrough = argv.slice(i + 1);
        break;
      }
      if (raw.startsWith('--')) i = applyFlag(name, flags, opts, argv, i);
      else args.push(raw);
    }
    if (!positionals && args.length) fail(name, `unexpected argument ${args[0]}`);
    for (const [key, spec] of Object.entries(flags)) {
      if (spec.required && (opts[key] === undefined || (spec.repeat && !opts[key].length)))
        fail(name, `missing --${key}`);
    }
    return { opts, args, passthrough };
  };
  return { help, parse };
}

/** Apply the flag at argv[i]; returns the index of the last consumed argument. */
function applyFlag(name, flags, opts, argv, i) {
  const token = resolveFlag(name, flags, argv[i]);
  if (!token.spec.value) {
    opts[token.key] = !token.negated;
    return i;
  }
  const value = token.inline ?? argv[i + 1];
  if (value === undefined || value === '' || (token.inline === undefined && value.startsWith('--'))) {
    fail(name, `missing value for --${token.flag}`);
  }
  if (token.spec.repeat) opts[token.key].push(value);
  else opts[token.key] = value;
  return token.inline === undefined ? i + 1 : i;
}

function initialOptions(flags) {
  const opts = {};
  for (const [key, spec] of Object.entries(flags)) {
    if (spec.repeat) opts[key] = [];
    else if (spec.default !== undefined) opts[key] = spec.default;
  }
  return opts;
}

function resolveFlag(name, flags, raw) {
  const eq = raw.indexOf('=');
  const flag = eq === -1 ? raw.slice(2) : raw.slice(2, eq);
  const inline = eq === -1 ? undefined : raw.slice(eq + 1);
  if (flags[flag]) return { key: flag, flag, spec: flags[flag], inline, negated: false };
  const base = flag.startsWith('no-') ? flag.slice(3) : '';
  if (base && flags[base]?.negate && !flags[base].value)
    return { key: base, flag, spec: flags[base], inline, negated: true };
  return fail(name, `unknown flag: ${raw}\nNext: run ${name} --help to see supported options.`);
}

function renderHelp({ name, alias, summary, usage, flags, notes }) {
  const rows = Object.entries(flags).map(([key, spec]) => {
    const left = `--${key}${spec.value ? ` <${spec.value}>` : ''}${spec.negate ? ` / --no-${key}` : ''}`;
    const suffix = spec.default !== undefined && spec.default !== false ? ` (default: ${spec.default})` : '';
    return [left, `${spec.help}${spec.repeat ? ' Repeatable.' : ''}${suffix}`];
  });
  rows.push(['-h, --help', 'show this help']);
  const width = Math.max(...rows.map(([left]) => left.length)) + 2;
  const lines = [
    `usage: ${usage[0]}`,
    ...usage.slice(1).map((line) => `       ${line}`),
    '',
    ...(summary ? [summary, ''] : []),
    'options:',
    ...rows.map(([left, right]) => `  ${left.padEnd(width)}${right}`),
    ...(notes.length ? ['', ...notes] : []),
  ];
  if (alias) lines.push('', `${name} is a compatibility alias for the unified CLI: styleproof ${alias}`);
  return `${lines.join('\n')}\n`;
}

/** Parse a numeric option; `integer`, `min`, and `max` bound it. Undefined passes through. */
export function number(name, flag, value, { integer = false, min = -Infinity, max = Infinity } = {}) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  const valid = Number.isFinite(parsed) && (!integer || Number.isInteger(parsed)) && parsed >= min && parsed <= max;
  if (valid) return parsed;
  const kind = integer ? 'integer' : 'number';
  const range =
    min === 0 && max === Infinity
      ? `a finite non-negative ${kind}`
      : min === 1 && max === Infinity
        ? `a positive ${kind}`
        : `${integer ? 'an' : 'a'} ${kind} from ${min} to ${max}`;
  return fail(name, `--${flag} must be ${range}`);
}

/** Read and parse a JSON file, or fail with a usage error naming it. */
export function readJson(name, file, what = file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return fail(name, `could not read ${what} at ${file}\n${errorMessage(error)}`);
  }
}

/** GitHub git-data API context shared by the branch-maintenance commands. */
export function githubApi(name, { repository, branch, tokenEnv = ['GH_TOKEN'] }) {
  const token = tokenEnv.map((key) => process.env[key]).find(Boolean);
  if (!token)
    fail(name, `${tokenEnv[0]}${tokenEnv.length > 1 ? ` (or ${tokenEnv.slice(1).join(', ')})` : ''} is required`);
  return { apiBaseUrl: process.env.GITHUB_API_URL || 'https://api.github.com', repository, token, branch };
}

/** Append `key=value` lines to $GITHUB_OUTPUT, or print them when unset. */
export function emitOutputs(lines) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  else console.log(lines.join('\n'));
}

/** PATH with the consumer's and this package's node_modules/.bin prepended. */
export function childEnv(cwd = process.cwd(), extra = {}) {
  const binDirs = [path.join(cwd, 'node_modules', '.bin'), path.resolve(binDir, '..', '..', '.bin')];
  return {
    ...process.env,
    ...extra,
    PATH: `${binDirs.join(path.delimiter)}${path.delimiter}${process.env.PATH ?? ''}`,
  };
}

/** Run a sibling styleproof-* command with inherited stdio. */
export function runBin(command, args, { cwd, env = childEnv(cwd), stdio = 'inherit' } = {}) {
  return spawnSync(process.execPath, [path.join(binDir, `${command}.mjs`), ...args], { stdio, cwd, env });
}

/** `git <args>` stdout (trimmed) or undefined on failure. */
export function gitOutput(args, cwd = process.cwd()) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  return r.status === 0 ? r.stdout.trimEnd() : undefined;
}
