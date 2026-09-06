import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkNonGitTmp, mkTmp, rmTmp } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const INIT = path.join(here, '..', 'bin', 'styleproof-init.mjs');

const runInit = (cwd, args = [], env = {}) =>
  spawnSync(process.execPath, [INIT, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
function touch(root, rel) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '');
}
const readSpec = (root) => fs.readFileSync(path.join(root, 'e2e/styleproof.spec.ts'), 'utf8');
const readFile = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('styleproof-init: imports the routes leaf, not the barrel (keeps the heavy capture graph out of the scaffolder)', () => {
  // styleproof-init only writes files; it must not drag capture/crawler/report
  // and their Playwright-importing modules into its load path. That oversized,
  // concurrently-loaded module graph is what flaked init's tests in CI.
  const src = fs.readFileSync(INIT, 'utf8');
  assert.match(src, /from '\.\.\/dist\/routes\.js'/);
  assert.doesNotMatch(src, /from '\.\.\/dist\/index\.js'/);
});

test('styleproof-init: Next.js app → routes-aware spec wires surfaces + the coverage guard', () => {
  const root = mkTmp();
  try {
    touch(root, 'app/page.tsx');
    touch(root, 'app/about/page.tsx');
    touch(root, 'app/blog/[slug]/page.tsx'); // dynamic → excluded
    const res = runInit(root, ['--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(res.status, 0, res.stderr);
    const spec = readSpec(root);
    assert.match(spec, /import \{ defineStyleMapCapture, discoverNextRoutes, type Surface \}/);
    assert.match(spec, /const ROUTES = discoverNextRoutes\(\);/);
    assert.match(spec, /expected: ROUTES\.map\(\(r\) => r\.key\)/);
    assert.match(spec, /exclude: Object\.fromEntries/);
    assert.match(spec, /inventory: true/); // arms the navigable-removal gate out of the box
    assert.match(res.stdout, /detected 3 Next\.js route\(s\)/);
    assert.match(res.stdout, /1 dynamic route\(s\) excluded/);
  } finally {
    rmTmp(root);
  }
});

test('styleproof-init: non-Next project → crawl-by-default spec (nothing to hand-list)', () => {
  const root = mkTmp();
  try {
    touch(root, 'src/components/Button.tsx');
    const res = runInit(root, ['--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(res.status, 0, res.stderr);
    const spec = readSpec(root);
    assert.doesNotMatch(spec, /discoverNextRoutes/); // not auto-wired, not called
    assert.match(spec, /import \{ defineCrawlCapture \} from 'styleproof'/);
    assert.match(spec, /defineCrawlCapture\(\{/);
    assert.match(spec, /from: '\/'/); // crawl the whole nav from the root
    assert.match(spec, /settle,/); // scroll-reveal hook wired
    assert.match(spec, /viewportHeight: Math\.max\(window\.innerHeight, 1\)/);
    assert.match(spec, /await page\.waitForTimeout\(60\)/); // browser timers cannot deadlock settling
    assert.match(spec, /inventory: true/); // the removal guard is on by default
    assert.match(spec, /dir: process\.env\.STYLEMAP_DIR/);
    assert.doesNotMatch(spec, /key: 'home'/); // no hand-listed surface to maintain
    assert.match(res.stdout, /no Next\.js routes detected/);
    assert.match(res.stdout, /crawl-by-default/);
  } finally {
    rmTmp(root);
  }
});

for (const manager of [
  {
    name: 'npm by default',
    lockfile: null,
    installLine: '- run: npm ci',
    config: /npm run build && npm run start/,
    workflow: [
      /cache: npm/,
      /npm ci/,
      /actions\/upload-artifact@/,
      /--no-upload/,
      /path: \$\{\{ runner\.temp \}\}\/styleproof-maps/,
    ],
    workflowAbsent: [/npx styleproof-map/, /STYLEPROOF_MAP_STORE_TOKEN/, /BenSheridanEdwards\/StyleProof@v6/],
    hookExec: /exec \.\/node_modules\/\.bin\/styleproof-prepush$/m,
  },
  {
    name: 'Yarn v1 lockfile',
    lockfile: 'yarn.lock',
    installLine: '- run: npx -y yarn@1.22.22 install --frozen-lockfile --non-interactive',
    config: /npx -y yarn@1\.22\.22 build && npx -y yarn@1\.22\.22 start/,
    workflow: [
      /cache: yarn/,
      /npx -y yarn@1\.22\.22 install --frozen-lockfile --non-interactive/,
      /actions\/upload-artifact@/,
      /--no-upload/,
    ],
    absent: [/npm ci/],
    workflowAbsent: [
      /npx -y yarn@1\.22\.22 styleproof-map/,
      /STYLEPROOF_MAP_STORE_TOKEN/,
      /BenSheridanEdwards\/StyleProof@v6/,
    ],
    hookExec: /exec \.\/node_modules\/\.bin\/styleproof-prepush$/m,
  },
  {
    name: 'pnpm lockfile',
    lockfile: 'pnpm-lock.yaml',
    installLine: '- run: pnpm install --frozen-lockfile',
    config: /pnpm run build && pnpm run start/,
    workflow: [
      /cache: pnpm/,
      /corepack enable/,
      /pnpm install --frozen-lockfile/,
      /actions\/upload-artifact@/,
      /--no-upload/,
    ],
    absent: [/npm ci/],
    workflowAbsent: [/pnpm exec styleproof-map/, /STYLEPROOF_MAP_STORE_TOKEN/, /BenSheridanEdwards\/StyleProof@v6/],
    hookExec: /exec \.\/node_modules\/\.bin\/styleproof-prepush$/m,
  },
  {
    name: 'Bun lockfile',
    lockfile: 'bun.lock',
    installLine: '- run: bun install --frozen-lockfile',
    config: /bun run build && bun run start/,
    workflow: [/oven-sh\/setup-bun@v2/, /bun install --frozen-lockfile/, /actions\/upload-artifact@/, /--no-upload/],
    absent: [/npm ci/],
    workflowAbsent: [/bunx styleproof-map/, /STYLEPROOF_MAP_STORE_TOKEN/, /BenSheridanEdwards\/StyleProof@v6/],
    hookExec: /exec \.\/node_modules\/\.bin\/styleproof-prepush$/m,
  },
]) {
  test(`styleproof-init: generated commands follow ${manager.name}`, () => {
    const root = mkTmp();
    try {
      if (manager.lockfile) touch(root, manager.lockfile);
      const res = runInit(root, ['--dir', 'e2e/styleproof.spec.ts']);
      assert.equal(res.status, 0, res.stderr);

      const config = readFile(root, 'playwright.styleproof.config.ts');
      assert.match(config, manager.config);

      // Pre-push publish hook is default and a THIN SHIM: it execs the packaged
      // styleproof-prepush (which owns the refspec/docs-only/capture rules and reads
      // git's refspecs from the inherited stdin), so hook behavior ships with each
      // styleproof release instead of drifting in this copied file.
      const hook = readFile(root, '.githooks/pre-push');
      assert.match(hook, manager.hookExec);
      assert.match(hook, /STYLEPROOF_SKIP_CAPTURE/);
      assert.match(hook, /styleproof-init --hook/); // names its own refresh path
      assert.doesNotMatch(hook, /git add/);
      assert.doesNotMatch(hook, /styleproof-map --/); // no inlined capture invocation to drift
      assert.doesNotMatch(hook, /sp_docs_only/);
      assert.match(readFile(root, '.gitignore'), /\.styleproof\//);

      const workflow = readFile(root, '.github/workflows/styleproof.yml');
      const reportWorkflow = readFile(root, '.github/workflows/styleproof-report.yml');
      for (const pattern of manager.workflow) assert.match(workflow, pattern);
      for (const pattern of manager.absent ?? []) assert.doesNotMatch(workflow, pattern);
      for (const pattern of manager.workflowAbsent ?? []) assert.doesNotMatch(workflow, pattern);
      assert.match(reportWorkflow, /BenSheridanEdwards\/StyleProof@v6/);
      assert.match(reportWorkflow, /workflow_run:/);
      const scaffoldCheck = 'node node_modules/styleproof/bin/styleproof-init.mjs --check';
      assert.match(workflow, /- name: Verify StyleProof scaffold matches the installed release/);
      assert.ok(workflow.includes(scaffoldCheck));
      assert.ok(
        workflow.indexOf(manager.installLine) < workflow.indexOf(scaffoldCheck),
        'the installed StyleProof release owns the expected scaffold bytes',
      );
      assert.ok(
        workflow.indexOf(scaffoldCheck) < workflow.indexOf('- id: maps'),
        'scaffold freshness is enforced before capture orchestration',
      );

      // The restore → capture-on-miss → replay orchestration is ONE packaged
      // command (styleproof-ci), invoked on the installed release with the
      // consumer's bin dir on PATH — the untrusted job never publishes.
      assert.match(workflow, /STYLEPROOF_SPEC_PATH_B64: ZTJlL3N0eWxlcHJvb2Yuc3BlYy50cw==/);
      assert.match(
        workflow,
        /styleproof-ci\.mjs --base "\$BASE_SHA" --head "\$HEAD_SHA" --spec-ref-if-missing "\$HEAD_SHA" --base-dir/,
      );
      assert.match(workflow, /--no-upload/);
      assert.doesNotMatch(workflow, /styleproof-map\.mjs/);
      assert.doesNotMatch(workflow, /"styleproof@\$STYLEPROOF_VERSION"/);
      assert.doesNotMatch(workflow, /playwright install/);
      assert.doesNotMatch(workflow, /echo "capture-needed/); // emitted by styleproof-ci itself now

      // Report branch self-prunes on PR close (out of the box) — manager-independent.
      assert.match(workflow, /types: \[opened, synchronize, reopened, closed\]/);
      // The capture job must not fire on the scheduled sweep event.
      assert.match(workflow, /if: github\.event_name == 'pull_request' && github\.event\.action != 'closed'/);
      assert.match(workflow, /^\s{2}prune:/m);
      assert.match(workflow, /if: github\.event_name == 'pull_request' && github\.event\.action == 'closed'/);
      // Report pruning goes through the git-data API; it must never clone the
      // report branch (even bloblessly, push re-fetches the kept blobs).
      assert.match(workflow, /styleproof-prune-reports\.mjs/);
      assert.match(workflow, /--pull-request '\$\{\{ github\.event\.pull_request\.number \}\}'/);
      assert.doesNotMatch(workflow, /git rm -r --quiet "pr-\$PR"/);

      // Daily sweep: retention window plus a hard size budget, oldest-closed
      // first, open PRs never touched. Close-triggered pruning alone cannot
      // bound the branch (missed close events leak; big recent folders blow
      // the budget inside any retention window).
      assert.match(workflow, /schedule:/);
      assert.match(workflow, /^\s{2}report-sweep:/m);
      assert.match(workflow, /if: github\.event_name == 'schedule'/);
      assert.match(workflow, /--retention-days 14/);
      assert.match(workflow, /--budget-bytes 1500000000/);

      // The map store also self-prunes the closed PR's head-SHA folder, but only when
      // that SHA is NOT on the default branch (a ff/rebase merge keeps its base-tip map).
      assert.match(workflow, /Prune this PR's head map from the map store/);
      assert.match(workflow, /BRANCH: styleproof-maps/);
      assert.match(workflow, /compare\/\$HEAD_SHA\.\.\.\$DEFAULT_BRANCH/);
      assert.match(workflow, /ahead\|identical\|behind\|unknown\)/);
      assert.match(workflow, /git rm -r --quiet "\$HEAD_SHA"/);
      assert.match(workflow, /git sparse-checkout set "\$HEAD_SHA"/);
    } finally {
      rmTmp(root);
    }
  });
}

test('styleproof-init: config-only first adoption sources the head harness', () => {
  const root = mkNonGitTmp();
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git(['config', 'user.email', 'styleproof@example.test']);
    git(['config', 'user.name', 'StyleProof Test']);
    fs.writeFileSync(path.join(root, 'package.json'), '{"private":true}\n');
    fs.mkdirSync(path.join(root, 'e2e'), { recursive: true });
    fs.writeFileSync(path.join(root, 'e2e', 'styleproof.spec.ts'), '// existing base spec\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'test: base with spec only']);

    const initialized = runInit(root, ['--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(initialized.status, 0, initialized.stderr);
    git(['add', '-A']);
    git(['commit', '-qm', 'test: head adds dedicated config']);

    const workflow = readFile(root, '.github/workflows/styleproof.yml');
    assert.match(
      workflow,
      /styleproof-ci\.mjs --base "\$BASE_SHA" --head "\$HEAD_SHA" --spec-ref-if-missing "\$HEAD_SHA"/,
    );
    assert.doesNotMatch(workflow, /SPEC_REF_ARGS|git cat-file -e/);
  } finally {
    rmTmp(root);
  }
});

test('styleproof-init: generated scaffold check executes with a shell-hostile custom spec path', () => {
  const root = mkTmp();
  try {
    const specPath = "tests/visual #proof/$draft's.spec.ts";
    const res = runInit(root, ['--dir', specPath]);
    assert.equal(res.status, 0, res.stderr);
    const workflowPath = '.github/workflows/styleproof.yml';
    const workflow = readFile(root, workflowPath);
    const checkCommand = workflow.match(
      /- name: Verify StyleProof scaffold matches the installed release\n\s+shell: bash\n\s+run: \|\n\s+(.+)/,
    )?.[1];
    assert.ok(checkCommand, 'generated workflow contains an executable freshness command');
    const encodedSpecPath = workflow.match(/STYLEPROOF_SPEC_PATH_B64: ([A-Za-z0-9+/]+=*)/)?.[1];
    assert.ok(encodedSpecPath, 'generated workflow carries only encoded spec data');
    const commandEnv = { ...process.env, STYLEPROOF_SPEC_PATH_B64: encodedSpecPath };
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.symlinkSync(path.join(here, '..'), path.join(root, 'node_modules', 'styleproof'), 'dir');

    const clean = spawnSync('/bin/bash', ['-c', checkCommand], { cwd: root, encoding: 'utf8', env: commandEnv });
    assert.equal(clean.status, 0, clean.stderr + clean.stdout);
    assert.match(clean.stdout, /all machine-owned files match/);

    fs.appendFileSync(path.join(root, workflowPath), '# stale release template\n');
    const stale = spawnSync('/bin/bash', ['-c', checkCommand], { cwd: root, encoding: 'utf8', env: commandEnv });
    assert.equal(stale.status, 1, stale.stderr + stale.stdout);
    assert.match(stale.stdout, /stale {4}\.github\/workflows\/styleproof\.yml/);
    assert.match(stale.stdout, /styleproof-init --upgrade/);

    const upgraded = runInit(root, ['--upgrade', '--dir', specPath]);
    assert.equal(upgraded.status, 0, upgraded.stderr);
    const refreshed = spawnSync('/bin/bash', ['-c', checkCommand], { cwd: root, encoding: 'utf8', env: commandEnv });
    assert.equal(refreshed.status, 0, refreshed.stderr + refreshed.stdout);
  } finally {
    rmTmp(root);
  }
});

test('styleproof-init: rejects control characters that would invalidate generated YAML', () => {
  const root = mkTmp();
  try {
    const res = runInit(root, ['--dir', 'tests/visual\u000bproof.spec.ts']);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /--dir spec path must not contain control characters/);
    assert.equal(fs.existsSync(path.join(root, '.github', 'workflows', 'styleproof.yml')), false);
  } finally {
    rmTmp(root);
  }
});

test('styleproof-init: hostile custom spec paths remain encoded data, never generated source', () => {
  const hostileSegments = [
    "single'quote",
    'double"quote',
    'back`tick',
    'command$(touch SHOULD_NOT_EXIST)',
    'expression${{ github.token }}',
    'next\u0085line',
    'line\u2028separator',
    'paragraph\u2029separator',
    '-leading-dash',
    'space and ; metachar',
  ];

  for (const segment of hostileSegments) {
    const root = mkTmp();
    try {
      const specPath = `tests/${segment}/visual.spec.ts`;
      const result = runInit(root, ['--dir', specPath]);
      assert.equal(result.status, 0, `${JSON.stringify(segment)}: ${result.stderr}`);
      const workflow = readFile(root, '.github/workflows/styleproof.yml');
      const hook = readFile(root, '.githooks/pre-push');
      assert.doesNotMatch(workflow, new RegExp(specPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(hook, new RegExp(specPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(workflow, /STYLEPROOF_SPEC_PATH_B64: [A-Za-z0-9+/]+=*/);
      assert.match(hook, /STYLEPROOF_SPEC_PATH_B64='[A-Za-z0-9+/]+=*'/);
      assert.equal(spawnSync('/bin/sh', ['-n', path.join(root, '.githooks/pre-push')]).status, 0);
      assert.equal(fs.existsSync(path.join(root, 'SHOULD_NOT_EXIST')), false);
    } finally {
      rmTmp(root);
    }
  }
});

test('styleproof-init: explicit and config spec paths override encoded scaffold fallback', () => {
  const explicitRoot = mkTmp();
  try {
    const explicit = runInit(explicitRoot, ['--dir', 'safe/explicit.spec.ts'], {
      STYLEPROOF_SPEC_PATH_B64: '***not-base64***',
    });
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.equal(fs.existsSync(path.join(explicitRoot, 'safe', 'explicit.spec.ts')), true);
  } finally {
    rmTmp(explicitRoot);
  }

  const configRoot = mkTmp();
  try {
    assert.equal(runInit(configRoot, ['--dir', 'old/spec.ts']).status, 0);
    fs.writeFileSync(path.join(configRoot, 'styleproof.config.json'), JSON.stringify({ spec: 'new/spec.ts' }));
    const staleFallback = Buffer.from('old/spec.ts', 'utf8').toString('base64');
    const check = runInit(configRoot, ['--check'], { STYLEPROOF_SPEC_PATH_B64: staleFallback });
    assert.equal(check.status, 1, check.stdout + check.stderr);
    const upgrade = runInit(configRoot, ['--upgrade'], { STYLEPROOF_SPEC_PATH_B64: staleFallback });
    assert.equal(upgrade.status, 0, upgrade.stderr);
    assert.match(
      readFile(configRoot, '.github/workflows/styleproof.yml'),
      new RegExp(Buffer.from('new/spec.ts').toString('base64')),
    );
  } finally {
    rmTmp(configRoot);
  }
});

test('styleproof-init: absolute, traversing, and control-bearing spec paths fail before writes', () => {
  for (const specPath of [
    '/tmp/outside.spec.ts',
    '../outside.spec.ts',
    'tests/new\nline.spec.ts',
    'tests/return\r.spec.ts',
  ]) {
    const root = mkTmp();
    try {
      const result = runInit(root, ['--dir', specPath]);
      assert.equal(result.status, 2, JSON.stringify(specPath));
      assert.equal(fs.existsSync(path.join(root, '.github/workflows/styleproof.yml')), false);
    } finally {
      rmTmp(root);
    }
  }
});

test('styleproof-init: untrusted PR capture never receives write credentials', () => {
  const root = mkTmp();
  try {
    const res = runInit(root, ['--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(res.status, 0, res.stderr);

    const captureFile = readFile(root, '.github/workflows/styleproof.yml');
    const report = readFile(root, '.github/workflows/styleproof-report.yml');
    const captureJob = captureFile.slice(captureFile.indexOf('\n  capture:'), captureFile.indexOf('\n  prune:'));
    const pruneJob = captureFile.slice(captureFile.indexOf('\n  prune:'), captureFile.indexOf('\n  report-sweep:'));
    const sweepJob = captureFile.slice(captureFile.indexOf('\n  report-sweep:'));

    // Capture may execute PR-controlled install/capture code. It must stay read-only.
    assert.match(captureFile, /name: StyleProof capture/);
    assert.match(captureFile, /on:\s*\n\s*pull_request:/);
    assert.match(captureJob, /permissions:\s*\n\s*contents: read\s*\n\s*actions: read/);
    assert.doesNotMatch(captureJob, /contents:\s*write/);
    assert.doesNotMatch(captureJob, /issues:\s*write/);
    assert.doesNotMatch(captureJob, /pull-requests:\s*write/);
    assert.doesNotMatch(captureJob, /statuses:\s*write/);
    assert.match(captureJob, /persist-credentials:\s*false/);
    assert.match(captureJob, /styleproof-ci\.mjs[\s\S]*--no-upload/);
    assert.doesNotMatch(captureJob, /BenSheridanEdwards\/StyleProof@v6/);
    assert.match(captureJob, /actions\/upload-artifact@/);
    assert.match(captureJob, /name: styleproof-stylemaps/);

    // Maintenance jobs may write, but they must never check out PR-controlled code.
    assert.match(pruneJob, /contents:\s*write/);
    assert.match(pruneJob, /ref:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/);
    assert.match(sweepJob, /contents:\s*write/);

    // Publication runs later from the default branch and never executes PR code.
    assert.match(report, /name: StyleProof report/);
    assert.match(report, /workflow_run:/);
    assert.match(report, /workflows:\s*\[['"]StyleProof capture['"]\]/);
    assert.match(report, /contents:\s*write/);
    assert.match(report, /pull-requests:\s*write/);
    assert.match(report, /statuses:\s*write/);
    assert.match(report, /actions:\s*read/);
    assert.match(report, /actions\/download-artifact@/);
    assert.match(report, /BenSheridanEdwards\/StyleProof@v6/);
    assert.match(report, /base-capture-failed:/);
    assert.match(report, /styleproof-ci-outputs\.json/);
    assert.doesNotMatch(report, /actions\/checkout@/);
    assert.doesNotMatch(report, /npm ci|pnpm install|yarn install|bun install/);
    assert.doesNotMatch(report, /styleproof-ci\.mjs/);
  } finally {
    rmTmp(root);
  }
});

test('styleproof-init: installs the approval workflow so require-approval is not left inert', () => {
  // The report workflow runs with `require-approval: true`; without the approval
  // handler the "Approve all changes" checkbox can never flip the status green.
  // init must scaffold it (copied verbatim from the packaged example), idempotently.
  const root = mkTmp();
  try {
    const res = runInit(root, ['--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(res.status, 0, res.stderr);

    const approve = readFile(root, '.github/workflows/styleproof-approve.yml');
    const source = readFile(path.join(here, '..'), 'example/styleproof-approve.yml');
    assert.equal(approve, source); // verbatim copy, no drift
    assert.match(approve, /name: StyleProof approve/);
    assert.match(approve, /issue_comment/);
    assert.match(res.stdout, /styleproof-approve\.yml \(approval gate/);

    // Idempotent: a second run leaves an existing workflow untouched.
    const rerun = runInit(root, ['--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.match(rerun.stdout, /styleproof-approve\.yml already exists — left untouched/);
  } finally {
    rmTmp(root);
  }
});

test('styleproof-init: pre-push publish hook — husky-aware, executable, idempotent', () => {
  const root = mkTmp();
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
    const res = runInit(root, ['--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(res.status, 0, res.stderr);
    const hookPath = path.join(root, '.githooks', 'pre-push');
    assert.match(res.stdout, /created \.githooks\/pre-push/);
    assert.match(res.stdout, /activated \.githooks\/pre-push .* via core\.hooksPath/);
    assert.equal(
      spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
      '.githooks',
    );
    if (process.platform !== 'win32') {
      assert.ok(fs.statSync(hookPath).mode & 0o111, 'hook is executable');
    }
    // Idempotent: a second run leaves an existing hook untouched.
    const rerun = runInit(root, ['--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.match(rerun.stdout, /pre-push already exists — left untouched/);
    assert.match(rerun.stdout, /active via core\.hooksPath=\.githooks/);
    const checked = runInit(root, ['--check', '--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /\.githooks\/pre-push is active via core\.hooksPath=\.githooks/);
    const missingBinary = spawnSync('/bin/sh', [hookPath], { cwd: root, encoding: 'utf8', input: '' });
    assert.equal(missingBinary.status, 0, missingBinary.stderr);
    assert.match(missingBinary.stderr, /styleproof-prepush is unavailable; CI will capture on cache miss/);
  } finally {
    rmTmp(root);
  }

  const nonExecutableManaged = mkTmp();
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: nonExecutableManaged }).status, 0);
    const initial = runInit(nonExecutableManaged, ['--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(initial.status, 0, initial.stderr);
    assert.equal(
      spawnSync('git', ['config', '--local', '--unset', 'core.hooksPath'], { cwd: nonExecutableManaged }).status,
      0,
    );
    fs.chmodSync(path.join(nonExecutableManaged, '.githooks', 'pre-push'), 0o644);

    const res = runInit(nonExecutableManaged, ['--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /generated \.githooks\/pre-push is inactive: the hook is not executable/);
    assert.match(res.stderr, /refresh it with: styleproof-init --hook/);
    assert.equal(
      spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: nonExecutableManaged }).status,
      1,
    );
  } finally {
    rmTmp(nonExecutableManaged);
  }

  // A custom hook path is repository-owned: init writes the recoverable shim,
  // reports that it is inactive, and never replaces the configured path.
  const custom = mkTmp();
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: custom }).status, 0);
    assert.equal(spawnSync('git', ['config', '--local', 'core.hooksPath', '.custom-hooks'], { cwd: custom }).status, 0);
    const res = runInit(custom, ['--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readFile(custom, '.githooks/pre-push').includes('styleproof-prepush'), true);
    assert.equal(
      spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], {
        cwd: custom,
        encoding: 'utf8',
      }).stdout.trim(),
      '.custom-hooks',
    );
    assert.match(res.stderr, /generated \.githooks\/pre-push is inactive: core\.hooksPath is \.custom-hooks/);
    assert.match(res.stderr, /git config --local core\.hooksPath \.githooks/);
  } finally {
    rmTmp(custom);
  }

  // Effective global and worktree-scoped paths are just as repository-owned as
  // a local value. Init must not shadow either with a new local setting.
  for (const scope of ['global', 'worktree']) {
    const scoped = mkTmp();
    try {
      assert.equal(spawnSync('git', ['init', '-q'], { cwd: scoped }).status, 0);
      const globalConfig = path.join(scoped, 'global.gitconfig');
      const env = { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' };
      if (scope === 'global') {
        fs.writeFileSync(globalConfig, '[core]\n\thooksPath = .global-hooks\n');
      } else {
        assert.equal(spawnSync('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd: scoped }).status, 0);
        assert.equal(
          spawnSync('git', ['config', '--worktree', 'core.hooksPath', '.worktree-hooks'], { cwd: scoped }).status,
          0,
        );
      }
      const res = runInit(scoped, ['--dir', 'e2e/styleproof.spec.ts'], env);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: scoped }).status, 1);
      assert.match(res.stderr, new RegExp(`core\\.hooksPath is \\.${scope}-hooks`));
    } finally {
      rmTmp(scoped);
    }
  }

  // An active default hook is also repository-owned even with hooksPath unset.
  const defaultHook = mkTmp();
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: defaultHook }).status, 0);
    const defaultHookPath = path.join(defaultHook, '.git', 'hooks', 'pre-push');
    fs.writeFileSync(defaultHookPath, '#!/bin/sh\nnpm test\n');
    fs.chmodSync(defaultHookPath, 0o755);
    const res = runInit(defaultHook, ['--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: defaultHook }).status, 1);
    assert.match(res.stderr, /existing active hook at \.git\/hooks\/pre-push was left unchanged/);
  } finally {
    rmTmp(defaultHook);
  }

  // A husky repo gets the hook in .husky/ instead, and an existing hook survives.
  const husky = mkTmp();
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: husky }).status, 0);
    assert.equal(spawnSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: husky }).status, 0);
    fs.mkdirSync(path.join(husky, '.husky'));
    fs.mkdirSync(path.join(husky, '.husky', '_'));
    fs.writeFileSync(path.join(husky, '.husky', 'pre-push'), '#!/bin/sh\nnpm test\n');
    const huskyShim = path.join(husky, '.husky', '_', 'pre-push');
    fs.writeFileSync(huskyShim, '#!/bin/sh\necho husky\n');
    fs.chmodSync(huskyShim, 0o755);
    const res = runInit(husky, ['--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.existsSync(path.join(husky, '.githooks')), false);
    assert.equal(readFile(husky, '.husky/pre-push'), '#!/bin/sh\nnpm test\n'); // untouched
    assert.match(res.stdout, /pre-push already exists — left untouched/);
    assert.match(res.stdout, /Husky manages hook activation via core\.hooksPath=\.husky\/_/);
    assert.equal(
      spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], {
        cwd: husky,
        encoding: 'utf8',
      }).stdout.trim(),
      '.husky/_',
    );
  } finally {
    rmTmp(husky);
  }

  const inactiveHusky = mkTmp();
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: inactiveHusky }).status, 0);
    assert.equal(spawnSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: inactiveHusky }).status, 0);
    fs.mkdirSync(path.join(inactiveHusky, '.husky'));
    fs.writeFileSync(path.join(inactiveHusky, '.husky', 'pre-push'), '#!/bin/sh\nnpm test\n');
    const res = runInit(inactiveHusky, ['--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /generated \.husky\/pre-push is inactive/);
    assert.match(res.stderr, /active shim does not exist/);
  } finally {
    rmTmp(inactiveHusky);
  }

  const nonExecutableHusky = mkTmp();
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: nonExecutableHusky }).status, 0);
    assert.equal(spawnSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: nonExecutableHusky }).status, 0);
    fs.mkdirSync(path.join(nonExecutableHusky, '.husky', '_'), { recursive: true });
    fs.writeFileSync(path.join(nonExecutableHusky, '.husky', 'pre-push'), '#!/bin/sh\nnpm test\n');
    fs.writeFileSync(path.join(nonExecutableHusky, '.husky', '_', 'pre-push'), '#!/bin/sh\necho husky\n', {
      mode: 0o644,
    });
    const res = runInit(nonExecutableHusky, ['--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /generated \.husky\/pre-push is inactive/);
    assert.match(res.stderr, /active shim is not executable/);
  } finally {
    rmTmp(nonExecutableHusky);
  }

  const missingMatchingHook = mkTmp();
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: missingMatchingHook }).status, 0);
    assert.equal(
      spawnSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: missingMatchingHook }).status,
      0,
    );
    const checked = runInit(missingMatchingHook, ['--check', '--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(checked.status, 1, checked.stderr);
    assert.match(checked.stdout, /missing {2}\.githooks\/pre-push/);
    assert.match(checked.stderr, /Git resolves pre-push there, but the hook does not exist/);
  } finally {
    rmTmp(missingMatchingHook);
  }

  const unmanaged = mkTmp();
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: unmanaged }).status, 0);
    fs.mkdirSync(path.join(unmanaged, '.githooks'));
    fs.writeFileSync(path.join(unmanaged, '.githooks', 'pre-push'), '#!/bin/sh\nnpm test\n');
    const res = runInit(unmanaged, ['--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: unmanaged }).status, 1);
    assert.match(res.stderr, /repository-owned \.githooks\/pre-push was left unchanged and inactive/);
    const checked = runInit(unmanaged, ['--check', '--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /unmanaged \.githooks\/pre-push/);
    assert.match(checked.stderr, /repository-owned \.githooks\/pre-push was left unchanged and inactive/);
  } finally {
    rmTmp(unmanaged);
  }
});

test('styleproof-init: linked worktree activation never changes another worktree', () => {
  const root = mkNonGitTmp('styleproof-hook-main-');
  const linked = `${root}-linked`;
  const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  try {
    assert.equal(git(root, ['config', 'user.email', 'styleproof@example.test']).status, 0);
    assert.equal(git(root, ['config', 'user.name', 'StyleProof Test']).status, 0);
    fs.writeFileSync(path.join(root, 'seed.txt'), 'seed\n');
    assert.equal(git(root, ['add', '-A']).status, 0);
    assert.equal(git(root, ['commit', '-qm', 'test: seed']).status, 0);
    assert.equal(git(root, ['config', 'extensions.worktreeConfig', 'true']).status, 0);
    assert.equal(git(root, ['worktree', 'add', '-q', '-b', 'linked', linked]).status, 0);

    const initialized = runInit(linked, ['--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.equal(git(linked, ['config', '--worktree', '--get', 'core.hooksPath']).stdout.trim(), '.githooks');
    assert.equal(
      git(root, ['config', '--get', 'core.hooksPath']).status,
      1,
      'activating the linked worktree must not change the primary worktree',
    );
  } finally {
    git(root, ['worktree', 'remove', '--force', linked]);
    rmTmp(linked);
    rmTmp(root);
  }
});

test('styleproof-init: a spoofed ownership comment never activates repository-owned hook bytes', () => {
  const root = mkNonGitTmp('styleproof-hook-spoof-');
  try {
    fs.mkdirSync(path.join(root, '.githooks'));
    fs.writeFileSync(
      path.join(root, '.githooks', 'pre-push'),
      '#!/bin/sh\n# StyleProof pre-push\nprintf "repository-owned\\n"\n',
      { mode: 0o755 },
    );
    const initialized = runInit(root, ['--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.equal(spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root }).status, 1);
    assert.match(initialized.stderr, /repository-owned \.githooks\/pre-push was left unchanged and inactive/);
  } finally {
    rmTmp(root);
  }
});

test('styleproof-init: symlinked hook destinations are never followed by init, --hook, --check, or --upgrade', () => {
  const source = mkNonGitTmp('styleproof-hook-bytes-');
  let generatedHook;
  try {
    assert.equal(runInit(source, ['--dir', 'e2e/styleproof.spec.ts']).status, 0);
    const sourceHook = path.join(source, '.githooks', 'pre-push');
    assert.equal(fs.lstatSync(sourceHook).isSymbolicLink(), false);
    generatedHook = fs.readFileSync(sourceHook, 'utf8');
  } finally {
    rmTmp(source);
  }

  for (const args of [
    ['--dir', 'e2e/styleproof.spec.ts'],
    ['--hook', '--dir', 'e2e/styleproof.spec.ts'],
    ['--check', '--dir', 'e2e/styleproof.spec.ts'],
    ['--upgrade', '--dir', 'e2e/styleproof.spec.ts'],
  ]) {
    const root = mkNonGitTmp('styleproof-hook-symlink-');
    const target = `${root}-target`;
    try {
      fs.writeFileSync(target, generatedHook, { mode: 0o755 });
      fs.mkdirSync(path.join(root, '.githooks'));
      fs.symlinkSync(target, path.join(root, '.githooks', 'pre-push'));

      const result = runInit(root, args);
      assert.ok(result.status === 0 || result.status === 1, result.stderr);
      const hookPath = path.join(root, '.githooks', 'pre-push');
      assert.equal(fs.lstatSync(hookPath).isSymbolicLink(), true, args.join(' '));
      assert.equal(fs.readFileSync(target, 'utf8'), generatedHook, args.join(' '));
      assert.equal(
        spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root }).status,
        1,
        `symlinked hook must not activate for ${args.join(' ')}`,
      );
      assert.match(`${result.stdout}\n${result.stderr}`, /unmanaged \.githooks\/pre-push/);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /activated \.githooks\/pre-push/);
    } finally {
      rmTmp(root);
      rmTmp(target);
    }
  }
});

test('styleproof-init: symlinked hook parent directories never redirect generated writes outside the repository', () => {
  for (const hookDir of ['.githooks', '.husky']) {
    for (const args of [
      ['--dir', 'e2e/styleproof.spec.ts'],
      ['--hook', '--dir', 'e2e/styleproof.spec.ts'],
      ['--check', '--dir', 'e2e/styleproof.spec.ts'],
      ['--upgrade', '--dir', 'e2e/styleproof.spec.ts'],
    ]) {
      const root = mkNonGitTmp(`styleproof-${hookDir.slice(1)}-parent-symlink-`);
      const outside = `${root}-outside`;
      try {
        fs.mkdirSync(outside);
        fs.symlinkSync(outside, path.join(root, hookDir));

        const result = runInit(root, args);
        assert.ok(result.status === 0 || result.status === 1, `${hookDir} ${args.join(' ')}: ${result.stderr}`);
        assert.equal(fs.lstatSync(path.join(root, hookDir)).isSymbolicLink(), true);
        assert.equal(
          fs.existsSync(path.join(outside, 'pre-push')),
          false,
          `${hookDir} ${args.join(' ')} wrote through a parent symlink`,
        );
        assert.equal(
          spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root }).status,
          1,
          `${hookDir} ${args.join(' ')} activated an unsafe hook path`,
        );
        assert.match(
          `${result.stdout}\n${result.stderr}`,
          new RegExp(`unmanaged ${hookDir.replace('.', '\\.')}/pre-push`),
        );
        assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /activated .*pre-push/);
      } finally {
        rmTmp(root);
        rmTmp(outside);
      }
    }
  }
});

