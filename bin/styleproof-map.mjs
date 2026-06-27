#!/usr/bin/env node
/**
 * Capture the current branch's computed-style map.
 *
 * The zero-config path is the committed-map flow scaffolded by styleproof-init:
 *   styleproof-map
 *
 * It runs Playwright against e2e/styleproof.spec.ts with:
 *   STYLEMAP_DIR=current
 *   STYLEPROOF_BASEDIR=stylemaps
 *   STYLEPROOF_SCREENSHOTS=0
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  isHelpArg,
  missingSpecMessage,
  playwrightMissingMessage,
  showHelpAndExit,
  unknownFlagMessage,
} from '../dist/cli-errors.js';

const HELP = `styleproof-map — capture this branch's computed-style map

usage: styleproof-map [options] [-- <playwright args>]

options:
  --spec <path>       StyleProof spec that must exist (default: e2e/styleproof.spec.ts)
  --dir <label>       output label under --base-dir (default: current)
  --base-dir <path>   output root directory (default: stylemaps)
  --screenshots       keep screenshots for reports (default: off for committed maps)
  --no-screenshots    write lean .json.gz maps only (default)
  --keep-har          keep recorded HAR files for advanced replay workflows
  -h, --help          show this help

Examples:
  styleproof-map
  styleproof-map --spec e2e/styleproof.spec.ts
  styleproof-map --dir review --base-dir __stylemaps__ --screenshots --keep-har
`;

const argv = process.argv.slice(2);
let spec = 'e2e/styleproof.spec.ts';
let dir = process.env.STYLEMAP_DIR ?? 'current';
let baseDir = process.env.STYLEPROOF_BASEDIR ?? 'stylemaps';
let screenshots = process.env.STYLEPROOF_SCREENSHOTS ?? '0';
let keepHar = process.env.STYLEPROOF_KEEP_HAR === '1';
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

function removeHarFiles(root) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = `${root}/${entry.name}`;
    if (entry.isDirectory()) removeHarFiles(full);
    else if (entry.isFile() && entry.name.endsWith('.har')) fs.rmSync(full, { force: true });
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
if (status === 0 && !keepHar) removeHarFiles(`${baseDir}/${dir}`);
process.exit(status);
