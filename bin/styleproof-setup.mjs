#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const binDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(binDir, '..');
const packageManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
const version = packageManifest.version;

const HELP = `styleproof setup — install, scaffold, and verify StyleProof in one command

usage: styleproof setup [options]

options:
  --dir <path>       capture spec path (default: e2e/styleproof.spec.ts)
  --base-url <url>   application URL (default: http://localhost:3000)
  --force            overwrite the existing capture spec
  --skip-install     do not add StyleProof and Playwright to the project
  --skip-browser     do not install Playwright Chromium
  --dry-run          print the exact plan without running commands or writing files
  -h, --help         show this help

Default workflow:
  1. detect npm, pnpm, Yarn, or Bun from the lockfile
  2. install styleproof@${version} and @playwright/test
  3. install Chromium
  4. scaffold the capture spec, workflows, and pre-push integration
  5. verify generated files against this release

Setup proves installation and scaffold integrity. Full certification still requires
an asserted expected inventory and proven deterministic capture evidence.
`;

const argv = process.argv.slice(2);
let dryRun = false;
let skipInstall = false;
let skipBrowser = false;
const initArgs = [];
const checkArgs = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '-h' || arg === '--help') {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (arg === '--dry-run') dryRun = true;
  else if (arg === '--skip-install') skipInstall = true;
  else if (arg === '--skip-browser') skipBrowser = true;
  else if (arg === '--force') initArgs.push(arg);
  else if (arg === '--dir' || arg === '--base-url') {
    const value = argv[++i];
    if (!value) {
      process.stderr.write(`styleproof setup: ${arg} requires a value\n`);
      process.exit(2);
    }
    initArgs.push(arg, value);
    if (arg === '--dir') checkArgs.push(arg, value);
  } else if (arg.startsWith('--dir=')) {
    initArgs.push(arg);
    checkArgs.push(arg);
  } else if (arg.startsWith('--base-url=')) initArgs.push(arg);
  else {
    process.stderr.write(`styleproof setup: unknown option: ${arg}\nNext: run styleproof setup --help.\n`);
    process.exit(2);
  }
}

const cwd = process.cwd();
if (!fs.existsSync(path.join(cwd, 'package.json'))) {
  process.stderr.write('styleproof setup: package.json was not found in the current directory\n');
  process.exit(2);
}

function detectPackageManager(root) {
  if (fs.existsSync(path.join(root, 'bun.lock')) || fs.existsSync(path.join(root, 'bun.lockb'))) return 'bun';
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

const manager = detectPackageManager(cwd);
const plans = {
  npm: {
    install: ['npm', ['install', '--save-dev', `styleproof@${version}`, '@playwright/test@>=1.40']],
    browser: ['npm', ['exec', 'playwright', 'install', 'chromium']],
  },
  pnpm: {
    install: ['pnpm', ['add', '--save-dev', `styleproof@${version}`, '@playwright/test@>=1.40']],
    browser: ['pnpm', ['exec', 'playwright', 'install', 'chromium']],
  },
  yarn: {
    install: ['yarn', ['add', '--dev', `styleproof@${version}`, '@playwright/test@>=1.40']],
    browser: ['yarn', ['exec', 'playwright', 'install', 'chromium']],
  },
  bun: {
    install: ['bun', ['add', '--dev', `styleproof@${version}`, '@playwright/test@>=1.40']],
    browser: ['bunx', ['playwright', 'install', 'chromium']],
  },
};

function printable(command, args) {
  return [command, ...args].join(' ');
}

function run(command, args, label, display = printable(command, args)) {
  if (dryRun) {
    process.stdout.write(`${display}\n`);
    return;
  }
  process.stdout.write(`\nStyleProof: ${label}\n`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) {
    process.stderr.write(`styleproof setup: ${label} failed: ${result.error.message}\n`);
    process.exit(5);
  }
  if (result.status !== 0) process.exit(result.status ?? 5);
}

if (!skipInstall) run(...plans[manager].install, `installing dependencies with ${manager}`);
if (!skipBrowser) run(...plans[manager].browser, 'installing Chromium');
run(
  process.execPath,
  [path.join(binDir, 'styleproof-init.mjs'), ...initArgs],
  'scaffolding project',
  printable('styleproof-init', initArgs),
);
run(
  process.execPath,
  [path.join(binDir, 'styleproof-init.mjs'), ...checkArgs, '--check'],
  'verifying scaffold',
  printable('styleproof-init', [...checkArgs, '--check']),
);

if (!dryRun) {
  process.stdout.write(
    '\nStyleProof setup complete. Next: run `styleproof capture`, then declare expected surfaces before treating evidence as certified.\n',
  );
}
