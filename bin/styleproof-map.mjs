#!/usr/bin/env node
// Capture this branch's computed-style map by running Playwright against the
// StyleProof spec (or restore a published map by SHA), stamp the manifest, and
// optionally publish the bundle to the map store branch.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { missingSpecMessage, nonLinuxUploadWarning, playwrightMissingMessage } from '../dist/cli-errors.js';
import {
  DEFAULT_STYLEPROOF_SPEC,
  loadStyleProofConfigWithLocationAsync,
  resolveStyleProofConfigPath,
} from '../dist/config.js';
import {
  DEFAULT_MAP_DIR,
  DEFAULT_MAP_LABEL,
  DEFAULT_MAP_STORE_BRANCH,
  DEFAULT_REMOTE,
  DETERMINISM_RECEIPT,
  MapStoreError,
  MapStoreNotFoundError,
  MapStorePreconditionError,
  clearCaptureOutput,
  currentGitSha,
  expectedCompatibilityKey,
  isMapFile,
  publishMapBundle,
  readFatalCaptureFailure,
  readSurfaceCaptureFailures,
  restoreMapBundle,
  workingTreeDirty,
  writeMapManifest,
} from '../dist/map-store.js';
import { CAPTURE_TEST_GREP } from '../dist/runner.js';
import { assessDeterminismOracle, determinismRunReceipt } from '../dist/determinism-oracle.js';
import { COVERAGE_LEDGER } from '../dist/coverage.js';
import { loadStyleMap } from '../dist/capture.js';
import { defineCli, errorMessage, fail, runBin } from './cli.mjs';

const NAME = 'styleproof-map';
const STYLEPROOF_PLAYWRIGHT_CONFIG = 'playwright.styleproof.config.ts';
const DETERMINISM_ORACLE_RUNS = 5;
const env = process.env;

const cli = defineCli({
  name: NAME,
  alias: 'capture',
  usage: [`${NAME} [options] [-- <playwright args>]`],
  positionals: true,
  flags: {
    spec: { value: 'path', help: 'StyleProof spec that must exist (default: e2e/styleproof.spec.ts)' },
    dir: { value: 'label', help: 'output label under --base-dir', default: env.STYLEMAP_DIR ?? DEFAULT_MAP_LABEL },
    'base-dir': { value: 'path', help: 'output root directory', default: env.STYLEPROOF_BASEDIR ?? DEFAULT_MAP_DIR },
    screenshots: {
      help: 'keep screenshots for reports (--no-screenshots writes lean .json.gz maps only)',
      negate: true,
      default: env.STYLEPROOF_SCREENSHOTS !== '0',
    },
    'keep-har': {
      help: 'keep recorded HAR files for advanced replay workflows',
      default: env.STYLEPROOF_KEEP_HAR === '1',
    },
    sha: {
      value: 'commit',
      help: 'commit SHA this map belongs to (default: current HEAD)',
      default: env.STYLEPROOF_SHA,
    },
    upload: {
      help: 'require upload to the map store branch after capture (--no-upload: capture locally only; default: auto — upload outside CI)',
      negate: true,
    },
    restore: { help: 'restore a map from the map store instead of capturing' },
    'crawl-base-url': { value: 'url', help: 'run styleproof-variants before capture against this app URL' },
    'crawl-route': { value: 'r', help: 'route path or key=path for the pre-map variant crawl.', repeat: true },
    'crawl-out': { value: 'file', help: 'variant crawl manifest (default: styleproof.variants.generated.json)' },
    'crawl-max-actions': { value: 'n', help: 'max attempted variant actions per route (default: 40)' },
    'crawl-width': { value: 'px', help: 'pre-map crawl viewport width (default: 1280)' },
    'crawl-height': { value: 'px', help: 'pre-map crawl viewport height (default: 800)' },
    'crawl-strict': { help: 'fail if live-state fixtures or skipped candidates remain' },
    'cache-branch': { value: 'b', help: 'map store branch (default: styleproof-maps)' },
    remote: { value: 'name', help: 'git remote for the map store (default: origin)' },
    'dirty-allow': {
      value: 'path',
      help: 'tracked file or directory whose changes never mark the capture dirty; also via STYLEPROOF_DIRTY_ALLOW (comma-separated).',
      repeat: true,
    },
    'prove-determinism': {
      help: `run the capture 5x in fresh contexts and require every canonical map hash to match; records determinism: oracle-proven and writes ${DETERMINISM_RECEIPT}`,
    },
    'tolerate-surface-failures': {
      help: 'baseline-only (never on head): record per-surface capture failures and continue when at least one map succeeds (self-check failures still fail)',
    },
  },
  notes: [
    'A styleproof.config.json at the repo root supplies project defaults — "spec", "dirtyAllow",',
    '"cacheBranch", "remote" — with flags and env overriding it, except "dirtyAllow", which',
    'ACCUMULATES across config, STYLEPROOF_DIRTY_ALLOW, and every --dirty-allow flag.',
    '',
    `If ${STYLEPROOF_PLAYWRIGHT_CONFIG} exists it is passed to Playwright by default; override with`,
    `${NAME} -- --config playwright.config.ts. STYLEPROOF_CRAWL_BASE_URL and STYLEPROOF_CRAWL_ROUTES`,
    '(comma-separated) run the same pre-map crawl from automation.',
  ],
});

