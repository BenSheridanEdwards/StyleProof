#!/usr/bin/env node
// Audit typed component-manifest coverage: print the declared, excluded-with-reason,
// and uncovered component files. Exit 1 when uncovered files remain, 2 on usage errors.
import path from 'node:path';
import { validateComponentManifest } from '../dist/component-manifest.js';
import { componentManifestInventory } from '../dist/component-inventory.js';
import { discoverComponentFiles } from '../dist/components.js';
import { defineCli, readJson, run } from './cli.mjs';

const NAME = 'styleproof-components';
const cli = defineCli({
  name: NAME,
  alias: 'components',
  usage: [`${NAME} --manifest <file> --component-root <dir> [options]`],
  flags: {
    manifest: { value: 'file', help: 'component manifest JSON', required: true },
    'component-root': { value: 'dir', help: 'component root to scan.', repeat: true, required: true },
    'uncovered-ok': { help: 'exit 0 while retaining uncovered files in JSON output' },
  },
  notes: ['Exit 1 when uncovered files remain (default), 2 for usage or manifest errors.'],
});

const { opts } = cli.parse();
const cwd = process.cwd();
await run(
  NAME,
  () => {
    const manifest = validateComponentManifest(readJson(NAME, path.resolve(cwd, opts.manifest), 'the manifest'), {
      cwd,
    });
    const inventory = componentManifestInventory(
      manifest,
      discoverComponentFiles({ cwd, roots: opts['component-root'] }),
    );
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
    if (inventory.uncovered.length && !opts['uncovered-ok']) process.exit(1);
  },
  { exitCode: 2 },
);
