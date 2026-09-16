#!/usr/bin/env node
// Selective-remap verdict: given the changed files and a module graph, which declared
// surfaces could have rendered differently? Advisory only. Exit 0 = scoped, 3 = unbounded.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectConfigOrExit } from '../dist/cli-errors.js';
import { loadStyleProofConfigWithLocation, resolveStyleProofConfigPath } from '../dist/config.js';
import { affectedSurfaces, classifyStyleChange, explainAffectedSurfaces } from '../dist/affected-surfaces.js';
import { defineCli, fail, gitOutput, readJson } from './cli.mjs';

const NAME = 'styleproof-affected';
const cli = defineCli({
  name: NAME,
  alias: 'affected',
  usage: [
    `${NAME} --graph <depcruise.json> (--surfaces <json> | --surface k=path ...) (--base <ref> | --changed <path> ...) [options]`,
  ],
  summary:
    'Each input falls back to the "affected" block of styleproof.config.json, so a configured repo can run a bare styleproof-affected.',
  flags: {
    graph: { value: 'json', help: 'dependency-cruiser JSON for the source tree (config: affected.graph)' },
    surfaces: {
      value: 'json',
      help: 'JSON file mapping capture key → surface entry module path (config: affected.surfaces)',
    },
    surface: { value: 'k=path', help: 'one mapping entry inline; merges over the rest.', repeat: true },
    base: { value: 'ref', help: 'derive changed files from git diff --name-only <ref>...HEAD (config: affected.base)' },
    changed: {
      value: 'path',
      help: 'a changed file, repo-relative as it appears in the graph; replaces the git derivation.',
      repeat: true,
    },
    root: {
      value: 'dir',
      help: 'the package the verdict is about; config, graph, surfaces, and source files resolve against it',
      default: process.cwd(),
    },
    json: { help: 'print the machine verdict to stdout (explain lines go to stderr)' },
  },
  notes: [
    'exit codes:',
    '  0  scoped verdict — capture only the listed surfaces, reuse base maps for the rest',
    "  3  unbounded ('all') — some change could not be proven local; re-capture everything",
    '  2  usage error (missing/unreadable inputs)',
    '',
    'The verdict fails closed: a global stylesheet or token file, a design-system config,',
    "an unlisted file, or an unbounded dynamic import all yield 'all'.",
  ],
});

const { opts } = cli.parse();
const root = opts.root;
const usageError = (message) => fail(NAME, message);

// The config's "affected" block is the lowest-precedence layer, loaded from --root (monorepo-aware).
const affectedConfig = projectConfigOrExit(NAME, root).affected ?? {};
const { configDir } = loadStyleProofConfigWithLocation(root);
const graphPath = opts.graph || (affectedConfig.graph && resolveStyleProofConfigPath(affectedConfig.graph, configDir));
const baseRef = opts.base || (opts.changed.length === 0 ? affectedConfig.base : '');

if (!graphPath) usageError('--graph <depcruise.json> is required (or set affected.graph in styleproof.config.json)');
if (!opts.surfaces && !opts.surface.length && !affectedConfig.surfaces) {
  usageError(
    'provide --surfaces <json>, at least one --surface k=path, or affected.surfaces in styleproof.config.json',
  );
}
if (!baseRef && !opts.changed.length) {
  usageError('provide --base <ref>, at least one --changed <path>, or affected.base in styleproof.config.json');
}

// --surfaces replaces the config map wholesale; inline --surface entries merge on top.
const surfaces = opts.surfaces
  ? readJson(NAME, path.resolve(root, opts.surfaces), 'the surfaces map')
  : { ...(affectedConfig.surfaces ?? {}) };
for (const entry of opts.surface) {
  const eq = entry.indexOf('=');
  if (eq <= 0) usageError(`--surface expects key=path, got '${entry}'`);
  surfaces[entry.slice(0, eq)] = entry.slice(eq + 1);
}
for (const [key, value] of Object.entries(surfaces)) {
  if (typeof value !== 'string' || !value) usageError(`surface '${key}' must map to an entry module path`);
}
if (Object.keys(surfaces).length === 0) usageError('the surfaces map is empty — nothing to prove');

const cruise = readJson(NAME, path.resolve(root, graphPath), 'the dependency-cruiser graph');
if (!Array.isArray(cruise?.modules))
  usageError(`${graphPath} has no modules[] — expected dependency-cruiser --output-type json`);
const graph = cruise.modules.flatMap((m) =>
  (m.dependencies ?? []).map((d) => ({ from: m.source, to: d.resolved, dynamic: d.dynamic })),
);
const files = cruise.modules.map((m) => m.source);

let changedFiles = opts.changed;
if (changedFiles.length === 0) {
  const diff = spawnSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], { cwd: root, encoding: 'utf8' });
  if (diff.status !== 0) usageError(`git diff --name-only ${baseRef}...HEAD failed\n${(diff.stderr || '').trim()}`);
  changedFiles = diff.stdout.split(/\r?\n/).filter(Boolean);
  // git prints repo-root-relative paths; the graph is --root-relative. Strip the --root
  // prefix (realpath both sides: macOS temp dirs are symlinked); a file outside --root stays unbounded.
  const toplevel = gitOutput(['rev-parse', '--show-toplevel'], root);
  if (toplevel) {
    const realpath = (p) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return path.resolve(p);
      }
    };
    const prefix = path.relative(realpath(toplevel), realpath(root)).split(path.sep).join('/');
    if (prefix) changedFiles = changedFiles.map((f) => (f.startsWith(`${prefix}/`) ? f.slice(prefix.length + 1) : f));
  }
}

const readFile = (p) => fs.readFileSync(path.resolve(root, p), 'utf8');
const result = affectedSurfaces({ changedFiles, surfaces, graph, files, readFile });
const culprit = result === 'all' ? changedFiles.find((f) => classifyStyleChange(f, readFile) === 'all') : undefined;
const reason = culprit && `${culprit} could not be proven local (global/config/unreadable)`;
const explanation = explainAffectedSurfaces(result, Object.keys(surfaces), reason);
if (opts.json) {
  console.error(explanation);
  const keys = Object.keys(surfaces).sort();
  const hit = (k) => result === 'all' || result.has(k);
  const verdict = {
    verdict: result === 'all' ? 'all' : 'scoped',
    recapture: keys.filter(hit),
    reuse: keys.filter((k) => !hit(k)),
    changed: changedFiles,
    ...(reason ? { reason } : {}),
  };
  console.log(JSON.stringify(verdict, null, 2));
} else {
  console.log(explanation);
}
process.exit(result === 'all' ? 3 : 0);
