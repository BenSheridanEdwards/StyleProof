#!/usr/bin/env node
// Cache-first CI map orchestration: restore base+head from the map store; on a
// miss, capture in this pinned environment (cold base rebuild under the head's
// exact StyleProof release, HAR replay for the head); publish every fallback
// capture for reuse.
//
// DESTRUCTIVE on the consumer HEAD only: it may `git checkout --force` --head so
// the PR checkout stays pinned, but never checks the consumer out to --base.
// Restore probes and the cold base run in detached ephemeral worktrees.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  browsersRequiredByCaptureConfig,
  evaluateBrowserPreflight,
  playwrightInstallRemedyCommand,
  readCapturePlaywrightConfigText,
  resolveBrowserExecutablePath,
} from '../dist/browser-preflight.js';
import { loadStyleProofConfigAsync, loadStyleProofConfigWithLocationAsync } from '../dist/config.js';
import { ciOutputLines, detectPackageManagerPlan } from '../dist/ci.js';
import { applySpecRefOverlay, CiSpecRefError, resolveSpecRefToSha } from '../dist/ci-spec-ref.js';
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
import {
  expectedCompatibilityKey,
  listMapStoreBundleShas,
  readMapManifest,
  restoreMapBundle,
  writeBaselineProvenance,
} from '../dist/map-store.js';
import { planAncestorBaselineReuse } from '../dist/ancestor-baseline.js';
import { classifyAncestorCaptureColdReason, formatMapRestoreDecisionLine } from '../dist/map-hit-observability.js';
import { captureKeysIn } from '../dist/capture.js';
import {
  decideSelectiveRemap,
  formatSelectiveRemapPlan,
  resolveSelectiveRemapOptIn,
  selectiveCaptureEnv,
  surfaceKeysInMapDir,
  tryComputeAffectedVerdict,
} from '../dist/selective-remap.js';
import { harnessMissingAtRef } from './spec-path-env.mjs';
import { binDir, childEnv, defineCli, emitOutputs, errorMessage, fail } from './cli.mjs';
import { ExitError, captureMap, checkoutSpec, dirtyAllowArgs, restoreMap } from './ci-shared.mjs';

