#!/usr/bin/env node
// Scaffold StyleProof into a project: spec, Playwright config, styleproof.config.ts,
// CI workflow(s), and (with --storage branch) the pre-push hook. User-owned files are
// never overwritten without --force; machine-owned files are refreshed by --upgrade
// and audited by --check. Exit 0 = done, 1 = --check found drift, 2 = usage error.
import fs from 'node:fs';
import path from 'node:path';
// Leaf modules only: init must never load the capture graph.
import { discoverNextRoutes } from '../dist/routes.js';
import { discoverComponentFiles } from '../dist/components.js';
import { validateComponentManifest } from '../dist/component-manifest.js';
import { loadStyleProofConfig } from '../dist/config.js';
import { decodeSpecPathEnv, encodeSpecPath, validateRepoRelativeSpecPath } from './spec-path-env.mjs';
import { detectPackageManager } from './package-manager.mjs';
import { defineCli, errorMessage, fail } from './cli.mjs';
import { ensureGitignoreLines, generatedPathState, readRegularTextFile, writeFileSafe } from './init/files.mjs';
import { hookFilePath, installPrePushHook, reportOrActivateHook } from './init/hooks.mjs';
import {
  APPROVE_WORKFLOW,
  PACKAGE_MANAGERS,
  STYLEPROOF_CONFIG_TEMPLATE,
  ciWorkflow,
  hookTemplate,
  lintArtifactsTemplate,
  playwrightConfigTemplate,
  reportWorkflow,
  specTemplate,
} from './init/templates.mjs';

const NAME = 'styleproof-init';
const DEFAULT_SPEC_PATH = 'e2e/styleproof.spec.ts';
const AXES = {
  workflow: ['single', 'split'],
  storage: ['artifact', 'branch'],
  gate: ['advisory', 'certify', 'review-gate'],
};

const cli = defineCli({
  name: NAME,
  alias: 'init',
  usage: [`${NAME} [options]`],
  flags: {
    dir: { value: 'path', help: `spec output path (default: ${DEFAULT_SPEC_PATH})` },
    'base-url': { value: 'url', help: 'application URL', default: 'http://localhost:3000' },
    'server-command': { value: 'command', help: 'explicit production build/serve command' },
    'external-server': { help: 'do not manage a server; BASE_URL must already be available' },
    'validate-server': { help: 'only validate the server contract, then exit' },
    manifest: { value: 'path', help: 'write a typed starter component manifest' },
    'component-roots': { value: 'dirs', repeat: true, help: 'comma-separated component roots' },
    force: { help: 'overwrite the spec if it already exists' },
    workflow: {
      value: 'layout',
      help: 'single (default): one job captures, diffs, and reports. split: untrusted read-only capture job + trusted workflow_run report stage — required when fork or Dependabot pull requests must publish',
    },
    storage: {
      value: 'mode',
      help: 'artifact (default): maps live and die in the job. branch: cache maps on the styleproof-maps branch and install the pre-push hook',
    },
    mode: {
      value: 'gate',
      help: 'advisory (default): report but never block. certify: fail on any style diff. review-gate: red status until a reviewer approves (adds the approval caller workflow)',
    },
    hook: {
      help: '(re)write ONLY the pre-push hook, overwriting an existing one — the upgrade path after a release changes it',
    },
    upgrade: {
      help: "refresh every machine-owned generated file to this release's templates; never touches the spec or playwright config",
    },
    check: { help: 'report drift between the machine-owned files and this release; exit 1 if any differ' },
  },
  notes: [
    '--upgrade/--check interpolate the spec path into the templates: pass the same',
    '--dir you scaffolded with if your spec is not at the default location.',
    '',
    'What it writes:',
    '  - the spec at --dir (routes-aware in a Next.js app, crawl-by-default elsewhere)',
    '  - playwright.styleproof.config.ts, a dedicated production-build Playwright config',
    '  - styleproof.config.ts and .github/workflows/styleproof.yml',
    '  - with --workflow split: the trusted styleproof-report.yml stage',
    '  - with --mode review-gate: styleproof-approve.yml (active once merged to your default branch)',
    '  - with --storage branch: .githooks/pre-push, activated when no other hook owns the slot',
    '  - with --manifest + --component-roots: a typed starter component manifest',
    '',
    'To capture and diff locally:',
    '  npx styleproof capture   # this commit → the local map cache',
    '  npx styleproof compare   # compare cached base/head maps by commit SHA',
  ],
});

