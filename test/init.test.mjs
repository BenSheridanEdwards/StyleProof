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
      /npx styleproof-map --restore --sha "\$BASE_SHA" --dir base --base-dir __stylemaps__ --spec e2e\/styleproof\.spec\.ts/,
      /npx styleproof-map --spec e2e\/styleproof\.spec\.ts --dir head --base-dir __stylemaps__ --no-upload/,
      /BenSheridanEdwards\/StyleProof@v3/,
      /baseline-dir: __stylemaps__\/base/,
      /fresh-dir: __stylemaps__\/head/,
    ],
  },
  {
    name: 'Yarn v1 lockfile',
    lockfile: 'yarn.lock',
    config: /npx -y yarn@1\.22\.22 build && npx -y yarn@1\.22\.22 start/,
    workflow: [
      /cache: yarn/,
      /npx -y yarn@1\.22\.22 install --frozen-lockfile --non-interactive/,
      /npx -y yarn@1\.22\.22 styleproof-map --restore --sha "\$BASE_SHA" --dir base --base-dir __stylemaps__ --spec e2e\/styleproof\.spec\.ts/,
      /npx -y yarn@1\.22\.22 styleproof-map --spec e2e\/styleproof\.spec\.ts --dir head --base-dir __stylemaps__ --no-upload/,
      /BenSheridanEdwards\/StyleProof@v3/,
    ],
    absent: [/npm ci/],
  },
  {
    name: 'pnpm lockfile',
    lockfile: 'pnpm-lock.yaml',
    config: /pnpm run build && pnpm run start/,
    workflow: [
      /cache: pnpm/,
      /corepack enable/,
      /pnpm install --frozen-lockfile/,
      /pnpm exec styleproof-map --restore --sha "\$BASE_SHA" --dir base --base-dir __stylemaps__ --spec e2e\/styleproof\.spec\.ts/,
      /pnpm exec styleproof-map --spec e2e\/styleproof\.spec\.ts --dir head --base-dir __stylemaps__ --no-upload/,
      /BenSheridanEdwards\/StyleProof@v3/,
    ],
    absent: [/npm ci/],
  },
  {
    name: 'Bun lockfile',
    lockfile: 'bun.lock',
    config: /bun run build && bun run start/,
    workflow: [
      /oven-sh\/setup-bun@v2/,
      /bun install --frozen-lockfile/,
      /bunx styleproof-map --restore --sha "\$BASE_SHA" --dir base --base-dir __stylemaps__ --spec e2e\/styleproof\.spec\.ts/,
      /bunx styleproof-map --spec e2e\/styleproof\.spec\.ts --dir head --base-dir __stylemaps__ --no-upload/,
      /BenSheridanEdwards\/StyleProof@v3/,
    ],
    absent: [/npm ci/],
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

      assert.equal(fs.existsSync(path.join(root, '.githooks', 'pre-push')), false);
      assert.match(readFile(root, '.gitignore'), /\.styleproof\//);

      const workflow = readFile(root, '.github/workflows/styleproof.yml');
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