const NAME = 'styleproof-ci';
const cli = defineCli({
  name: NAME,
  alias: 'ci',
  usage: [`${NAME} --base <sha> --head <sha> [options]`],
  summary: [
    'Restores both exact-SHA bundles from the styleproof-maps branch into <base-dir>/base',
    'and <base-dir>/head. On a head-only miss it captures just the head (replaying the',
    "base's recorded data when HAR files are present). On a base miss it rebuilds the pair",
    "in a temporary base worktree under the head's exact StyleProof release, then captures",
    'the consumer head. A failed base capture records a bare baseline (base-capture-failed=true)',
    'and still captures the head; a failed head capture fails the command.',
    '',
    'Before each capture the pinned Playwright browser build is verified and self-healed with',
    'one `playwright install`; STYLEPROOF_SKIP_BROWSER_PREFLIGHT=1 always runs the install.',
  ].join('\n'),
  flags: {
    base: { value: 'sha', help: 'base commit (e.g. github.event.pull_request.base.sha)' },
    head: { value: 'sha', help: 'head commit (e.g. github.event.pull_request.head.sha)' },
    spec: { value: 'path', help: 'StyleProof spec (default: e2e/styleproof.spec.ts)' },
    'spec-ref': {
      value: 'ref',
      help: 'source the spec and its colocated harness from <ref> for both base and head; app code and lockfiles stay pinned to --base/--head',
      allowEmpty: true,
    },
    'spec-ref-if-missing': {
      value: 'ref',
      help: 'source that harness only when the base lacks the selected spec or playwright.styleproof.config.ts (first adoption)',
      allowEmpty: true,
    },
    'base-dir': {
      value: 'path',
      help: 'map root; base/head land under it (default: $RUNNER_TEMP/styleproof-maps, else .styleproof/ci-maps)',
    },
    upload: {
      help: '--no-upload: capture without publishing to the map-store branch (required for untrusted PR jobs)',
      negate: true,
      default: true,
    },
    store: {
      help: '--no-store: no map-store branch exists — skip every restore probe and capture both sides here (implies --no-upload)',
      negate: true,
      default: true,
    },
    force: { help: 'run outside CI (the flow may force-checkout --head in the consumer tree)' },
  },
  notes: [
    'Writes base-hit / head-hit / capture-needed / base-capture-failed to $GITHUB_OUTPUT when set.',
    '',
    'Nearest-ancestor baseline reuse (enabled by default): on a base miss, reuse the nearest',
    "first-parent ancestor's bundle when no capture-relevant path changed. Config keys",
    "ancestorBaseline.enabled / ancestorBaseline.roots (default ['src']); env",
    'STYLEPROOF_ANCESTOR_BASELINE=0 disables, STYLEPROOF_ANCESTOR_BASELINE_ROOTS overrides roots.',
    'Reuse is recorded in the log, in base-restored-from-ancestor=<sha>, and in a',
    'styleproof-baseline-provenance.json sidecar.',
    '',
    'Selective remap (opt-in, Soft-pass HOLD): STYLEPROOF_SELECTIVE_REMAP=1 or',
    'affected.selectiveRemap in config. When a usable base is present and the affected',
    'verdict is scoped, head capture re-captures only affected surfaces and reuses base',
    'maps for the rest. Missing graph/surfaces/base or an unbounded verdict fails closed',
    'to a full remap (never silent under-capture). Default remains full remap.',
    '',
    'exit codes: 0 both maps present; 2 usage error; a persistent map-store fault keeps the',
    "restore CLI's code; a failed capture propagates its own code",
  ],
});

const { opts } = cli.parse();
const { base, head } = opts;
if (!base || !head) fail(NAME, '--base <sha> and --head <sha> are required');
let spec = opts.spec;
let specRef = opts['spec-ref'] ?? '';
let specRefProvided = specRef !== '';
const specRefIfMissing = opts['spec-ref-if-missing'] ?? '';
const baseDir =
  opts['base-dir'] ??
  (process.env.RUNNER_TEMP ? path.join(process.env.RUNNER_TEMP, 'styleproof-maps') : '.styleproof/ci-maps');
const noStore = !opts.store;
const noUpload = !opts.upload || noStore;

if (opts['spec-ref'] !== undefined && !specRef.trim()) fail(NAME, '--spec-ref requires a non-empty git ref');
if (opts['spec-ref-if-missing'] !== undefined && !specRefIfMissing.trim())
  fail(NAME, '--spec-ref-if-missing requires a non-empty git ref');
if (specRefProvided && specRefIfMissing) fail(NAME, '--spec-ref and --spec-ref-if-missing are mutually exclusive');
if (!process.env.CI && !opts.force) {
  fail(
    NAME,
    'refusing to run outside CI — the flow may run `git checkout --force` on --head and\\nuses ephemeral worktrees for --base. Pass --force if you really mean it.',
  );
}

const OWN_VERSION = JSON.parse(fs.readFileSync(path.join(binDir, '..', 'package.json'), 'utf8')).version;
const root = path.resolve(baseDir);
const consumerCwd = process.cwd();
const env = childEnv(consumerCwd);
const log = (message) => console.error(`${NAME}: ${message}`);
const bail = (code) => {
  throw new CiProcessExit(code);
};

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
  fail(NAME, errorMessage(error).replace(`${NAME}: `, ''), error instanceof CiWorktreeError ? error.exitCode : 1);
}
// A cancelled runner sends SIGTERM; dispose the worktrees it would otherwise leak.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    worktrees.dispose();
    process.exit(130);
  });
}

/** The spec governing one checkout: an explicit --spec everywhere, otherwise that
 *  checkout's OWN config — after a config-only spec move, each side uses its own path. */
