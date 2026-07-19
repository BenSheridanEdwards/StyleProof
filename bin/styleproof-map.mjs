#!/usr/bin/env node
/**
 * Capture the current branch's computed-style map.
 *
 * The zero-config path is the local-first cache flow scaffolded by styleproof-init:
 *   styleproof-map
 *
 * It runs Playwright against e2e/styleproof.spec.ts with:
 *   STYLEMAP_DIR=current
 *   STYLEPROOF_BASEDIR=.styleproof/maps
 *   STYLEPROOF_SCREENSHOTS=1
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isHelpArg,
  missingSpecMessage,
  nonLinuxUploadWarning,
  playwrightMissingMessage,
  projectConfigOrExit,
  showHelpAndExit,
  unknownFlagMessage,
} from '../dist/cli-errors.js';
import {
  BROWSER_BUILD_SIDECAR,
  SURFACE_CAPTURE_FAILURES_DIR,
  DEFAULT_MAP_DIR,
  DEFAULT_MAP_LABEL,
  DEFAULT_MAP_STORE_BRANCH,
  DEFAULT_REMOTE,
  MapStoreError,
  MapStorePreconditionError,
  MapStoreNotFoundError,
  currentGitSha,
  expectedCompatibilityKey,
  isMapFile,
  publishMapBundle,
  restoreMapBundle,
  readSurfaceCaptureFailures,
  workingTreeDirty,
  writeMapManifest,
} from '../dist/map-store.js';

const STYLEPROOF_PLAYWRIGHT_CONFIG = 'playwright.styleproof.config.ts';
const STYLEPROOF_VARIANTS_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'styleproof-variants.mjs');
const HELP = `styleproof-map — capture this branch's computed-style map

usage: styleproof-map [options] [-- <playwright args>]

options:
  --spec <path>       StyleProof spec that must exist (default: e2e/styleproof.spec.ts)
  --dir <label>       output label under --base-dir (default: ${DEFAULT_MAP_LABEL})
  --base-dir <path>   output root directory (default: ${DEFAULT_MAP_DIR})
  --screenshots       keep screenshots for reports (default)
  --no-screenshots    write lean .json.gz maps only
  --keep-har          keep recorded HAR files for advanced replay workflows
  --sha <commit>      commit SHA this map belongs to (default: current HEAD)
  --upload            require upload to the map store branch after capture
  --no-upload         capture locally only (default in CI)
  --restore           restore a map from the map store instead of capturing
  --crawl-base-url <url>
                      run styleproof-variants before capture against this app URL
  --crawl-route <r>   route path or key=path for the pre-map variant crawl; repeatable
  --crawl-out <file>  variant crawl manifest (default: styleproof.variants.generated.json)
  --crawl-max-actions <n>
                      max attempted variant actions per route (default: 40)
  --crawl-width <px>  pre-map crawl viewport width (default: 1280)
  --crawl-height <px> pre-map crawl viewport height (default: 800)
  --crawl-strict      fail if live-state fixtures or skipped candidates remain
  --cache-branch <b>  map store branch (default: ${DEFAULT_MAP_STORE_BRANCH})
  --remote <name>     git remote for the map store (default: ${DEFAULT_REMOTE})
  --dirty-allow <path>
                      tracked file or directory whose changes never mark the capture
                      dirty (a dev tool rewriting e.g. tsconfig.json); repeatable,
                      also via STYLEPROOF_DIRTY_ALLOW (comma-separated)
  --tolerate-surface-failures
                      baseline-only (manual cold base capture): record per-surface
                      capture failures and continue when at least one map succeeds
                      (self-check failures still fail). StyleProof CI enables this
                      only on the cold base capture — never on head.
  -h, --help          show this help

A styleproof.config.json at the repo root supplies project defaults — "spec",
"dirtyAllow", "cacheBranch", "remote" — with flags and env overriding it,
except "dirtyAllow", which ACCUMULATES: config entries, STYLEPROOF_DIRTY_ALLOW,
and every --dirty-allow flag all apply together.

If playwright.styleproof.config.ts exists, styleproof-map passes it to Playwright
by default. Override with: styleproof-map -- --config playwright.config.ts

Set STYLEPROOF_CRAWL_BASE_URL and STYLEPROOF_CRAWL_ROUTES (comma-separated) to
run the same pre-map crawl from automation.

Examples:
  styleproof-map
  styleproof-map --crawl-base-url http://localhost:3000 --crawl-route / --crawl-route settings=/settings
  styleproof-map --upload
  styleproof-map --restore --sha 0123abcd --dir head --base-dir __stylemaps__
  styleproof-map --spec e2e/styleproof.spec.ts
  styleproof-map --dir review --base-dir __stylemaps__ --keep-har --no-upload
`;

const argv = process.argv.slice(2);
const projectConfig = projectConfigOrExit('styleproof-map');
let spec = projectConfig.spec ?? 'e2e/styleproof.spec.ts';
let dir = process.env.STYLEMAP_DIR ?? DEFAULT_MAP_LABEL;
let baseDir = process.env.STYLEPROOF_BASEDIR ?? DEFAULT_MAP_DIR;
let screenshots = process.env.STYLEPROOF_SCREENSHOTS ?? '1';
let keepHar = process.env.STYLEPROOF_KEEP_HAR === '1';
let sha = process.env.STYLEPROOF_SHA ?? '';
let restore = false;
let cacheBranch = process.env.STYLEPROOF_CACHE_BRANCH ?? projectConfig.cacheBranch ?? DEFAULT_MAP_STORE_BRANCH;
let remote = process.env.STYLEPROOF_REMOTE ?? projectConfig.remote ?? DEFAULT_REMOTE;
let uploadMode =
  process.env.STYLEPROOF_UPLOAD === '1' ? 'required' : process.env.STYLEPROOF_UPLOAD === '0' ? 'off' : 'auto';
let crawlBaseUrl = process.env.STYLEPROOF_CRAWL_BASE_URL ?? '';
const crawlRoutes = (process.env.STYLEPROOF_CRAWL_ROUTES ?? '')
  .split(',')
  .map((route) => route.trim())
  .filter(Boolean);
let crawlOut = process.env.STYLEPROOF_CRAWL_OUT ?? 'styleproof.variants.generated.json';
let crawlMaxActions = process.env.STYLEPROOF_CRAWL_MAX_ACTIONS ?? '';
let crawlWidth = process.env.STYLEPROOF_CRAWL_WIDTH ?? '';
let crawlHeight = process.env.STYLEPROOF_CRAWL_HEIGHT ?? '';
let crawlStrict = process.env.STYLEPROOF_CRAWL_STRICT === '1';
let tolerateSurfaceFailures =
  process.env.STYLEPROOF_TOLERATE_SURFACE_FAILURES === '1' ||
  process.env.STYLEPROOF_TOLERATE_SURFACE_FAILURES === 'true';
// Allow paths accumulate across layers (config + env + flags) — they are all
// "files my tooling rewrites", never mutually exclusive alternatives.
const dirtyAllow = [
  ...(projectConfig.dirtyAllow ?? []),
  ...(process.env.STYLEPROOF_DIRTY_ALLOW ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean),
];
const playwrightArgs = [];

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (isHelpArg(a)) showHelpAndExit(HELP);
  else if (a === '--') {
    playwrightArgs.push(...argv.slice(i + 1));
    break;
  } else if (a === '--spec') spec = argv[++i];
  else if (a.startsWith('--spec=')) spec = a.slice(7);
  else if (a === '--dir') dir = argv[++i];
  else if (a.startsWith('--dir=')) dir = a.slice(6);
  else if (a === '--base-dir') baseDir = argv[++i];
  else if (a.startsWith('--base-dir=')) baseDir = a.slice(11);
  else if (a === '--screenshots') screenshots = '1';
  else if (a === '--no-screenshots') screenshots = '0';
  else if (a === '--keep-har') keepHar = true;
  else if (a === '--sha') sha = argv[++i];
  else if (a.startsWith('--sha=')) sha = a.slice(6);
  else if (a === '--upload') uploadMode = 'required';
  else if (a === '--no-upload') uploadMode = 'off';
  else if (a === '--restore') restore = true;
  else if (a === '--crawl-base-url') crawlBaseUrl = argv[++i];
  else if (a.startsWith('--crawl-base-url=')) crawlBaseUrl = a.slice(17);
  else if (a === '--crawl-route') crawlRoutes.push(argv[++i]);
  else if (a.startsWith('--crawl-route=')) crawlRoutes.push(a.slice(14));
  else if (a === '--crawl-out') crawlOut = argv[++i];
  else if (a.startsWith('--crawl-out=')) crawlOut = a.slice(12);
  else if (a === '--crawl-max-actions') crawlMaxActions = argv[++i];
  else if (a.startsWith('--crawl-max-actions=')) crawlMaxActions = a.slice(20);
  else if (a === '--crawl-width') crawlWidth = argv[++i];
  else if (a.startsWith('--crawl-width=')) crawlWidth = a.slice(14);
  else if (a === '--crawl-height') crawlHeight = argv[++i];
  else if (a.startsWith('--crawl-height=')) crawlHeight = a.slice(15);
  else if (a === '--crawl-strict') crawlStrict = true;
  else if (a === '--dirty-allow') dirtyAllow.push(argv[++i]);
  else if (a.startsWith('--dirty-allow=')) dirtyAllow.push(a.slice(14));
  else if (a === '--tolerate-surface-failures') tolerateSurfaceFailures = true;
  else if (a === '--cache-branch' || a === '--remote') {
    const value = argv[++i];
    if (a === '--cache-branch') cacheBranch = value;
    else remote = value;
  } else if (a.startsWith('--cache-branch=')) cacheBranch = a.slice(15);
  else if (a.startsWith('--remote=')) remote = a.slice(9);
  else if (a.startsWith('--')) {
    console.error(unknownFlagMessage('styleproof-map', a));
    process.exit(2);
  } else {
    spec = a;
  }
}

if (!spec) {
  console.error('--spec requires a path');
  process.exit(2);
}
if (!dir) {
  console.error('--dir requires a label');
  process.exit(2);
}
if (!baseDir) {
  console.error('--base-dir requires a path');
  process.exit(2);
}
if (!fs.existsSync(spec)) {
  console.error(missingSpecMessage(spec));
  process.exit(2);
}
const crawlEnabled = Boolean(crawlBaseUrl || crawlRoutes.length);
if (crawlEnabled && !crawlBaseUrl) {
  console.error('styleproof-map: --crawl-base-url is required when --crawl-route is set');
  process.exit(2);
}
if (crawlEnabled && !crawlRoutes.length) {
  console.error('styleproof-map: at least one --crawl-route is required when --crawl-base-url is set');
  process.exit(2);
}
if (restore && !sha) {
  try {
    sha = currentGitSha(process.cwd());
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
}

function removeHarFiles(root) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = `${root}/${entry.name}`;
    if (entry.isDirectory()) removeHarFiles(full);
    else if (entry.isFile() && entry.name.endsWith('.har')) fs.rmSync(full, { force: true });
  }
}

function shouldAutoUpload() {
  return uploadMode === 'auto' && !process.env.CI;
}

function upload(dirPath) {
  if (uploadMode === 'off') return;
  if (!shouldAutoUpload() && uploadMode !== 'required') return;
  const platformWarning = nonLinuxUploadWarning(
    process.platform,
    process.env.STYLEPROOF_SUPPRESS_PLATFORM_WARNING === '1',
  );
  if (platformWarning) console.error(platformWarning);
  try {
    const res = publishMapBundle({ dir: dirPath, branch: cacheBranch, remote });
    console.error(`styleproof-map: uploaded ${res.sha.slice(0, 12)} (${res.compatibilityKey}) to ${res.branch}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (uploadMode === 'required') {
      // A precondition the user must fix (dirty tree, missing manifest) keeps
      // the usage code 2 — retrying can never succeed. Everything else is the
      // retryable map-store/network fault class the restore side reports as 5;
      // triage keys on this split (2 = fix the job, 5 = re-run the job).
      console.error(`styleproof-map: upload failed\n${message}`);
      process.exit(e instanceof MapStorePreconditionError ? 2 : 5);
    }
    if (e instanceof MapStoreError) {
      console.error(`styleproof-map: map captured locally; upload skipped (${message})`);
    } else {
      console.error(`styleproof-map: map captured locally; upload skipped`);
    }
  }
}

function hasPlaywrightConfigArg(args) {
  return args.some((arg) => arg === '--config' || arg === '-c' || arg.startsWith('--config='));
}

function variantCrawlArgs() {
  const args = ['--base-url', crawlBaseUrl, '--out', crawlOut];
  for (const route of crawlRoutes) args.push('--route', route);
  if (crawlMaxActions) args.push('--max-actions', crawlMaxActions);
  if (crawlWidth) args.push('--width', crawlWidth);
  if (crawlHeight) args.push('--height', crawlHeight);
  if (crawlStrict) args.push('--strict');
  return args;
}

function runVariantCrawl(env) {
  if (!crawlEnabled) return;
  console.error('styleproof-map: crawling UI variants before capture');
  const command = process.platform === 'win32' ? 'styleproof-variants.cmd' : 'styleproof-variants';
  let result = spawnSync(command, variantCrawlArgs(), { stdio: 'inherit', env });
  if (result.error?.code === 'ENOENT') {
    result = spawnSync(process.execPath, [STYLEPROOF_VARIANTS_SCRIPT, ...variantCrawlArgs()], {
      stdio: 'inherit',
      env,
    });
  }
  if (result.error) {
    console.error(`styleproof-map: could not run styleproof-variants\n${result.error.message}`);
    process.exit(2);
  }
  const status = result.status ?? 1;
  if (status !== 0) process.exit(status);
}

// An ABSOLUTE STYLEMAP_DIR/--dir is respected as-is; a relative one nests under
// baseDir (.styleproof/maps by default) — mirrors the runner's resolveOutputDir.
const targetDir = path.isAbsolute(dir) ? dir : path.join(baseDir, dir);
// Sample the tree state the capture is ABOUT to render, so the manifest can bind the
// map to it. A capture runs for minutes; if the source is edited or HEAD moves in that
// window, the map renders one state but would otherwise be stamped clean@post-HEAD and
// published as the authoritative map for a SHA it never rendered — a stale map every
// future diff against that SHA silently trusts as a false green.
let dirtyBeforeCapture;
let headBeforeCapture;
try {
  dirtyBeforeCapture = workingTreeDirty(process.cwd(), dirtyAllow);
  headBeforeCapture = currentGitSha(process.cwd());
} catch {
  dirtyBeforeCapture = false;
  headBeforeCapture = undefined;
}

if (restore) {
  try {
    const compatibilityKey = expectedCompatibilityKey({ spec });
    const manifest = restoreMapBundle({
      sha,
      outDir: targetDir,
      branch: cacheBranch,
      remote,
      compatibilityKey,
    });
    console.log(`styleproof-map: restored ${manifest.sha.slice(0, 12)} (${manifest.compatibilityKey}) to ${targetDir}`);
    process.exit(0);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Exit code taxonomy so CI can tell a genuine cache miss from an infra fault:
    //   4 — bundle absent (expected miss → the cold path should recapture);
    //   5 — infrastructure fault after retries (network/clone/timeout → fail loudly,
    //       don't silently burn a full recapture on a flaky network).
    // A restore never exits 2: that code is reserved for usage errors above.
    const notFound = e instanceof MapStoreNotFoundError;
    process.exitCode = notFound ? 4 : 5;
    console.error(
      [
        notFound
          ? `styleproof-map: no cached map for ${sha} on ${cacheBranch} (cache miss)`
          : `styleproof-map: could not reach the map store to restore ${sha} from ${cacheBranch}`,
        message,
        notFound
          ? `Next: run styleproof-map at that commit to build/upload the map, or let CI recapture both sides.`
          : `Next: retry — this is a transient map-store/network fault, not a missing bundle.`,
      ].join('\n'),
    );
    process.exit(process.exitCode);
  }
}

// Clear any prior run's browser-build sidecar before Playwright runs, so ONLY this
// run can have written it. The default dir (.styleproof/maps/current) is reused across
// runs; if this run records no browser version (the capture test not reached, or the
// handle unavailable), a stale sidecar would otherwise be read into the manifest and
// stamp a WRONG browser build that the compatibility guard then trusts as a fingerprint.
fs.rmSync(path.join(targetDir, BROWSER_BUILD_SIDECAR), { force: true });
// Same reuse hazard for the surface-capture-failures ledger: writeMapManifest reads
// back whatever is on disk, so a failure recorded by a PRIOR run into this reused dir
// (or restored from the store) would be stamped into THIS run's manifest — a healthy
// recapture would publish a phantom "partial baseline" that every later diff then
// blocks on with repair-base guidance no repair can satisfy.
fs.rmSync(path.join(targetDir, SURFACE_CAPTURE_FAILURES_DIR), { recursive: true, force: true });

const command = process.platform === 'win32' ? 'playwright.cmd' : 'playwright';
const configArgs =
  fs.existsSync(STYLEPROOF_PLAYWRIGHT_CONFIG) && !hasPlaywrightConfigArg(playwrightArgs)
    ? ['--config', STYLEPROOF_PLAYWRIGHT_CONFIG]
    : [];
const env = {
  ...process.env,
  STYLEMAP_DIR: dir,
  STYLEPROOF_BASEDIR: baseDir,
  STYLEPROOF_SCREENSHOTS: screenshots,
  // Freeze the SPEC PROCESS clock alongside the browser clock (the freezeClock
  // contract): importing styleproof under this env pins Node's Date before the
  // spec's module-level fixture constants evaluate, so a `new Date()` stamp is
  // identical across base and head captures instead of leaking each run's wall
  // clock into the render. Explicit STYLEPROOF_FREEZE_SPEC_CLOCK=0 opts out.
  STYLEPROOF_FREEZE_SPEC_CLOCK: process.env.STYLEPROOF_FREEZE_SPEC_CLOCK ?? '1',
  ...(tolerateSurfaceFailures ? { STYLEPROOF_TOLERATE_SURFACE_FAILURES: '1' } : {}),
};
runVariantCrawl(env);
const result = spawnSync(command, ['test', '--grep', 'styleproof capture', ...configArgs, ...playwrightArgs], {
  stdio: 'inherit',
  env,
});
if (result.error) {
  console.error(playwrightMissingMessage(result.error.message));
  process.exit(2);
}
let status = result.status ?? 1;
const captured = fs.existsSync(targetDir) ? fs.readdirSync(targetDir).filter(isMapFile).length : 0;
const toleratedFailures = readSurfaceCaptureFailures(targetDir);
// Promote to a publishable partial baseline ONLY when the failures are actually
// LEDGERED. Self-check/nondeterminism failures are deliberately never recorded —
// promoting a run that failed for an unrecorded reason would publish a "partial
// baseline (0 tolerated failures)" whose missing surfaces later read as approvable
// greenfield-new: exactly the laundering the ledger exists to prevent.
if (status !== 0 && tolerateSurfaceFailures && captured > 0 && toleratedFailures.length > 0) {
  console.error(
    `styleproof-map: Playwright exited ${status} but ${captured} surface map(s) were captured — publishing partial baseline (${toleratedFailures.length} tolerated failure(s))`,
  );
  status = 0;
} else if (status !== 0 && tolerateSurfaceFailures && captured > 0) {
  console.error(
    `styleproof-map: Playwright exited ${status} with ${captured} surface map(s) but NO ledgered surface failure — ` +
      'an unrecorded failure class (e.g. a self-check/nondeterminism failure) is not tolerable; failing the capture.',
  );
}
if (status === 0) {
  if (!keepHar) removeHarFiles(targetDir);
  // A run that produced ZERO surface maps must not stamp a manifest (or upload):
  // a manifest over an empty bundle would read as "a bundle that claims to exist
  // yet holds nothing" and the diff would refuse it as a missing base map. A bare
  // dir instead means "no baseline yet" — on a first adoption, capturing the base
  // commit that predates the spec legitimately yields zero surfaces, and the diff
  // then takes the exit-3 new-surfaces review path.
  if (captured === 0) {
    console.error(
      'styleproof-map: 0 surfaces captured — no manifest written; if this is the base side of a first adoption, the diff will treat it as no-baseline',
    );
    process.exit(status);
  }
  // Bind the map to the commit it actually started rendering (headBeforeCapture), not a
  // HEAD that may have moved mid-capture. `--sha` still wins for callers that know better.
  const manifestSha = sha || headBeforeCapture || 'local';
  // Re-check the tree AFTER capture (ignoring the maps this run just wrote): if the source
  // was edited, or HEAD moved, during the capture window, the map↔SHA binding is a lie —
  // mark it dirty so publishMapBundle refuses to push a stale map into the SHA-keyed store.
  let dirty = dirtyBeforeCapture;
  try {
    const rel = path.relative(process.cwd(), targetDir) || targetDir;
    const headAfter = currentGitSha(process.cwd(), env);
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
      env,
    });
    console.error(`styleproof-map: wrote ${targetDir} for ${manifest.sha.slice(0, 12)} (${manifest.compatibilityKey})`);
  } catch (e) {
    console.error(`styleproof-map: could not write map manifest\n${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  upload(targetDir);
}
process.exit(status);