const { opts } = cli.parse();
const force = Boolean(opts.force);
const baseUrl = opts['base-url'];
let serverCommand = opts['server-command'];
let externalServer = Boolean(opts['external-server']);

// Server contract: flag > env (set by the generated workflow) > inference.
if (serverCommand === undefined && !externalServer) {
  const serverMode = process.env.STYLEPROOF_SERVER_MODE;
  if (serverMode === 'external') externalServer = true;
  else if (serverMode === 'custom')
    serverCommand = Buffer.from(process.env.STYLEPROOF_SERVER_COMMAND_B64 ?? '', 'base64').toString('utf8');
}
if (serverCommand !== undefined && (!serverCommand.trim() || serverCommand.includes('\0')))
  fail(NAME, '--server-command requires a non-empty command without NUL bytes');
if (serverCommand !== undefined && externalServer)
  fail(NAME, '--server-command and --external-server are mutually exclusive');

const componentRoots = opts['component-roots'].flatMap((roots) => roots.split(','));
let manifestPath = opts.manifest;
if (Boolean(manifestPath) !== Boolean(componentRoots.length))
  fail(NAME, '--manifest and --component-roots must be provided together');
if (manifestPath) {
  try {
    manifestPath = validateRepoRelativeSpecPath(manifestPath);
    componentRoots.forEach((root, i) => (componentRoots[i] = validateRepoRelativeSpecPath(root.trim())));
  } catch (error) {
    fail(NAME, `invalid component manifest input: ${errorMessage(error)}`);
  }
}

// Spec path: flag > styleproof.config > the hook-encoded env > default.
function configuredSpecPath() {
  try {
    return loadStyleProofConfig().spec;
  } catch (error) {
    const message = errorMessage(error);
    const unloadable =
      error?.code === 'STYLEPROOF_UNLOADABLE_TS' || /could not be evaluated|cannot evaluate/i.test(message);
    return unloadable ? undefined : fail(NAME, message);
  }
}
let specPath;
try {
  specPath = validateRepoRelativeSpecPath(opts.dir ?? configuredSpecPath() ?? decodeSpecPathEnv() ?? DEFAULT_SPEC_PATH);
} catch (error) {
  console.error(`--dir ${errorMessage(error)}`);
  process.exit(2);
}

const hookOnly = Boolean(opts.hook);
let PM = PACKAGE_MANAGERS.npm; // --hook is package-manager agnostic; npm is a placeholder
if (!hookOnly) {
  try {
    PM = PACKAGE_MANAGERS[detectPackageManager(process.cwd(), { allowMissingManifest: true })];
  } catch (error) {
    fail(NAME, errorMessage(error));
  }
}

// Production server inference from package.json: first matching recipe wins.
const SERVER_RECIPES = [
  { when: (has) => has.tool('vite'), serve: (port) => PM.exec(`vite preview --host 127.0.0.1 --port ${port}`) },
  { when: (has) => has.tool('next') && !has.script('start'), serve: (port) => PM.exec(`next start -p ${port}`) },
  { when: (has) => has.script('start'), serve: () => PM.run('start') },
  { when: (has) => has.script('preview'), serve: () => PM.run('preview') },
];
function productionServerCommand() {
  if (externalServer) return undefined;
  if (serverCommand !== undefined) return serverCommand;
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  } catch {
    /* no manifest: nothing to infer from */
  }
  const scriptText = (name) => (typeof pkg.scripts?.[name] === 'string' ? pkg.scripts[name] : '');
  const has = {
    script: (name) => scriptText(name).trim().length > 0,
    tool: (tool) =>
      Boolean(pkg.dependencies?.[tool] ?? pkg.devDependencies?.[tool]) ||
      scriptText('dev').includes(tool) ||
      scriptText('build').includes(tool),
  };
  const recipe = SERVER_RECIPES.find(({ when }) => when(has));
  if (!recipe) return undefined;
  const port = new URL(baseUrl).port || (baseUrl.startsWith('https:') ? '443' : '80');
  return `${has.script('build') ? `${PM.run('build')} && ` : ''}${recipe.serve(port)}`;
}
function productionServerOrExit() {
  const command = productionServerCommand();
  if (!externalServer && command === undefined)
    fail(
      NAME,
      'could not infer a production server command from Next.js, Vite, or package.json scripts.start/scripts.preview.\n' +
        'Next: pass --server-command "<build-and-serve command>", or --external-server when BASE_URL is managed separately.',
    );
  return command;
}
if (opts['validate-server']) {
  productionServerOrExit();
  process.exit(0);
}
const selectedProductionServer = hookOnly ? undefined : productionServerOrExit();