async function specFor(cwd) {
  if (opts.spec !== undefined) return spec;
  try {
    return checkoutSpec(await loadStyleProofConfigWithLocationAsync(cwd), cwd, spec);
  } catch (error) {
    log(errorMessage(error));
    return bail(2);
  }
}

// Project config is read AFTER the checkout is pinned to --head: a head commit that
// moves the spec must govern this run.
let projectConfig;
try {
  const loadedHead = await loadStyleProofConfigWithLocationAsync(consumerCwd);
  projectConfig = loadedHead.config;
  // An explicit --spec is used everywhere, but it still has to stay inside the repository.
  spec =
    opts.spec === undefined
      ? checkoutSpec(loadedHead, consumerCwd, spec)
      : checkoutSpec({ config: {} }, consumerCwd, spec);
} catch (error) {
  if (error instanceof CiProcessExit) process.exit(error.exitCode);
  fail(NAME, errorMessage(error));
}

// For first adoption, select the harness ref only when the base lacks a generated component.
if (specRefIfMissing) {
  const existsAtBase = (file) =>
    spawnSync('git', ['cat-file', '-e', `${base}:${file}`], { cwd: repoRoot }).status === 0;
  if (harnessMissingAtRef(spec, consumerRel, existsAtBase)) {
    specRef = specRefIfMissing;
    specRefProvided = true;
  }
}

function exitSpecRefError(error) {
  console.error(errorMessage(error));
  bail(error instanceof CiSpecRefError ? error.exitCode : 1);
}

// Resolve a symbolic ref HERE: inside the detached base worktree HEAD is --base, and
// FETCH_HEAD/MERGE_HEAD do not resolve at all.
if (specRefProvided) {
  try {
    const resolved = resolveSpecRefToSha(specRef, consumerCwd);
    if (resolved !== specRef) log(`--spec-ref ${specRef} resolved to ${resolved} in the consumer checkout`);
    specRef = resolved;
  } catch (error) {
    console.error(errorMessage(error));
    process.exit(error instanceof CiSpecRefError ? error.exitCode : 1);
  }
}

/** PATH with `cwd`'s own node_modules/.bin FIRST, so base-side spawns resolve the
 *  cold-base worktree's own Playwright rather than the head's. */
const binFirstPath = (cwd) => `${path.join(cwd, 'node_modules', '.bin')}${path.delimiter}${env.PATH}`;
const playwright = process.platform === 'win32' ? 'playwright.cmd' : 'playwright';

/** Run a command with inherited stdio; throw on failure so finally hooks still run. */
function runOrDie(command, what, { cwd = consumerCwd, extraEnv = {} } = {}) {
  const r = spawnSync(command[0], command.slice(1), { stdio: 'inherit', cwd, env: { ...env, ...extraEnv } });
  if (r.error) {
    log(`could not run ${command[0]} (${what})\n${r.error.message}`);
    bail(1);
  }
  if ((r.status ?? 1) !== 0) {
    log(`${what} failed (exit ${r.status})`);
    bail(r.status ?? 1);
  }
}

/** Apply the --spec-ref overlay around `fn` when it applies in `cwd` (the spec path
 *  did not move between base and head), always restoring the checkout afterwards. */
async function withOverlay(cwd, cwdSpec, phase, fn) {
  const applies = Boolean(specRef) && cwdSpec === spec;
  if (specRef && !applies) {
    log(
      `--spec-ref: spec path moved between base (${cwdSpec}) and head (${spec}) — skipping the overlay; the base side renders its own spec`,
    );
  }
  if (!applies) return fn([]);
  let overlay;
  try {
    overlay = applySpecRefOverlay({ spec: cwdSpec, specRef, cwd });
    if (phase) log(`overlaying ${overlay.paths.length} spec-harness file(s) from ${specRef} for ${phase}`);
  } catch (error) {
    exitSpecRefError(error);
  }
  try {
    return await fn(dirtyAllowArgs(overlay.dirtyAllow));
  } finally {
    try {
      overlay.restore();
    } catch (error) {
      exitSpecRefError(error);
    }
  }
}

