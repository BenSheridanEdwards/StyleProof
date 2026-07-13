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
  playwrightMissingMessage,
  showHelpAndExit,
  unknownFlagMessage,
} from '../dist/cli-errors.js';
import {
  BROWSER_BUILD_SIDECAR,
  DEFAULT_MAP_DIR,
  DEFAULT_MAP_LABEL,
  DEFAULT_MAP_STORE_BRANCH,
  DEFAULT_REMOTE,
  MapStoreError,
  currentGitSha,
  expectedCompatibilityKey,
  isMapFile,
  publishMapBundle,
  restoreMapBundle,
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
  -h, --help          show this help

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
let spec = 'e2e/styleproof.spec.ts';
let dir = process.env.STYLEMAP_DIR ?? DEFAULT_MAP_LABEL;
let baseDir = process.env.STYLEPROOF_BASEDIR ?? DEFAULT_MAP_DIR;
let screenshots = process.env.STYLEPROOF_SCREENSHOTS ?? '1';
let keepHar = process.env.STYLEPROOF_KEEP_HAR === '1';
let sha = process.env.STYLEPROOF_SHA ?? '';
let restore = false;
let cacheBranch = process.env.STYLEPROOF_CACHE_BRANCH ?? DEFAULT_MAP_STORE_BRANCH;
let remote = process.env.STYLEPROOF_REMOTE ?? DEFAULT_REMOTE;
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
  try {
    const res = publishMapBundle({ dir: dirPath, branch: cacheBranch, remote });
    console.error(`styleproof-map: uploaded ${res.sha.slice(0, 12)} (${res.compatibilityKey}) to ${res.branch}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (uploadMode === 'required') {
      console.error(`styleproof-map: upload failed\n${message}`);
      process.exit(2);
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
  dirtyBeforeCapture = workingTreeDirty(process.cwd());
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
    console.error(
      [
        `styleproof-map: could not restore ${sha} from ${cacheBranch}`,
        message,
        `Next: run styleproof-map at that commit to build/upload the map, or let CI recapture both sides.`,
      ].join('\n'),
    );
    process.exit(2);
  }
}

// Clear any prior run's browser-build sidecar before Playwright runs, so ONLY this
// run can have written it. The default dir (.styleproof/maps/current) is reused across
// runs; if this run records no browser version (the capture test not reached, or the
// handle unavailable), a stale sidecar would otherwise be read into the manifest and
// stamp a WRONG browser build that the compatibility guard then trusts as a fingerprint.
fs.rmSync(path.join(targetDir, BROWSER_BUILD_SIDECAR), { force: true });

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
const status = result.status ?? 1;
if (status === 0) {
  if (!keepHar) removeHarFiles(targetDir);
  // A run that produced ZERO surface maps must not stamp a manifest (or upload):
  // a manifest over an empty bundle would read as "a bundle that claims to exist
  // yet holds nothing" and the diff would refuse it as a missing base map. A bare
  // dir instead means "no baseline yet" — on a first adoption, capturing the base
  // commit that predates the spec legitimately yields zero surfaces, and the diff
  // then takes the exit-3 new-surfaces review path.
  const captured = fs.existsSync(targetDir) ? fs.readdirSync(targetDir).filter(isMapFile).length : 0;
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
    if (workingTreeDirty(process.cwd(), rel) || (headBeforeCapture && headAfter !== headBeforeCapture)) dirty = true;
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