const { opts, args, passthrough: playwrightArgs } = cli.parse();
let loadedConfig;
try {
  loadedConfig = await loadStyleProofConfigWithLocationAsync();
} catch (error) {
  fail(NAME, errorMessage(error));
}
const projectConfig = loadedConfig.config;
const csv = (value) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const configNumber = (value) => (value != null ? String(value) : '');

const specFromFlag = opts.spec !== undefined || args.length > 0;
let spec = opts.spec ?? args[0] ?? projectConfig.spec ?? DEFAULT_STYLEPROOF_SPEC;
const dir = opts.dir;
const baseDir = opts['base-dir'];
const screenshots = opts.screenshots ? '1' : '0';
const keepHar = Boolean(opts['keep-har']);
let sha = opts.sha ?? '';
const cacheBranch =
  opts['cache-branch'] ?? env.STYLEPROOF_CACHE_BRANCH ?? projectConfig.cacheBranch ?? DEFAULT_MAP_STORE_BRANCH;
const remote = opts.remote ?? env.STYLEPROOF_REMOTE ?? projectConfig.remote ?? DEFAULT_REMOTE;
const uploadMode =
  opts.upload === true
    ? 'required'
    : opts.upload === false
      ? 'off'
      : env.STYLEPROOF_UPLOAD === '1'
        ? 'required'
        : env.STYLEPROOF_UPLOAD === '0'
          ? 'off'
          : 'auto';
const crawl = {
  baseUrl: opts['crawl-base-url'] ?? env.STYLEPROOF_CRAWL_BASE_URL ?? projectConfig.crawl?.baseUrl ?? '',
  routes: [...(projectConfig.crawl?.routes ?? []), ...csv(env.STYLEPROOF_CRAWL_ROUTES), ...opts['crawl-route']],
  out:
    opts['crawl-out'] ??
    env.STYLEPROOF_CRAWL_OUT ??
    (projectConfig.crawl?.out
      ? resolveStyleProofConfigPath(projectConfig.crawl.out, loadedConfig.configDir)
      : 'styleproof.variants.generated.json'),
  maxActions:
    opts['crawl-max-actions'] ?? env.STYLEPROOF_CRAWL_MAX_ACTIONS ?? configNumber(projectConfig.crawl?.maxActions),
  width: opts['crawl-width'] ?? env.STYLEPROOF_CRAWL_WIDTH ?? configNumber(projectConfig.crawl?.width),
  height: opts['crawl-height'] ?? env.STYLEPROOF_CRAWL_HEIGHT ?? configNumber(projectConfig.crawl?.height),
  strict: Boolean(opts['crawl-strict']) || env.STYLEPROOF_CRAWL_STRICT === '1' || projectConfig.crawl?.strict === true,
};
const tolerateSurfaceFailures =
  Boolean(opts['tolerate-surface-failures']) || ['1', 'true'].includes(env.STYLEPROOF_TOLERATE_SURFACE_FAILURES ?? '');