/** Probe the map store for `sha` under the same overlay the cold path publishes with. */
async function restore(sha, dir, cwd) {
  const probeSpec = await specFor(cwd);
  return withOverlay(cwd, probeSpec, '', () =>
    restoreMap(['--sha', sha, '--dir', dir, '--base-dir', root, '--spec', probeSpec], {
      cwd,
      env,
      dir,
      next: 'Re-run the job.',
    }),
  );
}

/** Soft-pass HOLD: emit the stable greppable line on stderr (not through the ci: prefix). */
function logMapRestoreDecision(decision) {
  console.error(formatMapRestoreDecisionLine(decision));
}

function playwrightInstall(cwd, browserNames = ['chromium']) {
  const result = spawnSync(playwright, ['install', '--with-deps', ...browserNames], {
    stdio: 'inherit',
    cwd,
    env: { ...env, PATH: binFirstPath(cwd) },
  });
  if (result.error) log(`could not run ${playwright} install — ${result.error.message}`);
  return !result.error && (result.status ?? 1) === 0;
}

function exitWithBrowserRemedy(missing, cause) {
  const revisions = missing.map((verdict) => verdict.revisionDirectory).join(', ');
  const remedy = playwrightInstallRemedyCommand(missing.map((verdict) => verdict.browserName));
  log(
    `${cause} — missing browser build(s): ${revisions}.\nNext: run \`${remedy}\` on this host (the CI runner or capture machine), then re-run.`,
  );
  bail(1);
}

/** Verify the pinned Playwright browser builds before any capture and self-heal a
 *  missing build with one install (a re-provisioned runner has an empty cache). */
function ensurePlaywrightBrowsersOrDie(cwd) {
  if (process.env.STYLEPROOF_SKIP_BROWSER_PREFLIGHT === '1') {
    if (!playwrightInstall(cwd)) bail(1);
    return;
  }
  const browserNames = browsersRequiredByCaptureConfig(readCapturePlaywrightConfigText(cwd));
  if (browserNames.includes('webkit'))
    log('browser preflight: the capture Playwright config mentions webkit — checking chromium and webkit');
  const verdicts = [];
  for (const browserName of browserNames) {
    const resolution = resolveBrowserExecutablePath(cwd, browserName);
    if (resolution.kind === 'unresolvable') {
      log(`browser preflight: cannot resolve the ${browserName} executable path (${resolution.reason})`);
      log('browser preflight skipped — running playwright install unconditionally');
      if (!playwrightInstall(cwd, browserNames)) bail(1);
      return;
    }
    verdicts.push(evaluateBrowserPreflight(browserName, resolution.executablePath));
  }
  const missing = verdicts.filter((verdict) => verdict.status === 'missing');
  for (const verdict of missing) {
    log(
      `browser preflight: ${verdict.browserName} build ${verdict.revisionDirectory} is missing at ${verdict.executablePath} — self-healing with \`playwright install\``,
    );
  }
  if (missing.length && !playwrightInstall(cwd, browserNames))
    exitWithBrowserRemedy(missing, 'playwright install failed');
  const healed = missing.map((verdict) => evaluateBrowserPreflight(verdict.browserName, verdict.executablePath));
  const stillMissing = healed.filter((verdict) => verdict.status === 'missing');
  if (stillMissing.length)
    exitWithBrowserRemedy(stillMissing, 'playwright install completed but the executable is still missing');
  for (const verdict of [...verdicts.filter((v) => v.status === 'verified'), ...healed]) {
    log(`browser preflight: verified ${verdict.browserName} ${verdict.revisionDirectory} at ${verdict.executablePath}`);
  }
}

function hasHarFiles(dir) {
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir, { withFileTypes: true }).some((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? hasHarFiles(full) : entry.name.endsWith('.har');
  });
}