// Scaffold axes: explicit flags > an existing workflow's marker line > which marker-bearing files exist.
const CI_PATH = '.github/workflows/styleproof.yml';
const REPORT_PATH = '.github/workflows/styleproof-report.yml';
const APPROVE_PATH = '.github/workflows/styleproof-approve.yml';
const LINT_ARTIFACTS_PATH = '.github/workflows/styleproof-lint-artifacts.yml';
const MARKERS = {
  ci: '# StyleProof CI workflow',
  report: '# StyleProof report workflow',
  approve: '# StyleProof approval caller',
  lint: '# StyleProof map artifact lint',
  hook: '# StyleProof pre-push',
};
const hasMarker = (file, marker) => Boolean(readRegularTextFile(file)?.includes(marker));
const SCAFFOLD_MARKER_RE =
  /^# styleproof-scaffold: workflow=(single|split) storage=(artifact|branch) gate=(advisory|certify|review-gate)$/m;
const stripScaffoldMarker = (text) => text?.replace(/^# styleproof-scaffold:[^\n]*\n/m, '');

function inferScaffold() {
  for (const file of [CI_PATH, REPORT_PATH]) {
    const match = readRegularTextFile(file)?.match(SCAFFOLD_MARKER_RE);
    if (match) return { workflow: match[1], storage: match[2], gate: match[3] };
  }
  return {
    workflow: hasMarker(REPORT_PATH, MARKERS.report) ? 'split' : 'single',
    storage: hasMarker(hookFilePath(), MARKERS.hook) ? 'branch' : 'artifact',
    gate: hasMarker(APPROVE_PATH, MARKERS.approve) ? 'review-gate' : 'advisory',
  };
}
const inferred = inferScaffold();
const axis = (name, flag) => {
  const value = opts[flag];
  if (value === undefined) return inferred[name];
  if (!AXES[name].includes(value)) fail(NAME, `--${flag} must be one of: ${AXES[name].join(', ')}`);
  return value;
};
const scaffold = {
  workflow: axis('workflow', 'workflow'),
  storage: axis('storage', 'storage'),
  gate: axis('gate', 'mode'),
};

const templates = {
  PM,
  scaffold,
  encodedSpecPath: encodeSpecPath(specPath),
  serverMode: externalServer ? 'external' : serverCommand === undefined ? 'infer' : 'custom',
  encodedServerCommand: serverCommand === undefined ? '' : Buffer.from(serverCommand, 'utf8').toString('base64'),
};
const HOOK = hookTemplate(templates.encodedSpecPath);

if (hookOnly) {
  installPrePushHook(HOOK, { force: true });
  process.exit(0);
}

// Machine-owned files are derived from this release plus init's inputs, so --upgrade may
// rewrite them and --check can diff them. The spec and playwright config are user-owned.
function machineOwnedFiles() {
  const lint = lintArtifactsTemplate();
  return [
    scaffold.storage === 'branch' && { file: hookFilePath(), contents: HOOK, executable: true, marker: MARKERS.hook },
    { file: CI_PATH, contents: ciWorkflow(templates), marker: MARKERS.ci },
    scaffold.workflow === 'split' && { file: REPORT_PATH, contents: reportWorkflow(templates), marker: MARKERS.report },
    scaffold.gate === 'review-gate' && { file: APPROVE_PATH, contents: APPROVE_WORKFLOW, marker: MARKERS.approve },
    lint !== undefined && { file: LINT_ARTIFACTS_PATH, contents: lint, marker: MARKERS.lint },
  ].filter(Boolean);
}
// The hook has no stable ownership marker line, so it is "managed" only when byte-identical.
const isManaged = (entry, existing) =>
  existing !== undefined &&
  (entry.marker === MARKERS.hook ? existing === entry.contents : existing.includes(entry.marker));
const reportHook = (owned, activate) => {
  const hook = owned.find((entry) => entry.marker === MARKERS.hook);
  if (!hook) return;
  const managed = readRegularTextFile(hook.file) === HOOK;
  if (activate && !managed) return;
  reportOrActivateHook(path.dirname(hook.file), hook.file, { activate, managed });
};

/** missing | unmanaged | stale | current, against this release's template. */
function ownedFileState(entry) {
  if (generatedPathState(entry.file).kind === 'missing') return 'missing';
  const existing = readRegularTextFile(entry.file);
  if (!isManaged(entry, existing)) return 'unmanaged';
  return stripScaffoldMarker(existing) === stripScaffoldMarker(entry.contents) ? 'current' : 'stale';
}

if (opts.check) {
  const owned = machineOwnedFiles();
  const CHECK_LINE = {
    missing: (file) => `missing  ${file}`,
    unmanaged: (file) => `unmanaged ${file} (left to the repository owner)`,
    stale: (file) => `stale    ${file}`,
    current: (file) => `current  ${file}`,
  };
  let stale = 0;
  for (const entry of owned) {
    const state = ownedFileState(entry);
    console.log(CHECK_LINE[state](entry.file));
    if (state === 'missing' || state === 'stale') stale++;
  }
  reportHook(owned, false);
  if (stale) {
    console.log(
      `\n${stale} machine-owned file(s) differ from this styleproof release — run: styleproof-init --upgrade`,
    );
    process.exit(1);
  }
  console.log('\nall machine-owned files match this styleproof release');
  process.exit(0);
}

if (opts.upgrade) {
  const owned = machineOwnedFiles();
  for (const entry of owned) {
    const state = ownedFileState(entry);
    if (state === 'unmanaged') {
      console.log(
        `unmanaged ${entry.file} (left unchanged; delete it and rerun --upgrade to adopt the packaged template)`,
      );
    } else if (state === 'current') {
      console.log(`current   ${entry.file}`);
    } else {
      const wrote = writeFileSafe(entry.file, entry.contents, { force: true });
      if (wrote.wrote && entry.executable) fs.chmodSync(entry.file, 0o755);
      if (wrote.wrote) console.log(`${wrote.exists ? 'refreshed' : 'created'} ${entry.file}`);
      else console.log(`unmanaged ${entry.file} (left unchanged; destination is not a regular file)`);
    }
  }
  reportHook(owned, true);
  console.log('\nmachine-owned files now match this styleproof release (spec and playwright config untouched)');
  process.exit(0);
}

// Full scaffold; `touched` names exactly what init wrote.
const touched = [];
function scaffoldFile(file, contents, { force: f = false, note = '', forceHint = false, onWrite } = {}) {
  const result = writeFileSafe(file, contents, { force: f });
  if (result.wrote) {
    touched.push(file);
    console.log(`${result.exists ? 'overwrote' : 'created'} ${file}${note ? ` (${note})` : ''}`);
    onWrite?.();
  } else if (result.unmanaged) {
    console.log(`unmanaged ${file} (left unchanged; generated destination is unsafe or non-regular)`);
  } else {
    console.log(`${file} already exists — left untouched${forceHint ? ' (use --force to overwrite)' : ''}`);
  }
}

if (manifestPath) {
  try {
    const discovered = discoverComponentFiles({ cwd: process.cwd(), roots: componentRoots });
    const manifest = validateComponentManifest(
      { version: 1, components: discovered.map((c) => ({ module: c.path, variants: [{ key: 'default' }] })) },
      { cwd: process.cwd() },
    );
    scaffoldFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      force,
      note: `${discovered.length} component file(s)`,
      forceHint: true,
    });
  } catch (error) {
    fail(NAME, errorMessage(error));
  }
}