test('styleproof-init: configured hook status never follows a symlinked generated parent', () => {
  for (const args of [
    ['--dir', 'e2e/styleproof.spec.ts'],
    ['--check', '--dir', 'e2e/styleproof.spec.ts'],
  ]) {
    const root = mkNonGitTmp('styleproof-configured-hook-parent-');
    const outside = mkNonGitTmp('styleproof-configured-hook-parent-outside-');
    try {
      const outsideHook = path.join(outside, 'pre-push');
      fs.writeFileSync(outsideHook, '#!/bin/sh\necho external\n', { mode: 0o755 });
      fs.symlinkSync(outside, path.join(root, '.githooks'));
      assert.equal(spawnSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: root }).status, 0);

      const result = runInit(root, args);
      const expectedStatus = args[0] === '--check' ? 1 : 0;
      assert.equal(result.status, expectedStatus, `${args.join(' ')}: ${result.stderr}`);
      assert.match(`${result.stdout}\n${result.stderr}`, /unmanaged \.githooks\/pre-push/);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /repository-owned \.githooks\/pre-push is active/);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /\.githooks\/pre-push is active via/);
      assert.equal(fs.readFileSync(outsideHook, 'utf8'), '#!/bin/sh\necho external\n');
    } finally {
      rmTmp(root);
      rmTmp(outside);
    }
  }
});