const link = (target, at) => {
  fs.rmSync(at, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at, 'junction');
};

/** Install the head's exact StyleProof release beside the cold base and make every
 *  party (CLI, config, spec, runner) share ONE @playwright/test instance — Playwright
 *  forbids loading it twice in one process. */
function installExactStyleProof(pm, coldBaseCwd) {
  const exactRuntimeRoot = path.join(worktrees.scratchRoot(), 'exact-styleproof-runtime');
  runOrDie(pm.installExactStyleProof(OWN_VERSION, exactRuntimeRoot), `install styleproof@${OWN_VERSION}`, {
    cwd: coldBaseCwd,
  });
  const isolated = pm.isolatedStyleProofPackage(exactRuntimeRoot);
  if (!isolated) return;
  if (!fs.existsSync(isolated)) {
    log(`isolated StyleProof install is missing ${isolated}`);
    bail(1);
  }
  const isolatedPeer = path.join(exactRuntimeRoot, 'node_modules', '@playwright', 'test');
  const adopterPeer = path.join(coldBaseCwd, 'node_modules', '@playwright', 'test');
  const consumerPeer = path.join(consumerCwd, 'node_modules', '@playwright', 'test');
  if (fs.existsSync(adopterPeer)) link(adopterPeer, isolatedPeer);
  else if (fs.existsSync(consumerPeer)) {
    // First adoption adds StyleProof and its Playwright peer on the head only.
    link(consumerPeer, isolatedPeer);
    link(consumerPeer, adopterPeer);
  } else if (fs.existsSync(isolatedPeer)) link(isolatedPeer, adopterPeer);
  link(isolated, path.join(coldBaseCwd, 'node_modules', 'styleproof'));
}

// ── Nearest-ancestor baseline reuse (opt-out, enabled by default) ─────────────
function ancestorBaselineEnabled() {
  const override = process.env.STYLEPROOF_ANCESTOR_BASELINE;
  if (override === '0' || override === '1') return override === '1';
  return projectConfig?.ancestorBaseline?.enabled ?? true;
}

/** A sidecar write failure must never fail the run. */
function recordBaselineProvenance(provenance) {
  if (!ancestorBaselineEnabled()) return;
  try {
    writeBaselineProvenance(path.join(root, 'base'), { version: 1, requestedSha: base, ...provenance });
  } catch (error) {
    log(`could not record baseline provenance (${errorMessage(error)})`);
  }
}

/** Reuse the nearest ancestor's bundle when nothing capture-relevant changed since it.
 *  Returns `{ ancestorSha }` on reuse, or `{ ancestorSha: '', coldReason }` for the cold path.
 *  Fail-safe: errors only log. */
