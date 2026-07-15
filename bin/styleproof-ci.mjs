#!/usr/bin/env node
/**
 * Cache-first CI map orchestration, packaged:
 *
 *   restore base+head from the map store → on a miss, capture in this pinned
 *   environment (cold base rebuild under the head's exact StyleProof release,
 *   HAR replay for the head) → publish every fallback capture for reuse.
 *
 * One command replaces the ~80 lines of workflow bash styleproof-init used to
 * generate (and every consumer then hand-maintained). The generated workflow
 * step is now a single invocation, so the orchestration updates with each
 * styleproof release instead of drifting per repo.
 *
 * DESTRUCTIVE by design: it runs `git checkout --force` on the base and head
 * commits, exactly like the workflow bash it replaces. It therefore refuses to
 * run without CI=1 unless --force is passed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isHelpArg, projectConfigOrExit, showHelpAndExit, unknownFlagMessage } from '../dist/cli-errors.js';
import { ciOutputLines, classifyRestoreExit, detectPackageManagerPlan } from '../dist/ci.js';

const HELP = `styleproof-ci — restore or capture the base/head maps for a PR, cache-first

usage: styleproof-ci --base <sha> --head <sha> [options]

Restores both exact-SHA bundles from the styleproof-maps branch into
<base-dir>/base and <base-dir>/head. On a head-only miss it captures just the
head (replaying the base's recorded data when HAR files are present). On a base
miss it rebuilds the pair in one pinned environment: base checkout → its own
dependency install → the head's exact StyleProof release → capture+publish base
→ head checkout → capture+publish head.

If the base capture itself fails, the command records a bare baseline and still
captures the head. That degraded, head-only result is explicit in
base-capture-failed=true; a failed head capture still fails the command.

options:
  --base <sha>        base commit (e.g. github.event.pull_request.base.sha)
  --head <sha>        head commit (e.g. github.event.pull_request.head.sha)
  --spec <path>       StyleProof spec (default: e2e/styleproof.spec.ts)
  --base-dir <path>   map root; base/head land under it
                      (default: $RUNNER_TEMP/styleproof-maps, else .styleproof/ci-maps)
  --force             run outside CI (the flow force-checkouts commits — it will
                      discard uncommitted changes in this working tree)
  -h, --help          show this help

Writes base-hit / head-hit / capture-needed / base-capture-failed to
$GITHUB_OUTPUT when set, so workflow steps can branch on steps.<id>.outputs.*.

exit codes:
  0  both maps present (restored or captured+published)
  2  usage error
  *  a persistent map-store/network fault keeps the restore CLI's code (a re-run
     is cheap and correct); a failed capture propagates its own code
`;

const argv = process.argv.slice(2);
// Loaded from the CURRENT checkout — by the time captures run, the flow has
// checked out the commit whose config should govern it anyway.
const projectConfig = projectConfigOrExit('styleproof-ci');
let base = '';
let head = '';
let spec = projectConfig.spec ?? 'e2e/styleproof.spec.ts';
let baseDir = process.env.RUNNER_TEMP ? path.join(process.env.RUNNER_TEMP, 'styleproof-maps') : '.styleproof/ci-maps';
let force = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (isHelpArg(a)) showHelpAndExit(HELP);
  else if (a === '--base') base = argv[++i];
  else if (a.startsWith('--base=')) base = a.slice(7);
  else if (a === '--head') head = argv[++i];
  else if (a.startsWith('--head=')) head = a.slice(7);
  else if (a === '--spec') spec = argv[++i];
  else if (a.startsWith('--spec=')) spec = a.slice(7);
  else if (a === '--base-dir') baseDir = argv[++i];
  else if (a.startsWith('--base-dir=')) baseDir = a.slice(11);
  else if (a === '--force') force = true;
  else {
    console.error(unknownFlagMessage('styleproof-ci', a));
    process.exit(2);
  }
}

if (!base || !head) {
  console.error('styleproof-ci: --base <sha> and --head <sha> are required');
  process.exit(2);
}
if (!process.env.CI && !force) {
  console.error(
    'styleproof-ci: refusing to run outside CI — the flow runs `git checkout --force`, which discards\n' +
      'uncommitted changes and moves HEAD in this working tree. Pass --force if you really mean it.',
  );
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const MAP = path.join(here, 'styleproof-map.mjs');
// The head's exact release to pin the cold base rebuild to: this very package.
const OWN_VERSION = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;
const root = path.resolve(baseDir);
// Children spawn the `playwright` binary by name; make sure the consumer's
// node_modules/.bin is on PATH even when this command was invoked bare.
const binDirs = [path.join(process.cwd(), 'node_modules', '.bin'), path.resolve(here, '..', '..', '.bin')];
const env = { ...process.env, PATH: `${binDirs.join(path.delimiter)}${path.delimiter}${process.env.PATH ?? ''}` };

function log(message) {
  console.error(`styleproof-ci: ${message}`);
}

/** Run a command with inherited stdio; exit with its code (or 1) on failure. */
function runOrDie(command, what, extraEnv = {}) {
  const r = spawnSync(command[0], command.slice(1), { stdio: 'inherit', env: { ...env, ...extraEnv } });
  if (r.error) {
    console.error(`styleproof-ci: could not run ${command[0]} (${what})\n${r.error.message}`);
    process.exit(1);
  }
  if ((r.status ?? 1) !== 0) {
    console.error(`styleproof-ci: ${what} failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

function checkout(sha) {
  runOrDie(['git', 'checkout', '--force', sha], `git checkout --force ${sha.slice(0, 12)}`);
}

function restore(sha, dir) {
  const r = spawnSync(
    process.execPath,
    [MAP, '--restore', '--sha', sha, '--dir', dir, '--base-dir', root, '--spec', spec],
    { stdio: 'inherit', env },
  );
  const outcome = classifyRestoreExit(r.status);
  if (outcome === 'fault') {
    // Neither a hit nor a genuine miss: a PERSISTENT map-store/network fault
    // (the restore CLI already retried). Fail the job loudly — a re-run is cheap
    // and correct — rather than silently paying a full cold recapture on every
    // flaky network blip.
    console.error(
      `styleproof-ci: ${dir} map restore hit a map-store/network fault (exit ${r.status}). Re-run the job.`,
    );
    process.exit(r.status ?? 5);
  }
  return outcome === 'hit';
}

function playwrightInstall() {
  const command = process.platform === 'win32' ? 'playwright.cmd' : 'playwright';
  runOrDie([command, 'install', '--with-deps', 'chromium'], 'playwright install');
}

function capture(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [MAP, ...args], { stdio: 'inherit', env: { ...env, ...extraEnv } });
  if (r.error) {
    console.error(`styleproof-ci: could not run styleproof-map capture\n${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
}

function captureOrDie(args, extraEnv = {}) {
  const status = capture(args, extraEnv);
  if (status !== 0) process.exit(status);
}

function hasHarFiles(dir) {
  if (!fs.existsSync(dir)) return false;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() ? hasHarFiles(full) : entry.name.endsWith('.har')) return true;
  }
  return false;
}

/** True iff git tracks the file at HEAD — only those can be `git checkout --`ed. */
function tracked(file) {
  return spawnSync('git', ['ls-files', '--error-unmatch', file], { stdio: 'ignore', env }).status === 0;
}

// --- Restore both sides, computing each SHA's compatibility key in that commit's
// own dependency context (keys include the checked-out lockfile), while reusing
// the already-installed StyleProof release for the CLI itself. -----------------
fs.rmSync(root, { recursive: true, force: true });
checkout(base);
const baseHit = restore(base, 'base');
checkout(head);
const headHit = restore(head, 'head');

function writeOutputs(baseCaptureFailed = false) {
  const outputs = ciOutputLines(baseHit, headHit, baseCaptureFailed);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${outputs.join('\n')}\n`);
  log(outputs.join(' '));
}

if (baseHit && headHit) {
  writeOutputs();
  log('both maps restored — no capture needed');
  process.exit(0);
}

let baseCaptureFailed = false;
if (!baseHit) {
  // Without a compatible base bundle, rebuild and publish the pair in one pinned
  // environment. This is the expensive cold path.
  fs.rmSync(root, { recursive: true, force: true });
  checkout(base);
  const basePm = detectPackageManagerPlan(process.cwd());
  log(`base miss — rebuilding the pair cold (${basePm.name})`);
  runOrDie(basePm.install, `${basePm.name} install at base`);
  // The base may depend on an older StyleProof. Install the head's exact release,
  // then restore the tracked metadata that temporary install dirtied: node_modules
  // must keep the exact release while the capture tree stays clean.
  runOrDie(basePm.installExactStyleProof(OWN_VERSION), `install styleproof@${OWN_VERSION}`);
  for (const file of basePm.packageMetadataFiles) {
    if (tracked(file)) runOrDie(['git', 'checkout', '--', file], `restore ${file}`);
  }
  playwrightInstall();
  if (fs.existsSync(spec)) {
    const baseStatus = capture([
      '--spec',
      spec,
      '--dir',
      'base',
      '--base-dir',
      root,
      '--keep-har',
      '--sha',
      base,
      '--upload',
    ]);
    if (baseStatus !== 0) {
      log(`base capture failed (exit ${baseStatus}) — continuing with a bare baseline`);
      fs.rmSync(path.join(root, 'base'), { recursive: true, force: true });
      fs.mkdirSync(path.join(root, 'base'), { recursive: true });
      baseCaptureFailed = true;
    }
  } else {
    // The base commit predates the spec (first adoption): an empty base dir means
    // "no baseline yet" and the diff takes the new-surfaces review path.
    fs.mkdirSync(path.join(root, 'base'), { recursive: true });
  }
  checkout(head);
  const headPm = detectPackageManagerPlan(process.cwd());
  runOrDie(headPm.install, `${headPm.name} install at head`);
  playwrightInstall();
} else {
  // A compatible base hit proves the current head environment. Keep that restored
  // base and capture only the missing head.
  log('head miss — capturing only the head');
  fs.rmSync(path.join(root, 'head'), { recursive: true, force: true });
  playwrightInstall();
}

const replay = hasHarFiles(path.join(root, 'base')) ? { STYLEPROOF_REPLAY_FROM: path.join(root, 'base') } : {};
captureOrDie(['--spec', spec, '--dir', 'head', '--base-dir', root, '--sha', head, '--upload'], replay);
writeOutputs(baseCaptureFailed);
process.exit(0);
