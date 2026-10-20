#!/usr/bin/env node
// Scaffold StyleProof into a project: spec, Playwright config, styleproof.config.ts,
// and CI workflow(s). User-owned files are
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
import { defineCli, errorMessage, fail, gitOutput } from './cli.mjs';
import { ensureGitignoreLines, generatedPathState, readRegularTextFile, writeFileSafe } from './init/files.mjs';
import { findStyleProofHooks, reportObsoleteHooks, retireObsoleteHooks } from './init/obsolete-hooks.mjs';
import {
  APPROVE_WORKFLOW,
  PACKAGE_MANAGERS,
  ciWorkflow,
  lintArtifactsTemplate,
  playwrightConfigTemplate,
  reportWorkflow,
  specTemplate,
  styleproofConfigTemplate,
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
      help: 'artifact (default): maps live and die in the job. branch: cache maps on the styleproof-maps branch and publish default-branch maps from CI',
    },
    mode: {
      value: 'gate',
      help: 'advisory (default): report but never block. certify: fail on any style diff. review-gate: red status until a reviewer approves (adds the approval caller workflow)',
    },
    hook: { help: 'removed in 8.0.0: StyleProof runs in CI; --upgrade removes an old hook' },
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
    '  - with --storage branch: a publish-base job that publishes default-branch maps',
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

// Spec path: flag > styleproof.config > the workflow-encoded env > default.
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

if (opts.hook)
  fail(
    NAME,
    'The pre-push hook was removed in 8.0.0. StyleProof runs in CI. Run `styleproof-init --upgrade` to remove an old hook.',
  );
