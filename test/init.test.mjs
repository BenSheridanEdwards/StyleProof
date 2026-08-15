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
      /BenSheridanEdwards\/StyleProof@v6/,
      /baseline-dir: \$\{\{ runner\.temp \}\}\/styleproof-maps\/base/,
      /fresh-dir: \$\{\{ runner\.temp \}\}\/styleproof-maps\/head/,
    ],
    workflowAbsent: [/npx styleproof-map/, /STYLEPROOF_MAP_STORE_TOKEN/],
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
      /BenSheridanEdwards\/StyleProof@v6/,
    ],
    absent: [/npm ci/],
    workflowAbsent: [/npx -y yarn@1\.22\.22 styleproof-map/, /STYLEPROOF_MAP_STORE_TOKEN/],
    hookExec: /exec \.\/node_modules\/\.bin\/styleproof-prepush$/m,
  },
  {
    name: 'pnpm lockfile',
    lockfile: 'pnpm-lock.yaml',
    installLine: '- run: pnpm install --frozen-lockfile',
    config: /pnpm run build && pnpm run start/,
    workflow: [/cache: pnpm/, /corepack enable/, /pnpm install --frozen-lockfile/, /BenSheridanEdwards\/StyleProof@v6/],
    absent: [/npm ci/],
    workflowAbsent: [/pnpm exec styleproof-map/, /STYLEPROOF_MAP_STORE_TOKEN/],
    hookExec: /exec \.\/node_modules\/\.bin\/styleproof-prepush$/m,
  },
  {
    name: 'Bun lockfile',
    lockfile: 'bun.lock',
    installLine: '- run: bun install --frozen-lockfile',
    config: /bun run build && bun run start/,
    workflow: [/oven-sh\/setup-bun@v2/, /bun install --frozen-lockfile/, /BenSheridanEdwards\/StyleProof@v6/],
    absent: [/npm ci/],
    workflowAbsent: [/bunx styleproof-map/, /STYLEPROOF_MAP_STORE_TOKEN/],
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
      for (const pattern of manager.workflow) assert.match(workflow, pattern);
      for (const pattern of manager.absent ?? []) assert.doesNotMatch(workflow, pattern);
      for (const pattern of manager.workflowAbsent ?? []) assert.doesNotMatch(workflow, pattern);
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

      // The restore → capture-on-miss → replay → publish orchestration is ONE
      // packaged command (styleproof-ci), invoked on the installed release with the
      // consumer's bin dir on PATH — the workflow carries no orchestration bash to
      // drift, and no scaffold-time package-manager commands (styleproof-ci detects
      // the lockfile at RUN time, so an npm→pnpm migration needs no re-init). The
      // exit-code triage, cold-path exact-release install, metadata restore, and
      // HAR replay it used to assert here are unit-tested in ci-cli.test.mjs.
      assert.match(workflow, /STYLEPROOF_SPEC_PATH_B64: ZTJlL3N0eWxlcHJvb2Yuc3BlYy50cw==/);
      assert.match(
        workflow,
        /styleproof-ci\.mjs --base "\$BASE_SHA" --head "\$HEAD_SHA" --spec-ref-if-missing "\$HEAD_SHA" --base-dir/,
      );
      assert.doesNotMatch(workflow, /styleproof-map\.mjs/);
      assert.doesNotMatch(workflow, /"styleproof@\$STYLEPROOF_VERSION"/);
      assert.doesNotMatch(workflow, /playwright install/);
      assert.doesNotMatch(workflow, /echo "capture-needed/); // emitted by styleproof-ci itself now

      // Report branch self-prunes on PR close (out of the box) — manager-independent.
      assert.match(workflow, /types: \[opened, synchronize, reopened, closed\]/);
      // The report job must not fire on the scheduled sweep event.
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
    assert.match(res.stdout, /activated \.githooks\/pre-push via core\.hooksPath/);
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
    fs.writeFileSync(
      path.join(root, '.githooks', 'pre-push'),
      '#!/bin/sh\n# StyleProof pre-push (generated by styleproof-init).\n# old release hook\n',
    );
    fs.writeFileSync(
      path.join(root, '.github', 'workflows', 'styleproof.yml'),
      'name: StyleProof\n\n# StyleProof CI workflow (generated by styleproof-init).\n# old release workflow\n',
    );
    const specBefore = readFile(root, 'e2e/styleproof.spec.ts') + '// my customization\n';
    fs.writeFileSync(path.join(root, 'e2e/styleproof.spec.ts'), specBefore);

    const drifted = runInit(root, ['--check', '--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(drifted.status, 1, 'drift exits 1 so CI can flag it');
    assert.match(drifted.stdout, /stale {4}\.githooks\/pre-push/);
    assert.match(drifted.stdout, /stale {4}\.github\/workflows\/styleproof\.yml/);
    assert.match(drifted.stdout, /current {2}\.github\/workflows\/styleproof-approve\.yml/);
    assert.match(drifted.stdout, /styleproof-init --upgrade/);
    assert.doesNotMatch(drifted.stdout, /styleproof\.spec\.ts/); // user-owned: not checked
    assert.equal(readFile(root, 'e2e/styleproof.spec.ts'), specBefore, '--check writes nothing');

    // --upgrade refreshes exactly the drifted machine files; the spec keeps the edit.
    const upgraded = runInit(root, ['--upgrade', '--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(upgraded.status, 0, upgraded.stderr);
    assert.match(upgraded.stdout, /refreshed \.githooks\/pre-push/);
    assert.match(upgraded.stdout, /refreshed \.github\/workflows\/styleproof\.yml/);
    assert.match(upgraded.stdout, /current {3}\.github\/workflows\/styleproof-approve\.yml/);
    assert.match(readFile(root, '.githooks/pre-push'), /exec \.\/node_modules\/\.bin\/styleproof-prepush/);
    assert.match(readFile(root, '.github/workflows/styleproof.yml'), /styleproof-ci\.mjs/);
    assert.equal(readFile(root, 'e2e/styleproof.spec.ts'), specBefore, 'user-owned spec untouched');
    if (process.platform !== 'win32') {
      assert.ok(fs.statSync(path.join(root, '.githooks', 'pre-push')).mode & 0o111, 'hook stays executable');
    }

    // And the loop closes: --check is green again.
    assert.equal(runInit(root, ['--check', '--dir', 'e2e/styleproof.spec.ts']).status, 0);
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
