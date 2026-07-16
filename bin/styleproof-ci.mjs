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
 * DESTRUCTIVE by design on the consumer HEAD only: it may run `git checkout
 * --force` on `--head` so the PR checkout stays pinned, but it never checks
 * the consumer out to `--base`. Restore probes and cold base install/capture
 * run in detached ephemeral worktrees under RUNNER_TEMP (or the OS temp dir).
 * Pass --force outside CI at your own risk.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isHelpArg, projectConfigOrExit, showHelpAndExit, unknownFlagMessage } from '../dist/cli-errors.js';
import { ciOutputLines, classifyRestoreExit, detectPackageManagerPlan } from '../dist/ci.js';
import { applySpecRefOverlay, CiSpecRefError, shouldApplySpecRefOverlay } from '../dist/ci-spec-ref.js';
import {
  CiProcessExit,
  CiWorktreeError,
  CiWorktreeSession,
  assertResolvableCommit,
  consumerRelativeFromRepoRoot,
  ensureConsumerAtHead,
  gitRepoRoot,
  worktreeRunCwd,
} from '../dist/ci-worktree.js';

const HELP = `styleproof-ci — restore or capture the base/head maps for a PR, cache-first

usage: styleproof-ci --base <sha> --head <sha> [options]

Restores both exact-SHA bundles from the styleproof-maps branch into
<base-dir>/base and <base-dir>/head. On a head-only miss it captures just the
head (replaying the base's recorded data when HAR files are present). On a base
miss it rebuilds the pair without checking the consumer tree out to the base:
temporary base worktree → its own dependency install → the head's exact
StyleProof release → capture+publish base → consumer head capture+publish.

Restore probes and cold base install/capture run in detached ephemeral git
worktrees so the consumer checkout is never checked out to --base. Head capture
may run in the consumer tree at --head.

If the base capture itself fails, the command records a bare baseline and still
captures the head. That degraded, head-only result is explicit in
base-capture-failed=true; a failed head capture still fails the command.

options:
  --base <sha>        base commit (e.g. github.event.pull_request.base.sha)
  --head <sha>        head commit (e.g. github.event.pull_request.head.sha)
  --spec <path>       StyleProof spec (default: e2e/styleproof.spec.ts)
  --spec-ref <ref>    When a cold base capture runs and the base commit already has
                      that spec, source the spec bytes from <ref>:<spec> for the base
                      render only (app + lockfile stay at --base). Omitted keeps 4.5.0
                      behavior. Invalid refs or a missing spec at the ref fail loudly.
  --base-dir <path>   map root; base/head land under it
                      (default: $RUNNER_TEMP/styleproof-maps, else .styleproof/ci-maps)
  --force             run outside CI (the flow may force-checkout --head in the consumer
                      tree and uses ephemeral worktrees for --base — uncommitted changes
                      can still be lost on the head checkout)
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
let specRef = '';
let specRefProvided = false;
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
  else if (a === '--spec-ref') {
    specRefProvided = true;
    specRef = argv[++i];
  } else if (a.startsWith('--spec-ref=')) {
    specRefProvided = true;
    specRef = a.slice(11);
  } else if (a === '--base-dir') baseDir = argv[++i];
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
if (specRefProvided && (typeof specRef !== 'string' || !specRef.trim())) {
  console.error('styleproof-ci: --spec-ref requires a non-empty git ref');
  process.exit(2);
}
if (!process.env.CI && !force) {
  console.error(
    'styleproof-ci: refusing to run outside CI — the flow may run `git checkout --force` on --head and\\n' +
      'uses ephemeral worktrees for --base. Pass --force if you really mean it.',
  );
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const MAP = path.join(here, 'styleproof-map.mjs');
// The head's exact release to pin the cold base rebuild to: this very package.
const OWN_VERSION = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;
const root = path.resolve(baseDir);
const consumerCwd = process.cwd();
let repoRoot;
let consumerRel;
let worktrees;
try {
  repoRoot = gitRepoRoot(consumerCwd);
  consumerRel = consumerRelativeFromRepoRoot(repoRoot, consumerCwd);
  assertResolvableCommit(base, repoRoot);
  assertResolvableCommit(head, repoRoot);
  ensureConsumerAtHead(repoRoot, head);
  worktrees = new CiWorktreeSession(repoRoot);
} catch (error) {
  exitWorktreeError(error);
}

// Children spawn the `playwright` binary by name; make sure the consumer's
// node_modules/.bin is on PATH even when this command was invoked bare.
const binDirs = [path.join(consumerCwd, 'node_modules', '.bin'), path.resolve(here, '..', '..', '.bin')];
const env = { ...process.env, PATH: `${binDirs.join(path.delimiter)}${path.delimiter}${process.env.PATH ?? ''}` };

function log(message) {
  console.error(`styleproof-ci: ${message}`);
}

function bail(code) {
  throw new CiProcessExit(code);
}

function exitSpecRefError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof CiSpecRefError ? error.exitCode : 1;
  console.error(message);
  bail(code);
}

function exitWorktreeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof CiWorktreeError ? error.exitCode : 1;
  console.error(message);
  process.exit(code);
}

/** Run a command with inherited stdio; throw on failure so finally hooks still run. */
function runOrDie(command, what, options = {}) {
  const { cwd = consumerCwd, extraEnv = {} } = options;
  const r = spawnSync(command[0], command.slice(1), { stdio: 'inherit', cwd, env: { ...env, ...extraEnv } });
  if (r.error) {
    console.error(`styleproof-ci: could not run ${command[0]} (${what})\n${r.error.message}`);
    bail(1);
  }
  if ((r.status ?? 1) !== 0) {
    console.error(`styleproof-ci: ${what} failed (exit ${r.status})`);
    bail(r.status ?? 1);
  }
}

function restore(sha, dir, cwd) {
  const r = spawnSync(
    process.execPath,
    [MAP, '--restore', '--sha', sha, '--dir', dir, '--base-dir', root, '--spec', spec],
    { stdio: 'inherit', cwd, env },
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
    bail(r.status ?? 5);
  }
  return outcome === 'hit';
}

function playwrightInstall(cwd = consumerCwd) {
  const command = process.platform === 'win32' ? 'playwright.cmd' : 'playwright';
  runOrDie([command, 'install', '--with-deps', 'chromium'], 'playwright install', { cwd });
}

function capture(args, cwd, extraEnv = {}) {
  const r = spawnSync(process.execPath, [MAP, ...args], { stdio: 'inherit', cwd, env: { ...env, ...extraEnv } });
  if (r.error) {
    console.error(`styleproof-ci: could not run styleproof-map capture\n${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
}

