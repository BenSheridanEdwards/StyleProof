#!/usr/bin/env node
// The pre-push capture → publish flow the generated hook shim execs with git's
// refspec lines on stdin. Exit 0 on success or any safe skip (CI recaptures on a
// cache miss); a failed capture/upload propagates its code and blocks the push.
import fs from 'node:fs';
import { loadStyleProofConfigWithLocation } from '../dist/config.js';
import { DEFAULT_MAP_DIR, DEFAULT_MAP_LABEL } from '../dist/map-store.js';
import { choosePrePushCaptureSha, parsePrePushRefs } from '../dist/prepush.js';
import { validateRepoRelativeSpecPath } from './spec-path-env.mjs';
import { defineCli, gitOutput, run, runBin } from './cli.mjs';
import { captureMap, checkoutSpec, dirtyAllowArgs, restoreMap } from './ci-shared.mjs';

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
await run(
  NAME,
  () => {
    const spec = opts.spec
      ? validateRepoRelativeSpecPath(opts.spec)
      : checkoutSpec(loadStyleProofConfigWithLocation(), process.cwd());
    if (process.env.STYLEPROOF_SKIP_CAPTURE === '1') return;

    const choice = choosePrePushCaptureSha({
      refs: parsePrePushRefs(process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8')),
      headSha: gitOutput(['rev-parse', 'HEAD']),
      changedFiles: (from, to) => gitOutput(['diff', '--name-only', from, to])?.split(/\r?\n/).filter(Boolean),
    });
    for (const note of choice.notes) console.error(note);
    // Nothing to faithfully capture (all deletes / docs-only / a non-checked-out ref).
    if (!choice.sha) return;

    const mapArgs = ['--sha', choice.sha, '--dir', opts.dir, '--base-dir', opts['base-dir'], '--spec', spec];
    if (!restoreMap(mapArgs, { next: 'Retry the push.' }).hit) {
      const status = captureMap(NAME, [...mapArgs, '--upload', ...dirtyAllowArgs(opts['dirty-allow'])]);
      if (status !== 0) process.exit(status);
    }
    if (opts.diff) runBin('styleproof-diff', []); // advisory: show drift before CI does
  },
  { exitCode: 2 },
);
