#!/usr/bin/env node
/**
 * The packaged selective-remap verdict: given the files a change touched and a
 * module graph, which declared surfaces could have rendered differently?
 *
 * This is the CLI over `affectedSurfaces` / `explainAffectedSurfaces` — the exact
 * recipe README's "Optional: selective remap (advisory)" documents consumers
 * hand-rolling in a scripts/selective-remap.mjs. The library stays the oracle;
 * this command only assembles its inputs (surface map, dependency-cruiser JSON,
 * `git diff --name-only`) and renders the verdict.
 *
 * Advisory by design: it never captures or gates on its own. Wire the exit code
 * into a pre-push hook or CI step that captures the returned subset and reuses
 * restored base maps for the rest — and let main (or a scheduled run) still
 * capture everything as the trust-but-verify net.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isHelpArg, projectConfigOrExit, showHelpAndExit, unknownFlagMessage } from '../dist/cli-errors.js';
import { affectedSurfaces, classifyStyleChange, explainAffectedSurfaces } from '../dist/affected-surfaces.js';

const HELP = `styleproof-affected — which declared surfaces could this change have restyled?

usage: styleproof-affected --graph <depcruise.json> (--surfaces <json> | --surface k=path ...)
                           (--base <ref> | --changed <path> ...) [options]

inputs (each falls back to the "affected" block of styleproof.config.json, so a
configured repo can run a bare \`styleproof-affected\`):
  --graph <json>      dependency-cruiser JSON for the source tree, e.g.
                        npx depcruise src --no-config --output-type json > dc.json
                      (config: affected.graph)
  --surfaces <json>   JSON file mapping capture key → surface entry module path,
                        { "home": "src/pages/Home.tsx", "pricing": "src/pages/Pricing.tsx" }
                      (config: affected.surfaces, an inline map; --surfaces replaces it)
  --surface <k=path>  one mapping entry inline; repeatable, merges over the rest
  --base <ref>        derive changed files from git: git diff --name-only <ref>...HEAD
                      (config: affected.base)
  --changed <path>    a changed file (repo-relative, as it appears in the graph);
                      repeatable, replaces the git derivation
  --root <dir>        directory the graph's relative paths resolve against, for
                      reading source files during classification (default: cwd)
  --json              print the machine verdict to stdout (explain lines go to stderr)
  -h, --help          show this help

exit codes:
  0  scoped verdict — capture only the listed surfaces, reuse base maps for the rest
  3  unbounded ('all') — some change could not be proven local; re-capture everything
  2  usage error (missing/unreadable inputs)

The verdict fails closed: a global stylesheet or token file, a design-system
config, an unlisted file, or an unbounded dynamic import all yield 'all'.

Examples:
  styleproof-affected --graph dc.json --surfaces styleproof.surfaces.json --base origin/main
  styleproof-affected --graph dc.json --surface home=src/pages/Home.tsx --changed src/components/Nav.tsx --json
`;

const argv = process.argv.slice(2);
let graphPath = '';
let surfacesPath = '';
let baseRef = '';
let root = process.cwd();
let json = false;
const inlineSurfaces = [];
const changedArgs = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (isHelpArg(a)) showHelpAndExit(HELP);
  else if (a === '--graph') graphPath = argv[++i];
  else if (a.startsWith('--graph=')) graphPath = a.slice(8);
  else if (a === '--surfaces') surfacesPath = argv[++i];
  else if (a.startsWith('--surfaces=')) surfacesPath = a.slice(11);
  else if (a === '--surface') inlineSurfaces.push(argv[++i]);
  else if (a.startsWith('--surface=')) inlineSurfaces.push(a.slice(10));
  else if (a === '--base') baseRef = argv[++i];
  else if (a.startsWith('--base=')) baseRef = a.slice(7);
  else if (a === '--changed') changedArgs.push(argv[++i]);
  else if (a.startsWith('--changed=')) changedArgs.push(a.slice(10));
  else if (a === '--root') root = argv[++i];
  else if (a.startsWith('--root=')) root = a.slice(7);
  else if (a === '--json') json = true;
  else {
    console.error(unknownFlagMessage('styleproof-affected', a));
    process.exit(2);
  }
}

function usageError(message) {
  console.error(`styleproof-affected: ${message}`);
  process.exit(2);
}

function readJson(file, what) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    usageError(`could not read ${what} at ${file}\n${e instanceof Error ? e.message : String(e)}`);
  }
}

// The "affected" block of styleproof.config.json is the lowest-precedence layer,
// so a configured repo runs a bare `styleproof-affected` with no flags at all.
const affectedConfig = projectConfigOrExit('styleproof-affected').affected ?? {};
if (!graphPath && affectedConfig.graph) graphPath = affectedConfig.graph;
if (!baseRef && changedArgs.length === 0 && affectedConfig.base) baseRef = affectedConfig.base;

if (!graphPath) usageError('--graph <depcruise.json> is required (or set affected.graph in styleproof.config.json)');
if (!surfacesPath && inlineSurfaces.length === 0 && !affectedConfig.surfaces)
  usageError(
    'provide --surfaces <json>, at least one --surface k=path, or affected.surfaces in styleproof.config.json',
  );
if (!baseRef && changedArgs.length === 0)
  usageError('provide --base <ref>, at least one --changed <path>, or affected.base in styleproof.config.json');

// --surfaces replaces the config map wholesale; inline --surface entries merge on top.
const surfaces = surfacesPath ? readJson(surfacesPath, 'the surfaces map') : { ...(affectedConfig.surfaces ?? {}) };
for (const entry of inlineSurfaces) {
  const eq = entry.indexOf('=');
  if (eq <= 0) usageError(`--surface expects key=path, got '${entry}'`);
  surfaces[entry.slice(0, eq)] = entry.slice(eq + 1);
}
for (const [key, value] of Object.entries(surfaces)) {
  if (typeof value !== 'string' || !value) usageError(`surface '${key}' must map to an entry module path`);
}
if (Object.keys(surfaces).length === 0) usageError('the surfaces map is empty — nothing to prove');

// dependency-cruiser's modules[].dependencies[] maps directly onto ModuleEdge.
const cruise = readJson(graphPath, 'the dependency-cruiser graph');
if (!Array.isArray(cruise?.modules)) {
  usageError(`${graphPath} has no modules[] — expected dependency-cruiser --output-type json`);
}
const graph = cruise.modules.flatMap((m) =>
  (m.dependencies ?? []).map((d) => ({ from: m.source, to: d.resolved, dynamic: d.dynamic })),
);
const files = cruise.modules.map((m) => m.source);

let changedFiles = changedArgs;
if (changedFiles.length === 0) {
  const diff = spawnSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], { cwd: root, encoding: 'utf8' });
  if (diff.status !== 0) {
    usageError(`git diff --name-only ${baseRef}...HEAD failed\n${(diff.stderr || '').trim()}`);
  }
  changedFiles = diff.stdout.split(/\r?\n/).filter(Boolean);
}

const readFile = (p) => fs.readFileSync(path.resolve(root, p), 'utf8');
const result = affectedSurfaces({ changedFiles, surfaces, graph, files, readFile });

// The library doesn't attach a reason to the 'all' sentinel; recover the most
// useful one we can — the first changed file that classifies as unbounded.
let reason;
if (result === 'all') {
  const culprit = changedFiles.find((f) => classifyStyleChange(f, readFile) === 'all');
  if (culprit) reason = `${culprit} could not be proven local (global/config/unreadable)`;
}

const explanation = explainAffectedSurfaces(result, Object.keys(surfaces), reason);
if (json) {
  console.error(explanation);
  const recapture = result === 'all' ? Object.keys(surfaces).sort() : [...result].sort();
  const reuse =
    result === 'all'
      ? []
      : Object.keys(surfaces)
          .filter((k) => !result.has(k))
          .sort();
  console.log(
    JSON.stringify(
      {
        verdict: result === 'all' ? 'all' : 'scoped',
        recapture,
        reuse,
        changed: changedFiles,
        ...(reason ? { reason } : {}),
      },
      null,
      2,
    ),
  );
} else {
  console.log(explanation);
}
process.exit(result === 'all' ? 3 : 0);
