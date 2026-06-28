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
import {
  isHelpArg,
  missingSpecMessage,
  playwrightMissingMessage,
  showHelpAndExit,
  unknownFlagMessage,
} from '../dist/cli-errors.js';
import {
  DEFAULT_MAP_DIR,
  DEFAULT_MAP_LABEL,
  DEFAULT_MAP_STORE_BRANCH,
  DEFAULT_REMOTE,
  MapStoreError,
  currentGitSha,
  expectedCompatibilityKey,
  publishMapBundle,
  restoreMapBundle,
  workingTreeDirty,
  writeMapManifest,
} from '../dist/map-store.js';

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
  --cache-branch <b>  map store branch (default: ${DEFAULT_MAP_STORE_BRANCH})
  --remote <name>     git remote for the map store (default: ${DEFAULT_REMOTE})
  -h, --help          show this help

Examples:
  styleproof-map
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
  else if (a === '--cache-branch') cacheBranch = argv[++i];
  else if (a.startsWith('--cache-branch=')) cacheBranch = a.slice(15);
  else if (a === '--remote') remote = argv[++i];
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

const targetDir = path.join(baseDir, dir);
let dirtyBeforeCapture;
try {
  dirtyBeforeCapture = workingTreeDirty(process.cwd());
} catch {
  dirtyBeforeCapture = false;
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

const command = process.platform === 'win32' ? 'playwright.cmd' : 'playwright';
const env = {
  ...process.env,
  STYLEMAP_DIR: dir,
  STYLEPROOF_BASEDIR: baseDir,
  STYLEPROOF_SCREENSHOTS: screenshots,
};
const result = spawnSync(command, ['test', '--grep', 'styleproof capture', ...playwrightArgs], {
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
  try {
    let manifestSha = sha || undefined;
    if (!manifestSha) {
      try {
        manifestSha = currentGitSha(process.cwd(), env);
      } catch {
        manifestSha = 'local';
      }
    }
    const manifest = writeMapManifest({
      dir: targetDir,
      spec,
      sha: manifestSha,
      screenshots: screenshots !== '0',
      dirty: dirtyBeforeCapture,
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