test('styleproof-init: non-directory hook parents fail closed without partial hook writes or activation', () => {
  for (const hookDir of ['.githooks', '.husky']) {
    for (const args of [
      ['--dir', 'e2e/styleproof.spec.ts'],
      ['--hook', '--dir', 'e2e/styleproof.spec.ts'],
      ['--check', '--dir', 'e2e/styleproof.spec.ts'],
      ['--upgrade', '--dir', 'e2e/styleproof.spec.ts'],
    ]) {
      const root = mkNonGitTmp(`styleproof-${hookDir.slice(1)}-parent-file-`);
      const parent = path.join(root, hookDir);
      const original = 'repository-owned parent file\n';
      try {
        fs.writeFileSync(parent, original);

        const result = runInit(root, args);
        assert.ok(result.status === 0 || result.status === 1, `${hookDir} ${args.join(' ')}: ${result.stderr}`);
        assert.equal(fs.lstatSync(parent).isFile(), true);
        assert.equal(fs.readFileSync(parent, 'utf8'), original);
        assert.equal(
          spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root }).status,
          1,
          `${hookDir} ${args.join(' ')} activated through a non-directory parent`,
        );
        assert.match(
          `${result.stdout}\n${result.stderr}`,
          new RegExp(`unmanaged ${hookDir.replace('.', '\\.')}/pre-push`),
        );
        assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /activated .*pre-push/);
      } finally {
        rmTmp(root);
      }
    }
  }
});