function captureOrDie(args, cwd, extraEnv = {}) {
  const status = capture(args, cwd, extraEnv);
  if (status !== 0) bail(status);
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
function tracked(file, cwd) {
  return spawnSync('git', ['ls-files', '--error-unmatch', file], { stdio: 'ignore', cwd, env }).status === 0;
}

function writeOutputs(baseCaptureFailed = false) {
  const outputs = ciOutputLines(baseHit, headHit, baseCaptureFailed);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${outputs.join('\n')}\n`);
  log(outputs.join(' '));
}

let baseHit;
let headHit;
let exitCode = 0;

try {
  // --- Restore both sides from detached worktrees so the consumer never visits --base.
  fs.rmSync(root, { recursive: true, force: true });
  const baseWorktree = worktrees.addDetached(base, 'probe-base');
  const baseRunCwd = worktreeRunCwd(baseWorktree, consumerRel);
  baseHit = restore(base, 'base', baseRunCwd);

  const headWorktree = worktrees.addDetached(head, 'probe-head');
  const headRunCwd = worktreeRunCwd(headWorktree, consumerRel);
  headHit = restore(head, 'head', headRunCwd);

  if (baseHit && headHit) {
    writeOutputs();
    log('both maps restored — no capture needed');
  } else {
    let baseCaptureFailed = false;
    if (!baseHit) {
      // Without a compatible base bundle, rebuild and publish the pair in one pinned
      // environment. This is the expensive cold path — entirely inside the base worktree.
      fs.rmSync(root, { recursive: true, force: true });
      const coldBaseWorktree = worktrees.addDetached(base, 'cold-base');
      const coldBaseCwd = worktreeRunCwd(coldBaseWorktree, consumerRel);
      const basePm = detectPackageManagerPlan(coldBaseCwd);
      log(`base miss — rebuilding the pair cold (${basePm.name})`);
      runOrDie(basePm.install, `${basePm.name} install at base`, { cwd: coldBaseCwd });
      // The base may depend on an older StyleProof. Install the head's exact release,
      // then restore the tracked metadata that temporary install dirtied: node_modules
      // must keep the exact release while the capture tree stays clean.
      runOrDie(basePm.installExactStyleProof(OWN_VERSION), `install styleproof@${OWN_VERSION}`, { cwd: coldBaseCwd });
      for (const file of basePm.packageMetadataFiles) {
        if (tracked(file, coldBaseCwd))
          runOrDie(['git', 'checkout', '--', file], `restore ${file}`, { cwd: coldBaseCwd });
      }
      playwrightInstall(coldBaseCwd);
      const specPath = path.join(coldBaseCwd, spec);
      if (fs.existsSync(specPath)) {
        let overlay;
        if (shouldApplySpecRefOverlay(true, specRef)) {
          try {
            overlay = applySpecRefOverlay({ spec, specRef, cwd: coldBaseCwd });
            log(`overlaying ${spec} from ${specRef} for base capture`);
          } catch (error) {
            exitSpecRefError(error);
          }
        }
        let baseStatus;
        try {
          baseStatus = capture(
            ['--spec', spec, '--dir', 'base', '--base-dir', root, '--keep-har', '--sha', base, '--upload'],
            coldBaseCwd,
          );
        } finally {
          if (overlay) {
            try {
              overlay.restore();
            } catch (error) {
              exitSpecRefError(error);
            }
          }
        }
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
      ensureConsumerAtHead(repoRoot, head);
      const headPm = detectPackageManagerPlan(consumerCwd);
      runOrDie(headPm.install, `${headPm.name} install at head`, { cwd: consumerCwd });
      playwrightInstall(consumerCwd);
    } else {
      // A compatible base hit proves the current head environment. Keep that restored
      // base and capture only the missing head in the consumer checkout.
      log('head miss — capturing only the head');
      fs.rmSync(path.join(root, 'head'), { recursive: true, force: true });
      ensureConsumerAtHead(repoRoot, head);
      playwrightInstall(consumerCwd);
    }

    const replay = hasHarFiles(path.join(root, 'base')) ? { STYLEPROOF_REPLAY_FROM: path.join(root, 'base') } : {};
    captureOrDie(['--spec', spec, '--dir', 'head', '--base-dir', root, '--sha', head, '--upload'], consumerCwd, replay);
    writeOutputs(baseCaptureFailed);
  }
} catch (error) {
  if (error instanceof CiProcessExit) exitCode = error.exitCode;
  else if (error instanceof CiWorktreeError) {
    console.error(error.message);
    exitCode = error.exitCode;
  } else throw error;
} finally {
  worktrees.dispose();
}
process.exit(exitCode);
