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
      /npx styleproof-map --restore --sha "\$BASE_SHA" --dir base --base-dir "\$MAP_ROOT" --spec e2e\/styleproof\.spec\.ts/,
      /npx playwright install --with-deps chromium/,
      /npx styleproof-map --spec e2e\/styleproof\.spec\.ts --dir base --base-dir "\$MAP_ROOT" --keep-har --sha "\$BASE_SHA" --upload/,
      /npx styleproof-map --spec e2e\/styleproof\.spec\.ts --dir head --base-dir "\$MAP_ROOT" --sha "\$HEAD_SHA" --upload/,
      /BenSheridanEdwards\/StyleProof@v4/,
      /baseline-dir: \$\{\{ runner\.temp \}\}\/styleproof-maps\/base/,
      /fresh-dir: \$\{\{ runner\.temp \}\}\/styleproof-maps\/head/,
    ],
    hookRestore:
      /npx styleproof-map --restore --sha "\$head_sha" --dir current --base-dir \.styleproof\/maps --spec e2e\/styleproof\.spec\.ts/,
    hookCapture: /npx styleproof-map --spec e2e\/styleproof\.spec\.ts --sha "\$head_sha" --upload/,
  },
  {
    name: 'Yarn v1 lockfile',
    lockfile: 'yarn.lock',
    config: /npx -y yarn@1\.22\.22 build && npx -y yarn@1\.22\.22 start/,
    workflow: [
      /cache: yarn/,
      /npx -y yarn@1\.22\.22 install --frozen-lockfile --non-interactive/,
      /npx -y yarn@1\.22\.22 styleproof-map --restore --sha "\$BASE_SHA" --dir base --base-dir "\$MAP_ROOT" --spec e2e\/styleproof\.spec\.ts/,
      /npx -y yarn@1\.22\.22 playwright install --with-deps chromium/,
      /npx -y yarn@1\.22\.22 styleproof-map --spec e2e\/styleproof\.spec\.ts --dir base --base-dir "\$MAP_ROOT" --keep-har --sha "\$BASE_SHA" --upload/,
      /npx -y yarn@1\.22\.22 styleproof-map --spec e2e\/styleproof\.spec\.ts --dir head --base-dir "\$MAP_ROOT" --sha "\$HEAD_SHA" --upload/,
      /BenSheridanEdwards\/StyleProof@v4/,
    ],
    absent: [/npm ci/],
    hookRestore:
      /npx -y yarn@1\.22\.22 styleproof-map --restore --sha "\$head_sha" --dir current --base-dir \.styleproof\/maps --spec e2e\/styleproof\.spec\.ts/,
    hookCapture: /npx -y yarn@1\.22\.22 styleproof-map --spec e2e\/styleproof\.spec\.ts --sha "\$head_sha" --upload/,
  },
  {
    name: 'pnpm lockfile',
    lockfile: 'pnpm-lock.yaml',
    config: /pnpm run build && pnpm run start/,
    workflow: [
      /cache: pnpm/,
      /corepack enable/,
      /pnpm install --frozen-lockfile/,
      /pnpm exec styleproof-map --restore --sha "\$BASE_SHA" --dir base --base-dir "\$MAP_ROOT" --spec e2e\/styleproof\.spec\.ts/,
      /pnpm exec playwright install --with-deps chromium/,
      /pnpm exec styleproof-map --spec e2e\/styleproof\.spec\.ts --dir base --base-dir "\$MAP_ROOT" --keep-har --sha "\$BASE_SHA" --upload/,
      /pnpm exec styleproof-map --spec e2e\/styleproof\.spec\.ts --dir head --base-dir "\$MAP_ROOT" --sha "\$HEAD_SHA" --upload/,
      /BenSheridanEdwards\/StyleProof@v4/,
    ],
    absent: [/npm ci/],
    hookRestore:
      /pnpm exec styleproof-map --restore --sha "\$head_sha" --dir current --base-dir \.styleproof\/maps --spec e2e\/styleproof\.spec\.ts/,
    hookCapture: /pnpm exec styleproof-map --spec e2e\/styleproof\.spec\.ts --sha "\$head_sha" --upload/,
  },
  {
    name: 'Bun lockfile',
    lockfile: 'bun.lock',
    config: /bun run build && bun run start/,
    workflow: [
      /oven-sh\/setup-bun@v2/,
      /bun install --frozen-lockfile/,
      /bunx styleproof-map --restore --sha "\$BASE_SHA" --dir base --base-dir "\$MAP_ROOT" --spec e2e\/styleproof\.spec\.ts/,
      /bunx playwright install --with-deps chromium/,
      /bunx styleproof-map --spec e2e\/styleproof\.spec\.ts --dir base --base-dir "\$MAP_ROOT" --keep-har --sha "\$BASE_SHA" --upload/,
      /bunx styleproof-map --spec e2e\/styleproof\.spec\.ts --dir head --base-dir "\$MAP_ROOT" --sha "\$HEAD_SHA" --upload/,
      /BenSheridanEdwards\/StyleProof@v4/,
    ],
    absent: [/npm ci/],
    hookRestore:
      /bunx styleproof-map --restore --sha "\$head_sha" --dir current --base-dir \.styleproof\/maps --spec e2e\/styleproof\.spec\.ts/,
    hookCapture: /bunx styleproof-map --spec e2e\/styleproof\.spec\.ts --sha "\$head_sha" --upload/,
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

      // Pre-push publish hook is default, uses the manager's exec form, and never
      // stages maps onto the branch.
      const hook = readFile(root, '.githooks/pre-push');
      assert.match(hook, manager.hookRestore);
      assert.match(hook, manager.hookCapture);
      assert.match(hook, /STYLEPROOF_SKIP_CAPTURE/);
      assert.doesNotMatch(hook, /git add/);
      assert.match(readFile(root, '.gitignore'), /\.styleproof\//);

      const workflow = readFile(root, '.github/workflows/styleproof.yml');
      assert.match(workflow, /STYLEPROOF_MAP_STORE_TOKEN: \$\{\{ github\.token \}\}/);
      for (const pattern of manager.workflow) assert.match(workflow, pattern);
      for (const pattern of manager.absent ?? []) assert.doesNotMatch(workflow, pattern);

      // Report branch self-prunes on PR close (out of the box) — manager-independent.
      assert.match(workflow, /types: \[opened, synchronize, reopened, closed\]/);
      assert.match(workflow, /if: github\.event\.action != 'closed'/); // report skips close
      assert.match(workflow, /^\s{2}prune:/m);
      assert.match(workflow, /if: github\.event\.action == 'closed'/);
      assert.match(workflow, /git rm -r --quiet "pr-\$PR"/);
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