test('styleproof-init: unsafe generated destinations are reported as unmanaged during normal init', () => {
  const cases = [
    {
      name: 'spec parent symlink',
      paths: ['e2e/styleproof.spec.ts'],
      setup: (root, outside) => fs.symlinkSync(outside, path.join(root, 'e2e')),
    },
    {
      name: 'config symlink',
      paths: ['playwright.styleproof.config.ts'],
      setup: (root, outside) => {
        const target = path.join(outside, 'config.ts');
        fs.writeFileSync(target, 'repository-owned config\n');
        fs.symlinkSync(target, path.join(root, 'playwright.styleproof.config.ts'));
      },
    },
    {
      name: 'workflow parent symlink',
      paths: ['.github/workflows/styleproof.yml', '.github/workflows/styleproof-approve.yml'],
      setup: (root, outside) => fs.symlinkSync(outside, path.join(root, '.github')),
    },
  ];

  for (const generatedCase of cases) {
    const root = mkNonGitTmp(`styleproof-unmanaged-${generatedCase.name.replaceAll(' ', '-')}-`);
    const outside = mkNonGitTmp(`styleproof-unmanaged-${generatedCase.name.replaceAll(' ', '-')}-outside-`);
    try {
      generatedCase.setup(root, outside);
      const result = runInit(root, ['--dir', 'e2e/styleproof.spec.ts']);
      assert.equal(result.status, 0, `${generatedCase.name}: ${result.stderr}`);
      for (const generatedPath of generatedCase.paths) {
        assert.match(
          `${result.stdout}\n${result.stderr}`,
          new RegExp(`unmanaged ${generatedPath.replaceAll('.', '\\.')} .*unsafe or non-regular`),
        );
        assert.doesNotMatch(
          `${result.stdout}\n${result.stderr}`,
          new RegExp(`${generatedPath.replaceAll('.', '\\.')} already exists`),
        );
      }
    } finally {
      rmTmp(root);
      rmTmp(outside);
    }
  }
});

