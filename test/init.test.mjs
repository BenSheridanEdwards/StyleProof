import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkTmp, rmTmp } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const INIT = path.join(here, '..', 'bin', 'styleproof-init.mjs');

const runInit = (cwd, args = []) => spawnSync(process.execPath, [INIT, ...args], { cwd, encoding: 'utf8' });
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
    config: /npm run build && npm run start/,
    workflow: [
      /cache: npm/,
      /npm ci/,
      /BenSheridanEdwards\/StyleProof@v4/,
      /baseline-dir: \$\{\{ runner\.temp \}\}\/styleproof-maps\/base/,
      /fresh-dir: \$\{\{ runner\.temp \}\}\/styleproof-maps\/head/,
    ],
    workflowAbsent: [/npx styleproof-map/, /STYLEPROOF_MAP_STORE_TOKEN/],
    hookExec: /exec \.\/node_modules\/\.bin\/styleproof-prepush --spec e2e\/styleproof\.spec\.ts/,
  },
  {
    name: 'Yarn v1 lockfile',
    lockfile: 'yarn.lock',
    config: /npx -y yarn@1\.22\.22 build && npx -y yarn@1\.22\.22 start/,
    workflow: [
      /cache: yarn/,
      /npx -y yarn@1\.22\.22 install --frozen-lockfile --non-interactive/,
      /BenSheridanEdwards\/StyleProof@v4/,
    ],
    absent: [/npm ci/],
    workflowAbsent: [/npx -y yarn@1\.22\.22 styleproof-map/, /STYLEPROOF_MAP_STORE_TOKEN/],
    hookExec: /exec \.\/node_modules\/\.bin\/styleproof-prepush --spec e2e\/styleproof\.spec\.ts/,
  },
  {
    name: 'pnpm lockfile',
    lockfile: 'pnpm-lock.yaml',
    config: /pnpm run build && pnpm run start/,
    workflow: [/cache: pnpm/, /corepack enable/, /pnpm install --frozen-lockfile/, /BenSheridanEdwards\/StyleProof@v4/],
    absent: [/npm ci/],
    workflowAbsent: [/pnpm exec styleproof-map/, /STYLEPROOF_MAP_STORE_TOKEN/],
    hookExec: /exec \.\/node_modules\/\.bin\/styleproof-prepush --spec e2e\/styleproof\.spec\.ts/,
  },
  {
    name: 'Bun lockfile',
    lockfile: 'bun.lock',
    config: /bun run build && bun run start/,
    workflow: [/oven-sh\/setup-bun@v2/, /bun install --frozen-lockfile/, /BenSheridanEdwards\/StyleProof@v4/],
    absent: [/npm ci/],
    workflowAbsent: [/bunx styleproof-map/, /STYLEPROOF_MAP_STORE_TOKEN/],
    hookExec: /exec \.\/node_modules\/\.bin\/styleproof-prepush --spec e2e\/styleproof\.spec\.ts/,
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

      // The restore → capture-on-miss → replay → publish orchestration is ONE
      // packaged command (styleproof-ci), invoked on the installed release with the
      // consumer's bin dir on PATH — the workflow carries no orchestration bash to
      // drift, and no scaffold-time package-manager commands (styleproof-ci detects
      // the lockfile at RUN time, so an npm→pnpm migration needs no re-init). The
      // exit-code triage, cold-path exact-release install, metadata restore, and
      // HAR replay it used to assert here are unit-tested in ci-cli.test.mjs.
      assert.match(
        workflow,
        /PATH="\$PWD\/node_modules\/\.bin:\$PATH" node node_modules\/styleproof\/bin\/styleproof-ci\.mjs --base "\$\{\{ github\.event\.pull_request\.base\.sha \}\}" --head "\$\{\{ github\.event\.pull_request\.head\.sha \}\}" --spec e2e\/styleproof\.spec\.ts --base-dir "\$\{\{ runner\.temp \}\}\/styleproof-maps"/,
      );
      assert.doesNotMatch(workflow, /styleproof-map\.mjs/);
      assert.doesNotMatch(workflow, /"styleproof@\$STYLEPROOF_VERSION"/);
      assert.doesNotMatch(workflow, /playwright install/);
      assert.doesNotMatch(workflow, /echo "capture-needed/); // emitted by styleproof-ci itself now

      // Report branch self-prunes on PR close (out of the box) — manager-independent.
      assert.match(workflow, /types: \[opened, synchronize, reopened, closed\]/);
      assert.match(workflow, /if: github\.event\.action != 'closed'/); // report skips close
      assert.match(workflow, /^\s{2}prune:/m);
      assert.match(workflow, /if: github\.event\.action == 'closed'/);
      assert.match(workflow, /git rm -r --quiet "pr-\$PR"/);

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
    const res = runInit(root, ['--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(res.status, 0, res.stderr);
    const hookPath = path.join(root, '.githooks', 'pre-push');
    assert.match(res.stdout, /created \.githooks\/pre-push/);
    assert.match(res.stdout, /git config core\.hooksPath \.githooks/); // activation hint
    if (process.platform !== 'win32') {
      assert.ok(fs.statSync(hookPath).mode & 0o111, 'hook is executable');
    }
    // Idempotent: a second run leaves an existing hook untouched.
    const rerun = runInit(root, ['--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.match(rerun.stdout, /pre-push already exists — left untouched/);
  } finally {
    rmTmp(root);
  }

  // A husky repo gets the hook in .husky/ instead, and an existing hook survives.
  const husky = mkTmp();
  try {
    fs.mkdirSync(path.join(husky, '.husky'));
    fs.writeFileSync(path.join(husky, '.husky', 'pre-push'), '#!/bin/sh\nnpm test\n');
    const res = runInit(husky, ['--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.existsSync(path.join(husky, '.githooks')), false);
    assert.equal(readFile(husky, '.husky/pre-push'), '#!/bin/sh\nnpm test\n'); // untouched
    assert.match(res.stdout, /pre-push already exists — left untouched/);
  } finally {
    rmTmp(husky);
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
    fs.writeFileSync(path.join(root, '.github', 'workflows', 'styleproof.yml'), 'name: old\n');
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
    assert.match(hook, /exec \.\/node_modules\/\.bin\/styleproof-prepush --spec e2e\/styleproof\.spec\.ts/);
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