let PM;
try {
  PM = PACKAGE_MANAGERS[detectPackageManager(process.cwd(), { allowMissingManifest: true })];
} catch (error) {
  fail(NAME, errorMessage(error));
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
const selectedProductionServer = productionServerOrExit();

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
};
const hasMarker = (file, marker) => Boolean(readRegularTextFile(file)?.includes(marker));
const BRANCH_NAME = '[A-Za-z0-9._/-]+';
const SCAFFOLD_MARKER_RE = new RegExp(
  `^# styleproof-scaffold: workflow=(single|split) storage=(artifact|branch) gate=(advisory|certify|review-gate)(?: branch=(${BRANCH_NAME}))?$`,
  'm',
);
const stripScaffoldMarker = (text) => text?.replace(/^# styleproof-scaffold:[^\n]*\n/m, '');

function inferScaffold() {
  for (const file of [CI_PATH, REPORT_PATH]) {
    const match = readRegularTextFile(file)?.match(SCAFFOLD_MARKER_RE);
    if (match) return { workflow: match[1], storage: match[2], gate: match[3], branch: match[4] };
  }
  return {
    workflow: hasMarker(REPORT_PATH, MARKERS.report) ? 'split' : 'single',
    // A hook from before 8.0.0 still marks a pre-v7 branch-storage scaffold.
    storage: findStyleProofHooks().some((hook) => hook.kind === 'generated') ? 'branch' : 'artifact',
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
// The remote's default branch, else main. Only a name safe inside YAML quotes is used.
function defaultBranch() {
  const remoteHead = gitOutput(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])?.replace(
    /^origin\//,
    '',
  );
  return remoteHead && new RegExp(`^${BRANCH_NAME}$`).test(remoteHead) ? remoteHead : 'main';
}
const scaffold = {
  workflow: axis('workflow', 'workflow'),
  storage: axis('storage', 'storage'),
  gate: axis('gate', 'mode'),
  branch: inferred.branch ?? defaultBranch(),
};

const templates = {
  PM,
  scaffold,
  encodedSpecPath: encodeSpecPath(specPath),
  serverMode: externalServer ? 'external' : serverCommand === undefined ? 'infer' : 'custom',
  encodedServerCommand: serverCommand === undefined ? '' : Buffer.from(serverCommand, 'utf8').toString('base64'),
};

// Machine-owned files are derived from this release plus init's inputs, so --upgrade may
// rewrite them and --check can diff them. The spec and playwright config are user-owned.
function machineOwnedFiles() {
  const lint = lintArtifactsTemplate();
  return [
    { file: CI_PATH, contents: ciWorkflow(templates), marker: MARKERS.ci },
    scaffold.workflow === 'split' && { file: REPORT_PATH, contents: reportWorkflow(templates), marker: MARKERS.report },
    scaffold.gate === 'review-gate' && { file: APPROVE_PATH, contents: APPROVE_WORKFLOW, marker: MARKERS.approve },
    lint !== undefined && { file: LINT_ARTIFACTS_PATH, contents: lint, marker: MARKERS.lint },
  ].filter(Boolean);
}
const isManaged = (entry, existing) => existing !== undefined && existing.includes(entry.marker);

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
  stale += reportObsoleteHooks();
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
  // Only byte-identical files count as current: rewriting an unmarked pre-v7 file
  // records its inferred axes, which the retired hook no longer signals.
  for (const entry of owned) {
    const state = ownedFileState(entry);
    if (state === 'unmanaged') {
      console.log(
        `unmanaged ${entry.file} (left unchanged; delete it and rerun --upgrade to adopt the packaged template)`,
      );
    } else if (readRegularTextFile(entry.file) === entry.contents) {
      console.log(`current   ${entry.file}`);
    } else {
      const wrote = writeFileSafe(entry.file, entry.contents, { force: true });
      if (wrote.wrote) console.log(`${wrote.exists ? 'refreshed' : 'created'} ${entry.file}`);
      else console.log(`unmanaged ${entry.file} (left unchanged; destination is not a regular file)`);
    }
  }
  retireObsoleteHooks();
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
// Ancestor-reuse roots, written for both storage modes: reuse only runs with branch
// storage, but the config is user-owned and never re-scaffolded, so a later switch to
// --storage branch keeps accurate roots. Source dirs (app/pages: Next.js routers;
// components/lib: root-level UI code; styles/public: global CSS and rendered assets),
// root CSS-tool and framework/bundler configs (they change compiled output), root
// compiler/transpiler configs (tsconfig.json, tsconfig.*.json, jsconfig.json:
// path aliases and JSX settings; babel.config.*, .babelrc*; .browserslistrc:
// autoprefixed CSS), root stylesheets, and a Vite-style index.html. Roots match a directory prefix or an exact
// file path, so config files work as roots. Roots decide baseline correctness, so init
// fails safe and writes no roots (every changed path counts) when it cannot bound the
// render inputs: in a workspace monorepo, whose shared packages it cannot bound; below the
// git repository root, where sibling inputs outside the cwd cannot be bounded; or when
// any top-level entry is neither a detected root nor known not to affect rendering.
// Symlinks and submodules are never classified: their content lives elsewhere.
// Markers are searched from the cwd up to the git repository root (the filesystem root
// outside git), so init inside a workspace package finds them.
const ANCESTOR_ROOT_DIRS = ['src', 'app', 'pages', 'styles', 'public', 'components', 'lib'];
const ANCESTOR_ROOT_FILE =
  /^(?:(?:tailwind|postcss|next|vite|svelte|astro|nuxt|remix|webpack)\.config\.[cm]?[jt]s|tsconfig(?:\..+)?\.json|jsconfig\.json|babel\.config\.(?:[cm]?[jt]s|json)|\.babelrc(?:\.(?:[cm]?[jt]s|json))?|\.browserslistrc|.+\.(?:css|scss|sass|less)|index\.html)$/s;
// Top-level entries known not to affect rendering. Keep this conservative: a name left
// out only costs reuse, a wrong name here lets a stale baseline through. .env* is
// deliberately absent: env can change rendering. So are docs/test dirs and Markdown: an
// app can import a stylesheet from docs/ or e2e/, or render a README. Every manifest and
// lockfile here is one the runtime counts as always relevant (src/ancestor-baseline.ts).
const NON_RENDER_DIRS = new Set([
  // VCS, CI, editor and release tooling
  '.git',
  '.github',
  '.gitlab',
  '.vscode',
  '.idea',
  '.husky',
  '.changeset',
  // test reports
  'playwright-report',
  'test-results',
  'coverage',
  // StyleProof's own output
  '.styleproof',
]);
const NON_RENDER_FILE =
  /^(?:styleproof\.config\..+|playwright(?:\.styleproof)?\.config\..+|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|\.gitignore|\.gitattributes|\.editorconfig|\.nvmrc|\.node-version|\.npmrc|\.eslintrc.*|eslint\.config\..+|\.eslintignore|\.prettierrc.*|prettier\.config\..+|\.prettierignore|\.stylelintrc.*|stylelint\.config\..+|commitlint\.config\..+|\.lintstagedrc.*|next-env\.d\.ts|(?:vitest|jest)\.config\..+|Dockerfile|\.dockerignore)$/;
// The spec's top-level entry: its own directory (always capture-relevant) or the spec file.
const specEntry = specPath.split('/').length <= 2 ? specPath.split('/')[0] : undefined;
// The entries git would see (tracked plus untracked-not-ignored), else the directory listing.
function topLevelEntries() {
  const listed = gitOutput(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  const names =
    listed === undefined
      ? fs.readdirSync('.').filter((name) => name !== 'node_modules' && name !== '.git')
      : listed.split('\0').map((file) => file.split('/')[0]);
  return [...new Set(names)].filter(Boolean).sort();
}
const WORKSPACE_MARKERS = ['pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json'];
const isDirectory = (p) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
function workspaceMarkerIn(dir) {
  try {
    if (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).workspaces)
      return 'package.json "workspaces"';
  } catch {
    /* no or unreadable manifest: fall through to the marker files */
  }
  return WORKSPACE_MARKERS.find((file) => fs.existsSync(path.join(dir, file)));
}
const realCwd = fs.realpathSync(process.cwd());
const gitRoot = gitOutput(['rev-parse', '--show-toplevel']);
const realGitRoot = gitRoot === undefined ? undefined : fs.realpathSync(gitRoot);
function workspaceMarker() {
  for (let dir = realCwd; ; dir = path.dirname(dir)) {
    const marker = workspaceMarkerIn(dir);
    if (marker) return dir === realCwd ? marker : `${marker} at ${path.relative(realCwd, dir)}`;
    if (dir === realGitRoot || dir === path.dirname(dir)) return undefined;
  }
}
const ancestorWorkspace = workspaceMarker();
const belowGitRoot = realGitRoot !== undefined && realGitRoot !== realCwd;
const skipRoots = Boolean(ancestorWorkspace) || belowGitRoot;
// Gitlinks (submodules, mode 160000) in the index, whether or not they are checked out.
const gitlinks = new Set(
  (gitOutput(['ls-files', '-s', '-z']) ?? '')
    .split('\0')
    .filter((record) => record.startsWith('160000 '))
    .map((record) => record.slice(record.indexOf('\t') + 1).split('/')[0]),
);
// A symlink or submodule (gitlink, or a directory holding its own .git) points at content
// outside this tree, so it is never a detected root nor known not to render.
const isOpaque = (name) =>
  fs.lstatSync(name, { throwIfNoEntry: false })?.isSymbolicLink() ||
  gitlinks.has(name) ||
  (isDirectory(name) && fs.lstatSync(path.join(name, '.git'), { throwIfNoEntry: false }) !== undefined);
const detectedRoots = skipRoots
  ? []
  : [
      ...ANCESTOR_ROOT_DIRS.filter(isDirectory),
      ...fs
        .readdirSync('.', { withFileTypes: true })
        .filter((entry) => entry.isFile() && ANCESTOR_ROOT_FILE.test(entry.name))
        .map((entry) => entry.name)
        .sort(),
    ].filter((name) => !isOpaque(name));
const unclassifiedEntries = skipRoots
  ? []
  : topLevelEntries().filter(
      (name) =>
        isOpaque(name) ||
        (!detectedRoots.includes(name) &&
          name !== specEntry &&
          !(isDirectory(name) ? NON_RENDER_DIRS.has(name) : NON_RENDER_FILE.test(name))),
    );
const ancestorRoots = unclassifiedEntries.length ? [] : detectedRoots;
scaffoldFile(
  'styleproof.config.ts',
  styleproofConfigTemplate(ancestorRoots, ancestorWorkspace, unclassifiedEntries, belowGitRoot),
  {
    note: 'typed config with defineConfig()',
  },
);

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
  console.log(`  publish-base publishes each commit pushed to '${scaffold.branch}' to styleproof-maps;`);
  console.log('  to use another default branch, edit branch= in the workflow marker and run --upgrade.');
  console.log('  Reports publish to the styleproof-reports branch — the comment links a rendered report.');
} else {
  console.log('  Reports upload as bounded-retention workflow artifacts — nothing enters git history.');
}
console.log(`  Gate mode: ${scaffold.gate} — ${GATE_NOTE[scaffold.gate]}`);
console.log('');
console.log('  Maps should NEVER be committed to a PR branch. They travel via the styleproof-maps');
console.log('  branch (--storage branch) or job-local dirs — committed maps bloat the repo and');
console.log('  force cross-PR rebases.');
if (!touched.length) console.log('\nnothing to write — project already scaffolded.');