test('styleproof-init: permission-denied generated parents fail closed without crashes or writes', (t) => {
  if (process.getuid?.() === 0) return t.skip('file modes cannot deny root; run as a non-root user to exercise this');
  const cases = [
    { parent: 'e2e', generated: 'e2e/styleproof.spec.ts' },
    { parent: '.githooks', generated: '.githooks/pre-push' },
    { parent: '.github/workflows', generated: '.github/workflows/styleproof.yml' },
  ];

  for (const generatedCase of cases) {
    const root = mkNonGitTmp(`styleproof-readonly-${generatedCase.parent.replaceAll('/', '-')}-`);
    const parent = path.join(root, generatedCase.parent);
    try {
      fs.mkdirSync(parent, { recursive: true });
      fs.chmodSync(parent, 0o555);
      const result = runInit(root, ['--dir', 'e2e/styleproof.spec.ts']);
      assert.equal(result.status, 0, `${generatedCase.parent}: ${result.stderr}`);
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        new RegExp(`unmanaged ${generatedCase.generated.replaceAll('.', '\\.')} .*unsafe or non-regular`),
      );
      assert.equal(fs.existsSync(path.join(root, generatedCase.generated)), false);
    } finally {
      fs.chmodSync(parent, 0o755);
      rmTmp(root);
    }
  }
});