// Allow paths accumulate across layers: they are all "files my tooling rewrites".
const dirtyAllow = [...(projectConfig.dirtyAllow ?? []), ...csv(env.STYLEPROOF_DIRTY_ALLOW), ...opts['dirty-allow']];

if (!spec) fail(NAME, '--spec requires a path');
if (!dir) fail(NAME, '--dir requires a label');
if (!baseDir) fail(NAME, '--base-dir requires a path');
if (sha && !/^(?:[0-9a-f]{40}|uncommitted)$/.test(sha))
  fail(NAME, '--sha must be a full lowercase 40-hex commit SHA or uncommitted');
spec = specFromFlag ? path.resolve(process.cwd(), spec) : resolveStyleProofConfigPath(spec, loadedConfig.configDir);
if (!fs.existsSync(spec)) {
  console.error(
    missingSpecMessage(
      spec,
      loadedConfig.searched,
      loadedConfig.configFile ? path.join(loadedConfig.configDir, loadedConfig.configFile) : undefined,
      specFromFlag ? undefined : (projectConfig.spec ?? DEFAULT_STYLEPROOF_SPEC),
    ),
  );
  process.exit(2);
}
// Auth setup / boundary exclusions belong to styleproof-capture; the spec-driven map path
// ignores them, so their presence in config or env is a mistake we refuse rather than hide.
const configuredAuth =
  env.STYLEPROOF_CRAWL_SETUP ||
  env.STYLEPROOF_SETUP ||
  projectConfig.crawl?.setup ||
  env.STYLEPROOF_CRAWL_AUTH_BOUNDARY_EXCLUDE ||
  env.STYLEPROOF_AUTH_BOUNDARY_EXCLUDE ||
  projectConfig.crawl?.authBoundaryExclude;
if (configuredAuth) {
  fail(
    NAME,
    'crawl.setup / crawl.authBoundaryExclude (or STYLEPROOF_SETUP / STYLEPROOF_AUTH_BOUNDARY_EXCLUDE)\n' +
      '  are configured, but the spec-driven map path does not run auth setup or boundary exclusions.\n' +
      '  Those apply only to styleproof-capture. Remove them from the map invocation/config for this CLI,\n' +
      '  or use: styleproof-capture <url> --crawl (config crawl.setup / crawl.authBoundaryExclude are honored there).',
  );
}
const crawlEnabled = Boolean(crawl.baseUrl || crawl.routes.length);
if (crawlEnabled && !crawl.baseUrl) fail(NAME, '--crawl-base-url is required when --crawl-route is set');
if (crawlEnabled && !crawl.routes.length)
  fail(NAME, 'at least one --crawl-route is required when --crawl-base-url is set');
if (opts.restore && !sha) {
  try {
    sha = currentGitSha(process.cwd());
  } catch (error) {
    fail(NAME, errorMessage(error));
  }
}

const removeTree = (target) => fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

function removeHarFiles(root) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) removeHarFiles(full);
    else if (entry.isFile() && entry.name.endsWith('.har')) fs.rmSync(full, { force: true });
  }
}

/** Precedence: explicit config key > env var > default (suppressed). */
function suppressPlatformWarning() {
  if (projectConfig.suppressPlatformWarning !== undefined) return projectConfig.suppressPlatformWarning;
  return env.STYLEPROOF_SUPPRESS_PLATFORM_WARNING !== '0';
}

