#!/usr/bin/env node
/**
 * The canonical pre-push capture → publish flow, packaged.
 *
 * The generated pre-push hook is a two-line shim that execs this command with
 * git's refspec lines on stdin. All behavior — which pushed ref to capture, the
 * docs-only skip, restore-before-capture, the advisory diff — lives here (and in
 * dist/prepush.js), so it ships with the styleproof release instead of being
 * copied bash every consumer maintains by hand.
 *
 * Exit status: 0 on success or any safe skip (CI recaptures on a cache miss);
 * a failed capture/upload propagates its code and blocks the push, exactly like
 * the shell hook it replaces.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isHelpArg, projectConfigOrExit, showHelpAndExit, unknownFlagMessage } from '../dist/cli-errors.js';
import { DEFAULT_MAP_DIR, DEFAULT_MAP_LABEL } from '../dist/map-store.js';
import { choosePrePushCaptureSha, parsePrePushRefs } from '../dist/prepush.js';

const HELP = `styleproof-prepush — capture the pushed commit's map and publish it to the map store

usage: git's pre-push hook pipes refspecs to: styleproof-prepush [options]

For the ref whose tip is the checked-out tree, restore an existing exact-SHA map
or capture once and publish to the styleproof-maps branch, so CI restores by SHA
and reports without a browser. Maps never get committed to the PR branch.

Safe skips (exit 0; CI recaptures on a cache miss):
  STYLEPROOF_SKIP_CAPTURE=1   skip unconditionally
  a docs-only push            only *.md/*.mdx/*.markdown/*.txt/docs/**/LICENSE change
  a non-checked-out ref push  capturing another branch's SHA from this tree would lie

options:
  --spec <path>       StyleProof spec (default: e2e/styleproof.spec.ts)
  --dir <label>       restore label under --base-dir (default: ${DEFAULT_MAP_LABEL})
  --base-dir <path>   map root directory (default: ${DEFAULT_MAP_DIR})
  --dirty-allow <path>
                      forwarded to styleproof-map: tracked path whose changes never
                      mark the capture dirty; repeatable
  --no-diff           skip the advisory styleproof-diff after restore/capture
  -h, --help          show this help

A styleproof.config.json at the repo root supplies project defaults ("spec",
"dirtyAllow", …) so the generated hook shim needs no per-repo flag threading.
`;

const argv = process.argv.slice(2);
const projectConfig = projectConfigOrExit('styleproof-prepush');
let spec = projectConfig.spec ?? 'e2e/styleproof.spec.ts';
let dir = DEFAULT_MAP_LABEL;
let baseDir = DEFAULT_MAP_DIR;
let advisoryDiff = true;
const dirtyAllow = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (isHelpArg(a)) showHelpAndExit(HELP);
  else if (a === '--spec') spec = argv[++i];
  else if (a.startsWith('--spec=')) spec = a.slice(7);
  else if (a === '--dir') dir = argv[++i];
  else if (a.startsWith('--dir=')) dir = a.slice(6);
  else if (a === '--base-dir') baseDir = argv[++i];
  else if (a.startsWith('--base-dir=')) baseDir = a.slice(11);
  else if (a === '--dirty-allow') dirtyAllow.push(argv[++i]);
  else if (a.startsWith('--dirty-allow=')) dirtyAllow.push(a.slice(14));
  else if (a === '--no-diff') advisoryDiff = false;
  else {
    console.error(unknownFlagMessage('styleproof-prepush', a));
    process.exit(2);
  }
}

if (process.env.STYLEPROOF_SKIP_CAPTURE === '1') process.exit(0);

const here = path.dirname(fileURLToPath(import.meta.url));
const MAP = path.join(here, 'styleproof-map.mjs');
const DIFF = path.join(here, 'styleproof-diff.mjs');
// The capture spawns the `playwright` binary by name: make sure the consumer's
// node_modules/.bin is on PATH even when this command was invoked directly
// (`node .../styleproof-prepush.mjs`) rather than through a package manager exec.
const binDirs = [path.join(process.cwd(), 'node_modules', '.bin'), path.resolve(here, '..', '..', '.bin')];
const env = { ...process.env, PATH: `${binDirs.join(path.delimiter)}${path.delimiter}${process.env.PATH ?? ''}` };

function git(...args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trimEnd() : undefined;
}

const headSha = git('rev-parse', 'HEAD');
const stdinText = process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8');
const choice = choosePrePushCaptureSha({
  refs: parsePrePushRefs(stdinText),
  headSha,
  changedFiles: (from, to) => git('diff', '--name-only', from, to)?.split(/\r?\n/).filter(Boolean),
});
for (const note of choice.notes) console.error(note);

// Nothing to faithfully capture (all deletes / docs-only / a non-checked-out ref).
if (!choice.sha) process.exit(0);

const dirtyAllowArgs = dirtyAllow.flatMap((p) => ['--dirty-allow', p]);
const restore = spawnSync(
  process.execPath,
  [MAP, '--restore', '--sha', choice.sha, '--dir', dir, '--base-dir', baseDir, '--spec', spec],
  { stdio: 'inherit', env },
);
if (restore.status !== 0) {
  const capture = spawnSync(
    process.execPath,
    [MAP, '--spec', spec, '--sha', choice.sha, '--upload', ...dirtyAllowArgs],
    { stdio: 'inherit', env },
  );
  if ((capture.status ?? 1) !== 0) process.exit(capture.status ?? 1);
}
if (advisoryDiff) spawnSync(process.execPath, [DIFF], { stdio: 'inherit', env }); // advisory: show drift before CI does
process.exit(0);