test('styleproof-init: unreadable or malformed .gitignore bytes remain unchanged and unmanaged', (t) => {
  if (process.getuid?.() === 0) return t.skip('file modes cannot deny root; run as a non-root user to exercise this');
  const cases = [
    { name: 'read-only', bytes: Buffer.from('repository-owned\n'), mode: 0o444 },
    { name: 'invalid-utf8', bytes: Buffer.from([0xff, 0x0a]), mode: 0o644 },
  ];

  for (const gitignoreCase of cases) {
    const root = mkNonGitTmp(`styleproof-gitignore-${gitignoreCase.name}-`);
    const gitignore = path.join(root, '.gitignore');
    try {
      fs.writeFileSync(gitignore, gitignoreCase.bytes, { mode: gitignoreCase.mode });
      const result = runInit(root, ['--dir', 'e2e/styleproof.spec.ts']);
      assert.equal(result.status, 0, `${gitignoreCase.name}: ${result.stderr}`);
      assert.match(`${result.stdout}\n${result.stderr}`, /unmanaged \.gitignore .*unsafe or non-regular/);
      assert.deepEqual(fs.readFileSync(gitignore), gitignoreCase.bytes);
    } finally {
      fs.chmodSync(gitignore, 0o644);
      rmTmp(root);
    }
  }
});

test('styleproof-init: unsafe .gitignore states fail closed without external writes or crashes', () => {
  for (const kind of ['symlink', 'dangling', 'directory']) {
    const root = mkNonGitTmp(`styleproof-gitignore-${kind}-`);
    const outside = mkNonGitTmp(`styleproof-gitignore-${kind}-outside-`);
    const gitignore = path.join(root, '.gitignore');
    const target = path.join(outside, '.gitignore');
    const original = 'repository-owned external ignore\n';
    try {
      if (kind === 'symlink') {
        fs.writeFileSync(target, original);
        fs.symlinkSync(target, gitignore);
      } else if (kind === 'dangling') {
        fs.symlinkSync(target, gitignore);
      } else {
        fs.mkdirSync(gitignore);
        fs.writeFileSync(path.join(gitignore, 'marker.txt'), original);
      }

      const result = runInit(root, ['--dir', 'e2e/styleproof.spec.ts']);
      assert.equal(result.status, 0, `${kind}: ${result.stderr}`);
      assert.match(`${result.stdout}\n${result.stderr}`, /unmanaged \.gitignore/);
      assert.doesNotMatch(result.stdout, /updated \.gitignore/);

      if (kind === 'symlink') assert.equal(fs.readFileSync(target, 'utf8'), original);
      if (kind === 'dangling') assert.equal(fs.existsSync(target), false);
      if (kind === 'directory') assert.equal(fs.readFileSync(path.join(gitignore, 'marker.txt'), 'utf8'), original);
    } finally {
      rmTmp(root);
      rmTmp(outside);
    }
  }
});

test('styleproof-init: malformed default hooks fail closed instead of being shadowed', () => {
  const cases = [
    {
      name: 'malformed executable file',
      setup: (hookPath) => fs.writeFileSync(hookPath, '#!/bin/sh\necho repository-owned\n', { mode: 0o755 }),
    },
    {
      name: 'unreadable hook directory',
      setup: (hookPath) => {
        fs.mkdirSync(hookPath);
        fs.chmodSync(hookPath, 0o000);
      },
    },
    {
      name: 'directory',
      setup: (hookPath) => fs.mkdirSync(hookPath),
    },
    {
      name: 'dangling symlink',
      setup: (hookPath) => fs.symlinkSync(`${hookPath}-missing-target`, hookPath),
    },
  ];

  for (const hookCase of cases) {
    for (const args of [
      ['--dir', 'e2e/styleproof.spec.ts'],
      ['--hook', '--dir', 'e2e/styleproof.spec.ts'],
      ['--upgrade', '--dir', 'e2e/styleproof.spec.ts'],
    ]) {
      const root = mkNonGitTmp(`styleproof-default-${hookCase.name.replaceAll(' ', '-')}-`);
      const hookPath = path.join(root, '.git', 'hooks', 'pre-push');
      try {
        hookCase.setup(hookPath);
        const result = runInit(root, args);
        assert.equal(result.status, 0, `${hookCase.name} ${args.join(' ')}: ${result.stderr}`);
        assert.equal(
          spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: root }).status,
          1,
          `${hookCase.name} ${args.join(' ')} must not set local core.hooksPath`,
        );
        assert.equal(
          spawnSync('git', ['config', '--worktree', '--get', 'core.hooksPath'], { cwd: root }).status,
          1,
          `${hookCase.name} ${args.join(' ')} must not set worktree core.hooksPath`,
        );
        assert.match(
          `${result.stdout}\n${result.stderr}`,
          /(?:existing active hook .*left unchanged|core\.hooksPath left unchanged)/,
        );
      } finally {
        try {
          if (fs.lstatSync(hookPath).isDirectory()) fs.chmodSync(hookPath, 0o755);
        } catch {
          // The dangling-symlink case intentionally has no target to chmod.
        }
        fs.chmodSync(path.join(root, '.git', 'hooks'), 0o755);
        rmTmp(root);
      }
    }
  }
});

test('styleproof-init: malformed default hook parents never activate generated hooks', () => {
  for (const kind of ['file', 'symlink', 'dangling']) {
    const root = mkNonGitTmp(`styleproof-default-parent-${kind}-`);
    const outside = mkNonGitTmp(`styleproof-default-parent-${kind}-outside-`);
    const hooksParent = path.join(root, '.git', 'hooks');
    try {
      fs.rmSync(hooksParent, { recursive: true, force: true });
      if (kind === 'file') {
        fs.writeFileSync(hooksParent, 'repository-owned hooks parent\n');
      } else if (kind === 'symlink') {
        const target = path.join(outside, 'hooks');
        fs.mkdirSync(target);
        fs.symlinkSync(target, hooksParent);
      } else {
        fs.symlinkSync(path.join(outside, 'missing-hooks'), hooksParent);
      }

      const result = runInit(root, ['--dir', 'e2e/styleproof.spec.ts']);
      assert.equal(result.status, 0, `${kind}: ${result.stderr}`);
      assert.equal(
        spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: root }).status,
        1,
        `${kind} must not activate .githooks`,
      );
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /activated \.githooks\/pre-push/);
      assert.match(`${result.stdout}\n${result.stderr}`, /default hook .*core\.hooksPath left unchanged/);
    } finally {
      rmTmp(root);
      rmTmp(outside);
    }
  }
});