async function tryRestoreNearestAncestorBaseline(baseProbeCwd) {
  if (!ancestorBaselineEnabled()) return { ancestorSha: '', coldReason: 'ancestor_disabled' };
  if (specRefProvided) {
    log('ancestor baseline reuse: skipped — --spec-ref overlays the base spec, which reuse cannot prove against');
    return { ancestorSha: '', coldReason: 'ancestor_spec_ref' };
  }
  try {
    const probeSpec = await specFor(baseProbeCwd);
    const configAtBase = await loadStyleProofConfigAsync(baseProbeCwd);
    const branch = process.env.STYLEPROOF_CACHE_BRANCH ?? configAtBase.cacheBranch;
    const remote = process.env.STYLEPROOF_REMOTE ?? configAtBase.remote;
    const envRoots = (process.env.STYLEPROOF_ANCESTOR_BASELINE_ROOTS ?? '')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
    const sourceRoots = envRoots.length
      ? envRoots
      : (configAtBase?.ancestorBaseline?.roots ?? projectConfig?.ancestorBaseline?.roots ?? ['src']);
    const plan = planAncestorBaselineReuse({
      requestedSha: base,
      availableShas: listMapStoreBundleShas({ branch, remote, cwd: repoRoot }),
      spec: probeSpec,
      sourceRoots,
      cwd: repoRoot,
    });
    if (plan.decision === 'capture') {
      log(`ancestor baseline reuse: taking the full capture path — ${plan.reason}`);
      return {
        ancestorSha: '',
        coldReason: classifyAncestorCaptureColdReason(plan.reason, plan.reasonCode),
      };
    }
    // The restored manifest keeps naming the ancestor SHA it was verified at.
    restoreMapBundle({
      sha: plan.ancestorSha,
      outDir: path.join(root, 'base'),
      branch,
      remote,
      cwd: baseProbeCwd,
      compatibilityKey: expectedCompatibilityKey({ cwd: baseProbeCwd, spec: probeSpec }),
    });
    recordBaselineProvenance({
      baseline: 'ancestor-reuse',
      restoredSha: plan.ancestorSha,
      ancestorDepth: plan.ancestorDepth,
      changedPathCount: plan.changedPathCount,
      sourceRoots,
    });
    log(
      `base miss for ${base.slice(0, 12)} — reused the baseline of nearest ancestor ${plan.ancestorSha.slice(0, 12)} (depth ${plan.ancestorDepth}; ${plan.changedPathCount} changed path(s), none capture-relevant)`,
    );
    return { ancestorSha: plan.ancestorSha };
  } catch (error) {
    log(`ancestor baseline reuse: falling back to the full capture path — ${errorMessage(error)}`);
    return { ancestorSha: '', coldReason: 'ancestor_error' };
  }
}

const uploadFlag = noUpload ? '--no-upload' : '--upload';

/** Opt-in selective head remap plan. Fail-closed to full remap; never soft-green. */
function planHeadSelectiveRemap(baseMapsDir, consumerRoot, loaded) {
  const optIn = resolveSelectiveRemapOptIn(env, loaded.config.affected);
  const baseKeys = surfaceKeysInMapDir(baseMapsDir);
  const basePresent = baseKeys.size > 0;
  if (!optIn) {
    return decideSelectiveRemap({
      optIn: false,
      basePresent,
      allSurfaces: Object.keys(loaded.config.affected?.surfaces ?? {}),
      verdict: null,
    });
  }
  const attempt = tryComputeAffectedVerdict({
    root: consumerRoot,
    baseSha: base,
    headSha: head,
    affected: loaded.config.affected,
    configDir: loaded.configDir,
  });
  return decideSelectiveRemap({
    optIn: true,
    basePresent,
    allSurfaces: Object.keys(attempt.surfaces),
    verdict: attempt.verdict,
    verdictReason: attempt.reason,
    baseSurfaceKeys: baseKeys,
  });
}

