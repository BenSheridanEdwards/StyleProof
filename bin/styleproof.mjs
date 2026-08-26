#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const binDir = path.dirname(fileURLToPath(import.meta.url));

const HELP = `styleproof — deterministic UI evidence from setup to certification

usage: styleproof <command> [options]

start:
  setup       detect the project and scaffold StyleProof

capture:
  capture     capture this repository state from a StyleProof spec
  crawl       capture a URL or crawled application directly
  variants    inspect and generate surface variants
  affected    resolve surfaces affected by changed source files

review:
  compare     compare base and head captures, fail closed by default
  report      generate a local review report on command

automation:
  ci               run the cache-aware CI capture and comparison flow
  prepush          run the render-affecting pre-push capture guard
  publish-report   publish a generated report for PR review

maintenance:
  prune-reports    remove expired published reports
  prune-maps       compact the legacy Git-backed map cache

examples:
  styleproof setup
  styleproof capture
  styleproof compare main
  styleproof report main --out styleproof-report

Run styleproof <command> --help for command-specific options.
Existing styleproof-* commands remain supported for backwards compatibility.
`;

const commands = new Map([
  ['setup', 'styleproof-setup.mjs'],
  ['capture', 'styleproof-map.mjs'],
  ['crawl', 'styleproof-capture.mjs'],
  ['compare', 'styleproof-diff.mjs'],
  ['report', 'styleproof-report.mjs'],
  ['variants', 'styleproof-variants.mjs'],
  ['affected', 'styleproof-affected.mjs'],
  ['ci', 'styleproof-ci.mjs'],
  ['prepush', 'styleproof-prepush.mjs'],
  ['publish-report', 'styleproof-publish-report.mjs'],
  ['prune-reports', 'styleproof-prune-reports.mjs'],
  ['prune-maps', 'styleproof-prune-maps.mjs'],
  // Familiar legacy nouns remain accepted without cluttering the primary help.
  ['init', 'styleproof-init.mjs'],
  ['map', 'styleproof-map.mjs'],
  ['diff', 'styleproof-diff.mjs'],
]);

const [command, ...args] = process.argv.slice(2);
if (!command || command === '-h' || command === '--help' || command === 'help') {
  process.stdout.write(HELP);
  process.exit(0);
}

const target = commands.get(command);
if (!target) {
  process.stderr.write(
    `styleproof: unknown command: ${command}\nNext: run styleproof --help to see supported commands.\n`,
  );
  process.exit(2);
}

const result = spawnSync(process.execPath, [path.join(binDir, target), ...args], { stdio: 'inherit' });
if (result.error) {
  process.stderr.write(`styleproof ${command}: ${result.error.message}\n`);
  process.exit(2);
}
process.exit(result.status ?? 2);