test('styleproof-init: ambiguous Git hook resolution fails closed without changing hook config', () => {
  const root = mkNonGitTmp('styleproof-default-ambiguous-');
  const wrapperDir = path.join(root, 'fake-bin');
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  try {
    fs.mkdirSync(wrapperDir);
    fs.writeFileSync(
      path.join(wrapperDir, 'git'),
      `#!/bin/sh
if [ "$1" = "rev-parse" ] && [ "$2" = "--git-path" ] && [ "$3" = "hooks/pre-push" ]; then
  printf '%s\\n%s\\n' '.git/hooks/pre-push' '.git/hooks/another-pre-push'
  exit 0
fi
exec ${realGit} "$@"
`,
      { mode: 0o755 },
    );
    const result = runInit(root, ['--hook', '--dir', 'e2e/styleproof.spec.ts'], {
      PATH: `${wrapperDir}${path.delimiter}${process.env.PATH}`,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: root }).status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /ambiguous active pre-push hook path/);
  } finally {
    rmTmp(root);
  }
});

test('styleproof-init: effective system/global/local/worktree/custom/default/Husky precedence is preserved', () => {
  const root = mkNonGitTmp('styleproof-hook-precedence-');
  const systemConfig = path.join(root, 'system.gitconfig');
  const globalConfig = path.join(root, 'global.gitconfig');
  const configEnv = {
    GIT_CONFIG_SYSTEM: systemConfig,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: undefined,
  };
  const git = (args) => {
    const env = { ...process.env, ...configEnv };
    delete env.GIT_CONFIG_NOSYSTEM;
    return spawnSync('git', args, { cwd: root, encoding: 'utf8', env });
  };
  try {
    fs.writeFileSync(systemConfig, '[core]\n\thooksPath = .system-hooks\n');
    fs.writeFileSync(globalConfig, '');
    const system = runInit(root, ['--dir', 'e2e/styleproof.spec.ts'], configEnv);
    assert.equal(system.status, 0, system.stderr);
    assert.match(system.stderr, /core\.hooksPath is \.system-hooks/);
    assert.equal(git(['config', '--local', '--get', 'core.hooksPath']).status, 1);

    fs.writeFileSync(globalConfig, '[core]\n\thooksPath = .global-hooks\n');
    const global = runInit(root, ['--dir', 'e2e/styleproof.spec.ts'], configEnv);
    assert.equal(global.status, 0, global.stderr);
    assert.match(global.stderr, /core\.hooksPath is \.global-hooks/);
    assert.equal(git(['config', '--local', '--get', 'core.hooksPath']).status, 1);

    assert.equal(git(['config', '--local', 'core.hooksPath', '.githooks']).status, 0);
    const local = runInit(root, ['--dir', 'e2e/styleproof.spec.ts'], configEnv);
    assert.equal(local.status, 0, local.stderr);
    assert.match(local.stdout, /\.githooks\/pre-push is active via core\.hooksPath=\.githooks/);
    assert.equal(git(['config', '--local', '--get', 'core.hooksPath']).stdout.trim(), '.githooks');
    assert.equal(git(['config', '--get', 'core.hooksPath']).stdout.trim(), '.githooks');
  } finally {
    rmTmp(root);
  }

  const defaultHook = mkNonGitTmp('styleproof-hook-default-preserved-');
  try {
    const defaultHookPath = path.join(defaultHook, '.git', 'hooks', 'pre-push');
    const repositoryHook = '#!/bin/sh\necho repository-owned\n';
    fs.writeFileSync(defaultHookPath, repositoryHook, { mode: 0o755 });
    for (const args of [
      ['--dir', 'e2e/styleproof.spec.ts'],
      ['--hook', '--dir', 'e2e/styleproof.spec.ts'],
      ['--upgrade', '--dir', 'e2e/styleproof.spec.ts'],
    ]) {
      const result = runInit(defaultHook, args);
      assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
      assert.equal(fs.readFileSync(defaultHookPath, 'utf8'), repositoryHook, args.join(' '));
      assert.equal(spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: defaultHook }).status, 1);
    }
  } finally {
    rmTmp(defaultHook);
  }

  const worktreeRoot = mkNonGitTmp('styleproof-hook-worktree-precedence-');
  const linked = `${worktreeRoot}-linked`;
  const worktreeGlobal = path.join(worktreeRoot, 'global.gitconfig');
  const worktreeEnv = { GIT_CONFIG_GLOBAL: worktreeGlobal, GIT_CONFIG_NOSYSTEM: '1' };
  const worktreeGit = (cwd, args) =>
    spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...worktreeEnv },
    });
  try {
    fs.writeFileSync(worktreeGlobal, '');
    assert.equal(worktreeGit(worktreeRoot, ['config', 'user.email', 'styleproof@example.test']).status, 0);
    assert.equal(worktreeGit(worktreeRoot, ['config', 'user.name', 'StyleProof Test']).status, 0);
    fs.writeFileSync(path.join(worktreeRoot, 'seed.txt'), 'seed\n');
    assert.equal(worktreeGit(worktreeRoot, ['add', '-A']).status, 0);
    assert.equal(worktreeGit(worktreeRoot, ['commit', '-qm', 'test: seed']).status, 0);
    assert.equal(worktreeGit(worktreeRoot, ['worktree', 'add', '-q', '-b', 'linked-precedence', linked]).status, 0);

    const linkedInit = runInit(linked, ['--dir', 'e2e/styleproof.spec.ts'], worktreeEnv);
    assert.equal(linkedInit.status, 0, linkedInit.stderr);
    assert.equal(
      worktreeGit(linked, ['config', '--get', 'extensions.worktreeConfig']).status,
      1,
      'StyleProof must not auto-enable extensions.worktreeConfig',
    );
    assert.equal(worktreeGit(linked, ['config', '--get', 'core.hooksPath']).status, 1);
  } finally {
    worktreeGit(worktreeRoot, ['worktree', 'remove', '--force', linked]);
    rmTmp(linked);
    rmTmp(worktreeRoot);
  }
});