/** Rebuild the base cold inside its own worktree; returns true when the capture failed. */
async function captureColdBase() {
  fs.rmSync(root, { recursive: true, force: true });
  const coldBaseCwd = worktreeRunCwd(worktrees.addDetached(base, 'cold-base'), consumerRel);
  const pm = detectPackageManagerPlan(coldBaseCwd);
  log(`base miss — rebuilding the pair cold (${pm.name})`);
  runOrDie(pm.install, `${pm.name} install at base`, { cwd: coldBaseCwd });
  installExactStyleProof(pm, coldBaseCwd);
  for (const file of pm.packageMetadataFiles) {
    const tracked =
      spawnSync('git', ['ls-files', '--error-unmatch', file], { stdio: 'ignore', cwd: coldBaseCwd, env }).status === 0;
    if (tracked) runOrDie(['git', 'checkout', '--', file], `restore ${file}`, { cwd: coldBaseCwd });
  }
  ensurePlaywrightBrowsersOrDie(coldBaseCwd);
  const baseSpec = await specFor(coldBaseCwd);
  const specPath = path.isAbsolute(baseSpec) ? baseSpec : path.join(coldBaseCwd, baseSpec);
  const baseDirPath = path.join(root, 'base');
  if (!fs.existsSync(specPath) && !(specRef && baseSpec === spec)) {
    // The base commit predates the spec (first adoption): an empty base dir means "no baseline yet".
    fs.mkdirSync(baseDirPath, { recursive: true });
    return false;
  }
  const status = await withOverlay(coldBaseCwd, baseSpec, 'base capture', (dirtyAllow) =>
    captureMap(
      NAME,
      [
        '--spec',
        baseSpec,
        '--dir',
        'base',
        '--base-dir',
        root,
        '--keep-har',
        '--sha',
        base,
        uploadFlag,
        '--tolerate-surface-failures',
        ...dirtyAllow,
      ],
      { cwd: coldBaseCwd, env: { ...env, PATH: binFirstPath(coldBaseCwd) } },
    ),
  );
  if (status === 0) {
    recordBaselineProvenance({ baseline: 'captured' });
    return false;
  }
  // Soft-pass HOLD: ledgered partials now stamp a manifest even when exit stays non-zero.
  // Keep them so Action can diff survivors as PARTIAL_BASELINE (or equivalent red).
  if (isPublishablePartial(baseDirPath)) {
    log(`base capture exited ${status} with a publishable partial — keeping survivors (Soft-pass HOLD: stay red)`);
    recordBaselineProvenance({ baseline: 'captured' });
    return false;
  }
  const mapCount = captureKeysIn(baseDirPath).length;
  if (mapCount > 0)
    log(
      `base capture exited ${status} with ${mapCount} surface map(s) on disk but no publishable manifest — discarding the debris`,
    );
  log(`base capture failed (exit ${status}) — continuing with a bare baseline`);
  fs.rmSync(baseDirPath, { recursive: true, force: true });
  fs.mkdirSync(baseDirPath, { recursive: true });
  return true;
}

let baseHit = false;
let headHit = false;
let baseRestoredFromAncestorSha = '';
let exitCode = 0;

/** Survivors stamped with a manifest are publishable (Soft-pass HOLD: may still exit non-zero). */
function isPublishablePartial(dir) {
  return captureKeysIn(dir).length > 0 && readMapManifest(dir) != null;
}

function writeOutputs(baseCaptureFailed = false) {
  const outputs = ciOutputLines(baseHit, headHit, baseCaptureFailed, baseRestoredFromAncestorSha);
  if (process.env.GITHUB_OUTPUT) emitOutputs(outputs);
  // The untrusted capture job cannot pass job outputs across workflow_run, so a durable
  // sidecar travels with the artifact into the trusted report stage.
  try {
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(
      path.join(baseDir, 'styleproof-ci-outputs.json'),
      `${JSON.stringify({ version: 1, baseCaptureFailed: Boolean(baseCaptureFailed), baseHit, headHit }, null, 2)}\n`,
    );
  } catch (error) {
    log(`could not write styleproof-ci-outputs.json: ${errorMessage(error)}`);
  }
  log(outputs.join(' '));
}