const routes = discoverNextRoutes(process.cwd());
const isNext = routes.length > 0;
scaffoldFile(specPath, specTemplate(isNext), {
  force,
  forceHint: true,
  onWrite: () => {
    if (isNext) {
      const dynamic = routes.filter((r) => r.dynamic).length;
      console.log(
        `  detected ${routes.length} Next.js route(s) — wired surfaces + the \`expected\` coverage guard to them` +
          (dynamic ? ` (${dynamic} dynamic route(s) excluded pending a concrete param)` : ''),
      );
    } else {
      console.log('  no Next.js routes detected — wrote a crawl-by-default spec that captures every');
      console.log('  surface your nav links to from / (nothing to hand-list; the inventory guard is on)');
    }
  },
});

scaffoldFile(
  'playwright.styleproof.config.ts',
  playwrightConfigTemplate({ specPath, baseUrl, command: selectedProductionServer }),
  {
    force,
    note: 'dedicated StyleProof capture config',
    forceHint: true,
  },
);
if (fs.existsSync('playwright.config.ts') || fs.existsSync('playwright.config.js'))
  console.log(
    'app playwright.config exists — left untouched; styleproof-map uses playwright.styleproof.config.ts by default',
  );
scaffoldFile('styleproof.config.ts', STYLEPROOF_CONFIG_TEMPLATE, { note: 'typed config with defineConfig()' });