async function upload(dirPath) {
  if (uploadMode === 'off' || (uploadMode === 'auto' && env.CI)) return;
  const warning = nonLinuxUploadWarning(process.platform, suppressPlatformWarning());
  if (warning) console.error(warning);
  try {
    const res = await publishMapBundle({ dir: dirPath, branch: cacheBranch, remote });
    console.error(`${NAME}: uploaded ${res.sha.slice(0, 12)} (${res.compatibilityKey}) to ${res.branch}`);
  } catch (error) {
    const message = errorMessage(error);
    // A precondition the user must fix (dirty tree, missing manifest) keeps the usage
    // code 2; everything else is the retryable map-store/network class (5).
    if (uploadMode === 'required')
      fail(NAME, `upload failed\n${message}`, error instanceof MapStorePreconditionError ? 2 : 5);
    console.error(
      `${NAME}: map captured locally; upload skipped${error instanceof MapStoreError ? ` (${message})` : ''}`,
    );
  }
}

function runVariantCrawl(captureEnvironment) {
  if (!crawlEnabled) return;
  console.error(`${NAME}: crawling UI variants before capture`);
  const crawlArgs = [
    '--base-url',
    crawl.baseUrl,
    '--out',
    crawl.out,
    ...crawl.routes.flatMap((route) => ['--route', route]),
  ];
  if (crawl.maxActions) crawlArgs.push('--max-actions', crawl.maxActions);
  if (crawl.width) crawlArgs.push('--width', crawl.width);
  if (crawl.height) crawlArgs.push('--height', crawl.height);
  if (crawl.strict) crawlArgs.push('--strict');
  const command = process.platform === 'win32' ? 'styleproof-variants.cmd' : 'styleproof-variants';
  let result = spawnSync(command, crawlArgs, { stdio: 'inherit', env: captureEnvironment });
  if (result.error?.code === 'ENOENT') result = runBin('styleproof-variants', crawlArgs, { env: captureEnvironment });
  if (result.error) fail(NAME, `could not run styleproof-variants\n${result.error.message}`);
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

// An absolute --dir is respected as-is; a relative one nests under baseDir.
const targetDir = path.isAbsolute(dir) ? dir : path.join(baseDir, dir);

if (opts.restore) {
  try {
    const manifest = restoreMapBundle({
      sha,
      outDir: targetDir,
      branch: cacheBranch,
      remote,
      compatibilityKey: expectedCompatibilityKey({ spec }),
    });
    console.log(`${NAME}: restored ${manifest.sha.slice(0, 12)} (${manifest.compatibilityKey}) to ${targetDir}`);
    process.exit(0);
  } catch (error) {
    // 4 = bundle absent (expected miss → recapture); 5 = infrastructure fault after retries.
    const notFound = error instanceof MapStoreNotFoundError;
    console.error(
      [
        notFound
          ? `${NAME}: no cached map for ${sha} on ${cacheBranch} (cache miss)`
          : `${NAME}: could not reach the map store to restore ${sha} from ${cacheBranch}`,
        errorMessage(error),
        notFound
          ? `Next: run ${NAME} at that commit to build/upload the map, or let CI recapture both sides.`
          : 'Next: retry — this is a transient map-store/network fault, not a missing bundle.',
      ].join('\n'),
    );
    process.exit(notFound ? 4 : 5);
  }
}

// Sample the tree state the capture is ABOUT to render so the manifest binds the map
// to it: if the source is edited or HEAD moves mid-capture, the map must not be
// published clean for a SHA it never rendered.
let dirtyBeforeCapture = false;
let headBeforeCapture;
try {
  dirtyBeforeCapture = workingTreeDirty(process.cwd(), dirtyAllow);
  headBeforeCapture = currentGitSha(process.cwd());
} catch {
  // git unreadable — the manifest falls back to `uncommitted`
}

// Clear the reserved generated namespace so a smaller capture set cannot leave prior
// maps looking current. Restore mode never reaches here.
try {
  clearCaptureOutput(targetDir);
} catch (error) {
  fail(NAME, `cannot reuse capture directory ${targetDir}\n${errorMessage(error)}`);
}

const playwright = process.platform === 'win32' ? 'playwright.cmd' : 'playwright';
const hasConfigArg = playwrightArgs.some((arg) => arg === '--config' || arg === '-c' || arg.startsWith('--config='));
const configArgs =
  fs.existsSync(STYLEPROOF_PLAYWRIGHT_CONFIG) && !hasConfigArg ? ['--config', STYLEPROOF_PLAYWRIGHT_CONFIG] : [];
// The spec process clock is frozen alongside the browser clock so module-level
// `new Date()` fixtures are identical across base and head captures.
const captureEnv = (label) => ({
  ...env,
  STYLEMAP_DIR: label,
  STYLEPROOF_BASEDIR: baseDir,
  STYLEPROOF_SCREENSHOTS: screenshots,
  STYLEPROOF_FREEZE_SPEC_CLOCK: env.STYLEPROOF_FREEZE_SPEC_CLOCK ?? '1',
  ...(tolerateSurfaceFailures ? { STYLEPROOF_TOLERATE_SURFACE_FAILURES: '1' } : {}),
});
const runCapture = (label) =>
  spawnSync(playwright, ['test', '--grep', CAPTURE_TEST_GREP, ...configArgs, ...playwrightArgs], {
    stdio: 'inherit',
    env: captureEnv(label),
  });

runVariantCrawl(captureEnv(dir));
const result = runCapture(dir);
if (result.error) fail(NAME, playwrightMissingMessage(result.error.message).replace(`${NAME}: `, ''));
let status = result.status ?? 1;
const captured = fs.existsSync(targetDir) ? fs.readdirSync(targetDir).filter(isMapFile).length : 0;
const toleratedFailures = readSurfaceCaptureFailures(targetDir);
const fatalCaptureFailure = readFatalCaptureFailure(targetDir);
if (status !== 0 && fatalCaptureFailure) {
  console.error(
    `${NAME}: fatal self-check failure; discarding ${captured} captured surface map(s) and refusing publication — ${fatalCaptureFailure}`,
  );
  removeTree(targetDir);
  process.exit(status);
}
// Promote to a publishable partial baseline ONLY when the failures are ledgered:
// an unrecorded failure class (self-check/nondeterminism) is never tolerable.
if (status !== 0 && tolerateSurfaceFailures && captured > 0) {
  if (toleratedFailures.length > 0) {
    console.error(
      `${NAME}: Playwright exited ${status} but ${captured} surface map(s) were captured — publishing partial baseline (${toleratedFailures.length} tolerated failure(s))`,
    );
    status = 0;
  } else {
    console.error(
      `${NAME}: Playwright exited ${status} with ${captured} surface map(s) but NO ledgered surface failure — an unrecorded failure class (e.g. a self-check/nondeterminism failure) is not tolerable; failing the capture.`,
    );
  }
}
if (status !== 0) process.exit(status);
if (!keepHar) removeHarFiles(targetDir);
// Zero maps must not stamp a manifest: a bare dir means "no baseline yet" (first adoption).
if (captured === 0) {
  console.error(
    `${NAME}: 0 surfaces captured — no manifest written; if this is the base side of a first adoption, the diff will treat it as no-baseline`,
  );
  process.exit(0);
}
if (opts['prove-determinism']) proveDeterminismOrDie();
stampManifest();
await upload(targetDir);
process.exit(0);

/** Capture runs 2..N into fresh dirs; returns the first non-zero exit, else 0. */
function runOracleCaptures(extraRunDirs) {
  for (let run = 2; run <= DETERMINISM_ORACLE_RUNS; run += 1) {
    const label = `${dir}.oracle-run-${run}`;
    const runDir = path.isAbsolute(label) ? label : path.join(baseDir, label);
    clearCaptureOutput(runDir);
    extraRunDirs.push(runDir);
    console.error(`${NAME}: determinism oracle run ${run}/${DETERMINISM_ORACLE_RUNS}`);
    const result = runCapture(label);
    if (result.error) {
      console.error(playwrightMissingMessage(result.error.message));
      return 2;
    }
    if ((result.status ?? 1) !== 0) {
      console.error(
        `${NAME}: determinism oracle run ${run}/${DETERMINISM_ORACLE_RUNS} failed (exit ${result.status ?? 1})`,
      );
      return result.status ?? 1;
    }
  }
  return 0;
}

function oracleReceipt(runDir) {
  return determinismRunReceipt(
    fs
      .readdirSync(runDir)
      .filter(isMapFile)
      .map((file) => [file.replace(/\.json(\.gz)?$/, ''), loadStyleMap(path.join(runDir, file))]),
  );
}

/** Compare every run's receipt; on success stamp the receipt + ledger. Returns the exit code. */
function recordOracleVerdict(runDirs) {
  const verdict = assessDeterminismOracle(runDirs.map(oracleReceipt));
  if (verdict.status !== 'deterministic') {
    console.error(
      `${NAME}: determinism oracle FAILED (${verdict.reason}) — ${verdict.matchingRuns}/${verdict.requiredRuns} runs matched:`,
    );
    for (const diagnostic of verdict.diagnostics) console.error(`  ${diagnostic}`);
    return 1;
  }
  fs.writeFileSync(
    path.join(targetDir, DETERMINISM_RECEIPT),
    `${JSON.stringify({ schemaVersion: 1, producer: NAME, verdict }, null, 2)}\n`,
  );
  const ledgerPath = path.join(targetDir, COVERAGE_LEDGER);
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  fs.writeFileSync(ledgerPath, `${JSON.stringify({ ...ledger, determinism: 'oracle-proven' }, null, 2)}\n`);
  console.error(
    `${NAME}: determinism oracle PASSED — ${verdict.observedRuns}/${verdict.requiredRuns} runs identical across ${verdict.stateKeys.length} surface map(s)`,
  );
  return 0;
}

/** The five-run oracle: four more captures in fresh contexts must hash identically to the
 *  first, or the bundle is discarded — a flake must never become a baseline. */
function proveDeterminismOrDie() {
  const extraRunDirs = [];
  let oracleExit;
  try {
    oracleExit = runOracleCaptures(extraRunDirs) || recordOracleVerdict([targetDir, ...extraRunDirs]);
  } catch (error) {
    console.error(`${NAME}: determinism oracle errored\n${errorMessage(error)}`);
    oracleExit = 2;
  } finally {
    for (const runDir of extraRunDirs) removeTree(runDir);
  }
  if (oracleExit !== 0) {
    console.error(`${NAME}: discarding the capture — an unproven bundle must never become a baseline`);
    removeTree(targetDir);
    process.exit(oracleExit);
  }
}

/** Bind the map to the commit it started rendering; a tree edited or a HEAD moved
 *  mid-capture marks the manifest dirty so publish refuses to push a stale map. */
function stampManifest() {
  const manifestSha = sha || headBeforeCapture || 'uncommitted';
  let dirty = manifestSha === 'uncommitted' ? true : dirtyBeforeCapture;
  try {
    const rel = path.relative(process.cwd(), targetDir) || targetDir;
    const headAfter = currentGitSha(process.cwd(), captureEnv(dir));
    if (workingTreeDirty(process.cwd(), [...dirtyAllow, rel]) || (headBeforeCapture && headAfter !== headBeforeCapture))
      dirty = true;
  } catch {
    // git unreadable now — keep the pre-capture verdict rather than guess
  }
  try {
    const manifest = writeMapManifest({
      dir: targetDir,
      spec,
      sha: manifestSha,
      screenshots: screenshots !== '0',
      dirty,
      dirtyAllow,
      env: captureEnv(dir),
    });
    console.error(`${NAME}: wrote ${targetDir} for ${manifest.sha.slice(0, 12)} (${manifest.compatibilityKey})`);
  } catch (error) {
    fail(NAME, `could not write map manifest\n${errorMessage(error)}`);
  }
}