try {
  fs.rmSync(root, { recursive: true, force: true });
  if (noStore) {
    log('no map store (--no-store) — capturing base and head in this job');
    // Soft-pass HOLD: structured cold reason for consumer Visual (#734).
    logMapRestoreDecision({ side: 'base', sha: base, baseHit: 'miss', coldReason: 'no_store' });
    logMapRestoreDecision({ side: 'head', sha: head, baseHit: 'miss', coldReason: 'no_store' });
  } else {
    // Probe both sides from detached worktrees so the consumer never visits --base.
    const baseRunCwd = worktreeRunCwd(worktrees.addDetached(base, 'probe-base'), consumerRel);
    const baseRestore = await restore(base, 'base', baseRunCwd);
    baseHit = baseRestore.hit;
    if (baseHit) {
      recordBaselineProvenance({ baseline: 'exact-restore', restoredSha: base });
      logMapRestoreDecision({ side: 'base', sha: base, baseHit: 'exact', restoredSha: base });
    } else {
      const ancestor = await tryRestoreNearestAncestorBaseline(baseRunCwd);
      baseRestoredFromAncestorSha = ancestor.ancestorSha;
      baseHit = Boolean(baseRestoredFromAncestorSha);
      if (baseHit) {
        logMapRestoreDecision({
          side: 'base',
          sha: base,
          baseHit: 'ancestor',
          ancestorReuseFrom: baseRestoredFromAncestorSha,
        });
      } else {
        const skippedAncestor =
          ancestor.coldReason === 'ancestor_disabled' || ancestor.coldReason === 'ancestor_spec_ref';
        logMapRestoreDecision({
          side: 'base',
          sha: base,
          baseHit: 'miss',
          coldReason: skippedAncestor
            ? (baseRestore.coldReason ?? ancestor.coldReason)
            : (ancestor.coldReason ?? baseRestore.coldReason ?? 'no_bundle'),
        });
      }
    }
    const headRestore = await restore(
      head,
      'head',
      worktreeRunCwd(worktrees.addDetached(head, 'probe-head'), consumerRel),
    );
    headHit = headRestore.hit;
    if (headHit) {
      logMapRestoreDecision({ side: 'head', sha: head, baseHit: 'exact', restoredSha: head });
    } else {
      logMapRestoreDecision({
        side: 'head',
        sha: head,
        baseHit: 'miss',
        coldReason: headRestore.coldReason ?? 'no_bundle',
      });
    }
  }

  if (baseHit && headHit) {
    writeOutputs();
    log('both maps restored — no capture needed');
  } else {
    let baseCaptureFailed = false;
    if (!baseHit) {
      baseCaptureFailed = await captureColdBase();
      ensureConsumerAtHead(repoRoot, head);
      const headPm = detectPackageManagerPlan(consumerCwd);
      runOrDie(headPm.install, `${headPm.name} install at head`, { cwd: consumerCwd });
    } else {
      // A compatible base hit proves the head environment: capture only the missing head.
      log('head miss — capturing only the head');
      fs.rmSync(path.join(root, 'head'), { recursive: true, force: true });
      ensureConsumerAtHead(repoRoot, head);
    }
    ensurePlaywrightBrowsersOrDie(consumerCwd);
    const replay = hasHarFiles(path.join(root, 'base')) ? { STYLEPROOF_REPLAY_FROM: path.join(root, 'base') } : {};
    const loadedForSelective = await loadStyleProofConfigWithLocationAsync(consumerCwd);
    const selectivePlan = planHeadSelectiveRemap(path.join(root, 'base'), consumerCwd, loadedForSelective);
    log(formatSelectiveRemapPlan(selectivePlan));
    const selectiveEnv = selectiveCaptureEnv(selectivePlan, path.join(root, 'base'));
    const status = await withOverlay(consumerCwd, spec, 'head capture', (dirtyAllow) =>
      captureMap(
        NAME,
        ['--spec', spec, '--dir', 'head', '--base-dir', root, '--sha', head, uploadFlag, ...dirtyAllow],
        {
          cwd: consumerCwd,
          env: { ...env, ...replay, ...selectiveEnv },
        },
      ),
    );
    if (status !== 0) {
      const headDir = path.join(root, 'head');
      if (isPublishablePartial(headDir)) {
        log(`head capture exited ${status} with a publishable partial — keeping survivors (Soft-pass HOLD: stay red)`);
        writeOutputs(baseCaptureFailed);
      }
      bail(status);
    }
    writeOutputs(baseCaptureFailed);
  }
} catch (error) {
  if (error instanceof CiProcessExit) exitCode = error.exitCode;
  else if (error instanceof CiWorktreeError) {
    console.error(error.message);
    exitCode = error.exitCode;
  } else if (error instanceof ExitError) {
    log(error.message);
    exitCode = error.exitCode;
  } else throw error;
} finally {
  worktrees.dispose();
}
process.exit(exitCode);
