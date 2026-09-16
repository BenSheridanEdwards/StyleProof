#!/usr/bin/env node
// The unified `styleproof <command>` dispatcher: every noun execs its styleproof-* CLI.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const binDir = path.dirname(fileURLToPath(import.meta.url));

/** group → [noun, styleproof-<script>, one-line help], in help order. */
const GROUPS = {
  start: [['setup', 'setup', 'detect the project and scaffold StyleProof']],
  capture: [
    ['capture', 'map', 'capture this repository state from a StyleProof spec'],
    ['crawl', 'capture', 'capture a URL or crawled application directly'],
    ['variants', 'variants', 'inspect and generate surface variants'],
    ['components', 'components', 'audit component-manifest coverage'],
    ['affected', 'affected', 'resolve surfaces affected by changed source files'],
  ],
  review: [
    ['compare', 'diff', 'compare base and head captures, fail closed by default'],
    ['report', 'report', 'generate a local review report on command'],
  ],
  automation: [
    ['ci', 'ci', 'run the cache-aware CI capture and comparison flow'],
    ['prepush', 'prepush', 'run the render-affecting pre-push capture guard'],
    ['publish-report', 'publish-report', 'publish a generated report for PR review'],
  ],
  maintenance: [
    ['prune-reports', 'prune-reports', 'remove expired published reports'],
    ['prune-maps', 'prune-maps', 'compact the legacy Git-backed map cache'],
  ],
};
// Familiar legacy nouns remain accepted without cluttering the primary help.
const commands = new Map([
  ['init', 'init'],
  ['map', 'map'],
  ['diff', 'diff'],
  ...Object.values(GROUPS).flatMap((entries) => entries.map(([noun, script]) => [noun, script])),
]);

const HELP = [
  'styleproof — deterministic UI evidence from setup to certification',
  '',
  'usage: styleproof <command> [options]',
  ...Object.entries(GROUPS).flatMap(([group, entries]) => [
    '',
    `${group}:`,
    ...entries.map(([noun, , help]) => `  ${noun.padEnd(17)}${help}`),
  ]),
  '',
  'examples:',
  '  styleproof setup',
  '  styleproof capture',
  '  styleproof compare main',
  '  styleproof report main --out styleproof-report',
  '',
  'Run styleproof <command> --help for command-specific options.',
  'Existing styleproof-* commands remain supported for backwards compatibility.',
  '',
].join('\n');

const [command, ...args] = process.argv.slice(2);
if (!command || ['-h', '--help', 'help'].includes(command)) {
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

const result = spawnSync(process.execPath, [path.join(binDir, `styleproof-${target}.mjs`), ...args], {
  stdio: 'inherit',
});
if (result.error) {
  process.stderr.write(`styleproof ${command}: ${result.error.message}\n`);
  process.exit(2);
}
process.exit(result.status ?? 2);
