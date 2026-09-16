#!/usr/bin/env node
// The canonical pre-push capture → publish flow. The generated hook shim execs
// this command with git's refspec lines on stdin; all behaviour (which pushed
// ref to capture, the docs-only skip, restore-before-capture, the advisory
// diff) lives here so it ships with the release instead of as copied bash.
//
// Exit 0 on success or any safe skip (CI recaptures on a cache miss); a failed
// capture/upload propagates its code and blocks the push.
import fs from 'node:fs';
import { classifyRestoreExit } from '../dist/ci.js';
import { resolveProjectSpec, specPathForCwd } from '../dist/config.js';
import { DEFAULT_MAP_DIR, DEFAULT_MAP_LABEL } from '../dist/map-store.js';
import { choosePrePushCaptureSha, parsePrePushRefs } from '../dist/prepush.js';
import { decodeSpecPathEnv, validateRepoRelativeSpecPath } from './spec-path-env.mjs';
import { defineCli, errorMessage, fail, gitOutput, runBin } from './cli.mjs';

const NAME = 'styleproof-prepush';
const cli = defineCli({
  name: NAME,
  alias: 'prepush',
  usage: [`${NAME} [options]`],
  summary: [
    "Git's pre-push hook pipes refspec lines to stdin. For the ref whose tip is the",
    'checked-out tree, restore an existing exact-SHA map or capture once and publish',
    'to the styleproof-maps branch, so CI restores by SHA and reports without a browser.',
    '',
    'Safe skips (exit 0; CI recaptures on a cache miss):',
    '  STYLEPROOF_SKIP_CAPTURE=1   skip unconditionally',
    '  a docs-only push            only *.md/*.mdx/*.markdown/*.txt/docs/**/LICENSE change',
    "  a non-checked-out ref push  capturing another branch's SHA from this tree would lie",
  ].join('\n'),
  flags: {
    spec: { value: 'path', help: 'StyleProof spec (default: styleproof.config spec or e2e/styleproof.spec.ts)' },
    dir: { value: 'label', help: 'restore label under --base-dir', default: DEFAULT_MAP_LABEL },
    'base-dir': { value: 'path', help: 'map root directory', default: DEFAULT_MAP_DIR },
    'dirty-allow': {
      value: 'path',
      help: 'forwarded to styleproof-map: tracked path whose changes never mark the capture dirty.',
      repeat: true,
    },
    diff: { help: 'run the advisory styleproof-diff after restore/capture', negate: true, default: true },
  },
});

const { opts } = cli.parse();
let spec = opts.spec;
try {
  if (!spec) {
    const resolved = resolveProjectSpec({ startDir: process.cwd(), requireSpec: false });
    spec = resolved.configFile
      ? specPathForCwd(resolved.spec, process.cwd())
      : (decodeSpecPathEnv() ?? resolved.specDeclared);
  }
  spec = validateRepoRelativeSpecPath(spec ?? 'e2e/styleproof.spec.ts');
} catch (error) {
  fail(NAME, errorMessage(error));
}

if (process.env.STYLEPROOF_SKIP_CAPTURE === '1') process.exit(0);

const headSha = gitOutput(['rev-parse', 'HEAD']);
const stdinText = process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8');
const choice = choosePrePushCaptureSha({
  refs: parsePrePushRefs(stdinText),
  headSha,
  changedFiles: (from, to) => gitOutput(['diff', '--name-only', from, to])?.split(/\r?\n/).filter(Boolean),
});
for (const note of choice.notes) console.error(note);
// Nothing to faithfully capture (all deletes / docs-only / a non-checked-out ref).
if (!choice.sha) process.exit(0);

const mapArgs = ['--sha', choice.sha, '--dir', opts.dir, '--base-dir', opts['base-dir'], '--spec', spec];
const restore = runBin('styleproof-map', ['--restore', ...mapArgs]);
const outcome = classifyRestoreExit(restore.status);
if (outcome === 'fault') {
  fail(
    NAME,
    `map restore hit a map-store/network fault (exit ${restore.status}). Retry the push.`,
    restore.status ?? 5,
  );
}
if (outcome === 'miss') {
  const dirtyAllow = opts['dirty-allow'].flatMap((p) => ['--dirty-allow', p]);
  const capture = runBin('styleproof-map', [...mapArgs, '--upload', ...dirtyAllow]);
  if ((capture.status ?? 1) !== 0) process.exit(capture.status ?? 1);
}
if (opts.diff) runBin('styleproof-diff', []); // advisory: show drift before CI does
process.exit(0);
