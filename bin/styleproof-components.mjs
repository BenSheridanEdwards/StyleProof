#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { validateComponentManifest } from '../dist/component-manifest.js';
import { componentManifestInventory } from '../dist/component-inventory.js';
import { discoverComponentFiles } from '../dist/components.js';
import { isHelpArg, showHelpAndExit, unknownFlagMessage } from '../dist/cli-errors.js';

const HELP = `styleproof-components — audit typed component-manifest coverage

usage: styleproof-components --manifest <file> --component-root <dir> [options]

options:
  --manifest <file>       component manifest JSON
  --component-root <dir>  component root to scan. Repeatable.
  --uncovered-ok          exit 0 while retaining uncovered files in JSON output
  -h, --help              show this help

Prints exact declared, excluded-with-reason, and uncovered JSON sections.
Exit 1 when uncovered files remain (default), 2 for usage or manifest errors.
`;

const argv = process.argv.slice(2);
let manifestPath = '';
let uncoveredOk = false;
const roots = [];

for (let index = 0; index < argv.length; index++) {
  const argument = argv[index];
  if (isHelpArg(argument)) showHelpAndExit(HELP);
  else if (argument === '--manifest') manifestPath = argv[++index] ?? '';
  else if (argument.startsWith('--manifest=')) manifestPath = argument.slice('--manifest='.length);
  else if (argument === '--component-root') roots.push(argv[++index] ?? '');
  else if (argument.startsWith('--component-root=')) roots.push(argument.slice('--component-root='.length));
  else if (argument === '--uncovered-ok') uncoveredOk = true;
  else {
    console.error(unknownFlagMessage('styleproof-components', argument));
    process.exit(2);
  }
}

if (!manifestPath) {
  console.error('styleproof-components: --manifest is required');
  process.exit(2);
}
if (!roots.length || roots.some((root) => !root)) {
  console.error('styleproof-components: at least one non-empty --component-root is required');
  process.exit(2);
}

try {
  const cwd = process.cwd();
  const manifestAbsolute = path.resolve(cwd, manifestPath);
  const input = JSON.parse(fs.readFileSync(manifestAbsolute, 'utf8'));
  const manifest = validateComponentManifest(input, { cwd });
  const discovered = discoverComponentFiles({ cwd, roots });
  const inventory = componentManifestInventory(manifest, discovered);
  process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
  if (inventory.uncovered.length && !uncoveredOk) process.exit(1);
} catch (error) {
  console.error(`styleproof-components: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