// Current (.styleproof/) plus legacy map artifact patterns.
const gitignore = ensureGitignoreLines([
  '.styleproof/',
  'styleproof-audit.json',
  'stylemaps/',
  '__stylemaps__/',
  'test-results/',
  'playwright-report/',
]);
if (gitignore.unmanaged)
  console.log('unmanaged .gitignore (left unchanged; generated destination is unsafe or non-regular)');
else if (gitignore.added.length) {
  touched.push('.gitignore');
  console.log(`updated .gitignore (${gitignore.added.join(', ')})`);
}

scaffoldFile(CI_PATH, ciWorkflow(templates), {
  note: scaffold.workflow === 'split' ? 'read-only StyleProof PR capture' : 'one-job StyleProof PR gate',
});
if (scaffold.workflow === 'split')
  scaffoldFile(REPORT_PATH, reportWorkflow(templates), { note: 'trusted StyleProof report stage' });
if (scaffold.gate === 'review-gate')
  scaffoldFile(APPROVE_PATH, APPROVE_WORKFLOW, { note: 'approval gate — active once merged to your default branch' });
const lint = lintArtifactsTemplate();
if (lint !== undefined)
  scaffoldFile(LINT_ARTIFACTS_PATH, lint, { note: 'artifact-branch guard — fails PR if maps are committed' });
if (scaffold.storage === 'branch') {
  const hook = installPrePushHook(HOOK);
  if (hook.wrote) touched.push(hook.hookPath);
}

if (touched.length) {
  console.log(`\nstyleproof-init wrote only: ${touched.join(', ')}`);
  console.log('It did NOT modify package.json or your lockfile (that was your package manager’s install).');
}

const GATE_NOTE = {
  advisory:
    'reports but never blocks. When the signal proves out, re-scaffold with --mode certify or --mode review-gate.',
  certify: 'fails the job on any style diff.',
  'review-gate': 'sets a red status until a reviewer ticks "Approve all changes".',
};
const HOW = {
  split: [
    '  1. Merge this scaffold PR first. workflow_run report + approve only run from your',
    '     default branch — the first PR captures maps but cannot publish the trusted report',
    '     until styleproof-report.yml (and styleproof-approve.yml) are on default.',
    '  2. On later PRs, the read-only capture workflow installs and captures under',
    '     contents: read only, then uploads style maps as an artifact.',
    '  3. The trusted default-branch report workflow downloads that artifact, diffs,',
    '     comments, and sets status — without ever checking out PR-controlled code.',
  ],
  single: [
    '  1. One job per pull request: capture base and head maps in place, diff them,',
    '     and publish the report — no second workflow, no map-store branch.',
    '  2. Forked pull requests get a read-only token and cannot publish; if you accept',
    '     fork or Dependabot PRs, re-scaffold with --workflow split.',
  ],
};
console.log('\nHow the gate works:');
for (const line of HOW[scaffold.workflow]) console.log(line);
if (scaffold.storage === 'branch') {
  console.log('  The pre-push hook can still restore or publish exact-SHA maps to styleproof-maps.');
  console.log('  Skip a push that cannot affect render: STYLEPROOF_SKIP_CAPTURE=1 git push');
}
console.log(`  Gate mode: ${scaffold.gate} — ${GATE_NOTE[scaffold.gate]}`);
console.log('');
console.log('  Maps should NEVER be committed to a PR branch. They travel via the styleproof-maps');
console.log('  branch (--storage branch) or job-local dirs — committed maps bloat the repo and');
console.log('  force cross-PR rebases.');
if (!touched.length) console.log('\nnothing to write — project already scaffolded.');