test('styleproof-init: malformed existing hook paths are preserved without crashing', () => {
  const root = mkNonGitTmp('styleproof-hook-malformed-');
  try {
    fs.mkdirSync(path.join(root, '.githooks', 'pre-push'), { recursive: true });
    const initialized = runInit(root, ['--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.match(initialized.stderr, /unmanaged \.githooks\/pre-push .*hook destination is directory/);
    const checked = runInit(root, ['--check', '--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /unmanaged \.githooks\/pre-push/);
  } finally {
    rmTmp(root);
  }
});

test('styleproof-init --upgrade activates an exact managed hook', () => {
  const root = mkNonGitTmp('styleproof-hook-upgrade-');
  try {
    const initialized = runInit(root, ['--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.equal(spawnSync('git', ['config', '--local', '--unset', 'core.hooksPath'], { cwd: root }).status, 0);

    const upgraded = runInit(root, ['--upgrade', '--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(upgraded.status, 0, upgraded.stderr);
    assert.equal(
      spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
      '.githooks',
    );
  } finally {
    rmTmp(root);
  }
});

test('styleproof-init --check / --upgrade: machine-owned files track the release, user files never touched', () => {
  const root = mkTmp();
  try {
    // Fresh scaffold → everything current, exit 0.
    assert.equal(runInit(root, ['--dir', 'e2e/styleproof.spec.ts']).status, 0);
    const clean = runInit(root, ['--check', '--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(clean.status, 0, clean.stdout);
    assert.match(clean.stdout, /current {2}\.githooks\/pre-push/);
    assert.match(clean.stdout, /all machine-owned files match/);

    // Drift the hook and the workflow (an older release's copies), and edit the
    // USER-owned spec — --check must flag the machine files only.
    const uncertainHook = '#!/bin/sh\n# StyleProof pre-push (generated by styleproof-init).\n# old release hook\n';
    fs.writeFileSync(path.join(root, '.githooks', 'pre-push'), uncertainHook);
    fs.writeFileSync(
      path.join(root, '.github', 'workflows', 'styleproof.yml'),
      'name: StyleProof\n\n# StyleProof CI workflow (generated by styleproof-init).\n# old release workflow\n',
    );
    const specBefore = readFile(root, 'e2e/styleproof.spec.ts') + '// my customization\n';
    fs.writeFileSync(path.join(root, 'e2e/styleproof.spec.ts'), specBefore);

    const drifted = runInit(root, ['--check', '--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(drifted.status, 1, 'drift exits 1 so CI can flag it');
    assert.match(drifted.stdout, /unmanaged \.githooks\/pre-push/);
    assert.match(drifted.stdout, /stale {4}\.github\/workflows\/styleproof\.yml/);
    assert.match(drifted.stdout, /current {2}\.github\/workflows\/styleproof-approve\.yml/);
    assert.match(drifted.stdout, /styleproof-init --upgrade/);
    assert.doesNotMatch(drifted.stdout, /styleproof\.spec\.ts/); // user-owned: not checked
    assert.equal(readFile(root, 'e2e/styleproof.spec.ts'), specBefore, '--check writes nothing');

    // --upgrade refreshes the owned workflow, but uncertain executable bytes are
    // repository-owned until the operator explicitly adopts them with --hook.
    const upgraded = runInit(root, ['--upgrade', '--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(upgraded.status, 0, upgraded.stderr);
    assert.match(upgraded.stdout, /unmanaged \.githooks\/pre-push .*left unchanged/);
    assert.match(upgraded.stdout, /refreshed \.github\/workflows\/styleproof\.yml/);
    assert.match(upgraded.stdout, /current {3}\.github\/workflows\/styleproof-approve\.yml/);
    assert.equal(readFile(root, '.githooks/pre-push'), uncertainHook);
    assert.match(readFile(root, '.github/workflows/styleproof.yml'), /styleproof-ci\.mjs/);
    assert.equal(readFile(root, 'e2e/styleproof.spec.ts'), specBefore, 'user-owned spec untouched');

    // Unmanaged hooks do not make --check red. Explicit adoption closes the loop.
    assert.equal(runInit(root, ['--check', '--dir', 'e2e/styleproof.spec.ts']).status, 0);
    assert.equal(runInit(root, ['--hook', '--dir', 'e2e/styleproof.spec.ts']).status, 0);
    assert.match(readFile(root, '.githooks/pre-push'), /exec \.\/node_modules\/\.bin\/styleproof-prepush/);
  } finally {
    rmTmp(root);
  }

  // A never-scaffolded repo: --check reports the files as missing and exits 1.
  const bare = mkTmp();
  try {
    const res = runInit(bare, ['--check']);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /missing {2}\.githooks\/pre-push/);
    assert.match(res.stdout, /missing {2}\.github\/workflows\/styleproof\.yml/);
  } finally {
    rmTmp(bare);
  }
});

test('styleproof-init --hook: refreshes ONLY the pre-push hook, overwriting a stale copy', () => {
  const root = mkTmp();
  try {
    // A hook installed by an older release: --hook must replace it in place.
    fs.mkdirSync(path.join(root, '.githooks'));
    fs.writeFileSync(path.join(root, '.githooks', 'pre-push'), '#!/bin/sh\n# old styleproof hook\n');
    const res = runInit(root, ['--hook', '--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /refreshed \.githooks\/pre-push/);
    const hook = readFile(root, '.githooks/pre-push');
    // The path is always data, never appended to the executable command.
    assert.match(hook, /STYLEPROOF_SPEC_PATH_B64='ZTJlL3N0eWxlcHJvb2Yuc3BlYy50cw=='/);
    assert.match(hook, /exec \.\/node_modules\/\.bin\/styleproof-prepush$/m);
    assert.doesNotMatch(hook, /--spec/);
    const custom = runInit(root, ['--hook', '--dir', 'tests/visual.spec.ts']);
    assert.equal(custom.status, 0, custom.stderr);
    const customHook = readFile(root, '.githooks/pre-push');
    assert.match(customHook, /STYLEPROOF_SPEC_PATH_B64='dGVzdHMvdmlzdWFsLnNwZWMudHM='/);
    assert.match(customHook, /exec \.\/node_modules\/\.bin\/styleproof-prepush$/m);
    assert.equal(runInit(root, ['--hook', '--dir', 'e2e/styleproof.spec.ts']).status, 0);
    if (process.platform !== 'win32') {
      assert.ok(fs.statSync(path.join(root, '.githooks', 'pre-push')).mode & 0o111, 'hook is executable');
    }
    // --hook writes nothing else: no spec, no config, no workflows.
    assert.equal(fs.existsSync(path.join(root, 'e2e/styleproof.spec.ts')), false);
    assert.equal(fs.existsSync(path.join(root, 'playwright.styleproof.config.ts')), false);
    assert.equal(fs.existsSync(path.join(root, '.github')), false);
  } finally {
    rmTmp(root);
  }
});

test('styleproof-init --upgrade: never overwrites a repository-owned Husky hook', () => {
  const root = mkTmp();
  try {
    fs.mkdirSync(path.join(root, '.husky'));
    const hookPath = path.join(root, '.husky', 'pre-push');
    const repositoryHook = '#!/bin/sh\nnpm test\n';
    fs.writeFileSync(hookPath, repositoryHook);

    const init = runInit(root);
    assert.equal(init.status, 0, init.stderr);
    assert.equal(readFile(root, '.husky/pre-push'), repositoryHook, 'normal init preserves the repository hook');

    const check = runInit(root, ['--check']);
    assert.equal(check.status, 0, check.stdout);
    assert.match(check.stdout, /unmanaged \.husky\/pre-push/);

    const upgrade = runInit(root, ['--upgrade']);
    assert.equal(upgrade.status, 0, upgrade.stderr);
    assert.match(upgrade.stdout, /unmanaged \.husky\/pre-push \(left unchanged/);
    assert.equal(
      readFile(root, '.husky/pre-push'),
      repositoryHook,
      '--upgrade preserves the repository hook byte-for-byte',
    );
  } finally {
    rmTmp(root);
  }
});

test('styleproof-init: Vite projects get a production preview command without needing a start script', () => {
  const root = mkTmp();
  try {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify(
        {
          scripts: { build: 'vite build' },
          devDependencies: { vite: '^6.0.0' },
        },
        null,
        2,
      ),
    );
    const res = runInit(root, ['--dir', 'e2e/styleproof.spec.ts', '--base-url', 'http://127.0.0.1:4173']);
    assert.equal(res.status, 0, res.stderr);

    const config = readFile(root, 'playwright.styleproof.config.ts');
    assert.match(config, /npm run build && npx vite preview --host 127\.0\.0\.1 --port 4173/);
    assert.match(config, /env: \{ PORT: '4173' \}/);
    assert.doesNotMatch(config, /npm run start/);
  } finally {
    rmTmp(root);
  }
});

test('styleproof-init: summary names exactly the files it wrote and leaves package.json byte-identical', () => {
  // Adopters have blamed init for the `styleproof` entry their package manager's
  // install added. init reads package.json but never writes it (or a lockfile); the
  // summary must say so, and the manifest on disk must be untouched.
  const root = mkTmp();
  try {
    const pkg = JSON.stringify({ name: 'app', dependencies: { styleproof: '^3.0.0' } }, null, 2) + '\n';
    fs.writeFileSync(path.join(root, 'package.json'), pkg);
    const res = runInit(root, ['--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(res.status, 0, res.stderr);
    // The summary enumerates only the files init actually wrote…
    assert.match(
      res.stdout,
      /styleproof-init wrote only: e2e\/styleproof\.spec\.ts, playwright\.styleproof\.config\.ts/,
    );
    assert.match(res.stdout, /\.github\/workflows\/styleproof\.yml/);
    // …and states plainly that it did NOT touch package.json / the lockfile.
    assert.match(res.stdout, /did NOT modify package\.json or your lockfile/);
    // The manifest on disk is byte-for-byte what it was before init ran.
    assert.equal(readFile(root, 'package.json'), pkg);
  } finally {
    rmTmp(root);
  }
});

test('styleproof-init: an existing app Playwright config is left alone while StyleProof gets its own config', () => {
  const root = mkTmp();
  try {
    fs.writeFileSync(path.join(root, 'playwright.config.ts'), 'export default {};\n');
    const res = runInit(root, ['--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readFile(root, 'playwright.config.ts'), 'export default {};\n');
    assert.match(readFile(root, 'playwright.styleproof.config.ts'), /Generated by styleproof-init/);
    assert.match(res.stdout, /app playwright\.config exists — left untouched/);
  } finally {
    rmTmp(root);
  }
});
