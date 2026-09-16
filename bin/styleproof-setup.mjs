#!/usr/bin/env node
// Install, scaffold, and verify StyleProof in one command: detect the package
// manager, install styleproof + Playwright + Chromium, run styleproof-init, then
// verify the generated files against this release.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveSpawnCommand } from './platform-command.mjs';
import { detectPackageManager } from './package-manager.mjs';
import { binDir, defineCli, errorMessage, fail } from './cli.mjs';

const NAME = 'styleproof setup';
const version = JSON.parse(fs.readFileSync(path.join(binDir, '..', 'package.json'), 'utf8')).version;
const cli = defineCli({
  name: NAME,
  alias: 'setup',
  usage: [`${NAME} [options]`],
  flags: {
    'project-dir': { value: 'path', help: 'consumer project root', default: '.' },
    dir: { value: 'path', help: 'capture spec path inside the project (default: e2e/styleproof.spec.ts)' },
    'base-url': { value: 'url', help: 'application URL (default: http://localhost:3000)' },
    'server-command': { value: 'command', help: 'explicit production build/serve command' },
    'external-server': { help: 'do not manage a server; BASE_URL must already be available' },
    force: { help: 'overwrite the existing capture spec' },
    workflow: {
      value: 'mode',
      help: 'single (default) | split — one in-job workflow, or the fork-safe two-stage layout',
    },
    storage: {
      value: 'mode',
      help: 'artifact (default) | branch — no map-store branch, or the styleproof-maps cache with a pre-push hook',
    },
    mode: { value: 'gate', help: 'advisory (default) | certify | review-gate' },
    'skip-install': { help: 'do not add StyleProof and Playwright to the project' },
    'skip-browser': { help: 'do not install Playwright Chromium' },
    'dry-run': { help: 'print the exact plan without running commands or writing files' },
  },
  notes: [
    'Default workflow:',
    '  1. detect npm, pnpm, Yarn, or Bun from the lockfile',
    `  2. install styleproof@${version} and @playwright/test`,
    '  3. install Chromium',
    '  4. scaffold the capture spec and one StyleProof workflow',
    '  5. verify generated files against this release',
    '',
    'Setup proves installation and scaffold integrity. Full certification still requires',
    'an asserted expected inventory and proven deterministic capture evidence.',
  ],
});

const { opts } = cli.parse();
const dryRun = Boolean(opts['dry-run']);
// Flags forwarded to styleproof-init; the check pass only takes the server-contract ones.
const forward = (keys) =>
  keys.flatMap((key) =>
    opts[key] === undefined || opts[key] === false ? [] : opts[key] === true ? [`--${key}`] : [`--${key}=${opts[key]}`],
  );
const checkArgs = forward(['dir', 'base-url', 'server-command', 'external-server']);
const initArgs = [...checkArgs, ...forward(['force', 'workflow', 'storage', 'mode'])];

const cwd = path.resolve(process.cwd(), opts['project-dir']);
if (!fs.existsSync(path.join(cwd, 'package.json')))
  fail(NAME, `package.json was not found in project directory ${cwd}`);
if (dryRun) process.stdout.write(`Project: ${cwd}\n`);

// Validate the generated server contract before installing or scaffolding; this
// read-only preflight also runs for --dry-run, so planning and execution agree.
const init = path.join(binDir, 'styleproof-init.mjs');
const preflight = spawnSync(process.execPath, [init, ...checkArgs, '--validate-server'], { cwd, encoding: 'utf8' });
if (preflight.error) fail(NAME, `server validation failed: ${preflight.error.message}`, 5);
if (preflight.status !== 0) {
  process.stderr.write(preflight.stderr);
  process.exit(preflight.status ?? 5);
}

let manager;
try {
  manager = detectPackageManager(cwd);
} catch (error) {
  fail(NAME, errorMessage(error));
}
const packages = [`styleproof@${version}`, '@playwright/test@>=1.40'];
const plans = {
  npm: {
    install: ['npm', ['install', '--save-dev', ...packages]],
    browser: ['npm', ['exec', 'playwright', 'install', 'chromium']],
  },
  pnpm: {
    install: ['pnpm', ['add', '--save-dev', ...packages]],
    browser: ['pnpm', ['exec', 'playwright', 'install', 'chromium']],
  },
  yarn: {
    install: ['yarn', ['add', '--dev', ...packages]],
    browser: ['yarn', ['exec', 'playwright', 'install', 'chromium']],
  },
  bun: { install: ['bun', ['add', '--dev', ...packages]], browser: ['bunx', ['playwright', 'install', 'chromium']] },
};

const quote = (arg) => {
  if (!/\s/.test(arg)) return arg;
  const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
  return eq === -1 ? JSON.stringify(arg) : `${arg.slice(0, eq + 1)}${JSON.stringify(arg.slice(eq + 1))}`;
};
const printable = (command, args) => [command, ...args.map(quote)].join(' ');

function run(command, args, label, display = printable(command, args)) {
  if (dryRun) {
    process.stdout.write(`${display}\n`);
    return;
  }
  process.stdout.write(`\nStyleProof: ${label}\n`);
  const result = spawnSync(resolveSpawnCommand(command), args, { cwd, stdio: 'inherit' });
  if (result.error) fail(NAME, `${label} failed: ${result.error.message}`, 5);
  if (result.status !== 0) process.exit(result.status ?? 5);
}

if (!opts['skip-install']) run(...plans[manager].install, `installing dependencies with ${manager}`);
if (!opts['skip-browser']) run(...plans[manager].browser, 'installing Chromium');
run(process.execPath, [init, ...initArgs], 'scaffolding project', printable('styleproof-init', initArgs));
run(
  process.execPath,
  [init, ...checkArgs, '--check'],
  'verifying scaffold',
  printable('styleproof-init', [...checkArgs, '--check']),
);

if (!dryRun) {
  process.stdout.write(
    '\nStyleProof setup complete. Next: run `styleproof capture`, then declare expected surfaces before treating evidence as certified.\n',
  );
}
