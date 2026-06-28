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
    assert.match(res.stdout, /detected 3 Next\.js route\(s\)/);
    assert.match(res.stdout, /1 dynamic route\(s\) excluded/);
  } finally {
    rmTmp(root);
  }
});

test('styleproof-init: non-Next project → generic spec with a commented guard, no discovery import', () => {
  const root = mkTmp();
  try {
    touch(root, 'src/components/Button.tsx');
    const res = runInit(root, ['--dir', 'e2e/styleproof.spec.ts']);
    assert.equal(res.status, 0, res.stderr);
    const spec = readSpec(root);
    assert.doesNotMatch(spec, /import \{[^}]*discoverNextRoutes/); // not auto-wired
    assert.doesNotMatch(spec, /discoverNextRoutes\(\)/); // not called
    assert.match(spec, /Coverage guard \(recommended\)/);
    assert.match(spec, /key: 'home'/);
    assert.match(res.stdout, /no Next\.js routes detected/);
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
    config: /npx -y pnpm build && npx -y pnpm start/,
    workflow: [
      /cache: pnpm/,
      /npx -y pnpm install --frozen-lockfile/,
      /npx -y pnpm exec styleproof-map --restore --sha "\$BASE_SHA" --dir base --base-dir __stylemaps__ --spec e2e\/styleproof\.spec\.ts/,
      /npx -y pnpm exec styleproof-map --spec e2e\/styleproof\.spec\.ts --dir head --base-dir __stylemaps__ --no-upload/,
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

      const config = readFile(root, 'playwright.config.ts');
      assert.match(config, manager.config);

      assert.equal(fs.existsSync(path.join(root, '.githooks', 'pre-push')), false);
      assert.match(readFile(root, '.gitignore'), /\.styleproof\//);

      const workflow = readFile(root, '.github/workflows/styleproof.yml');
      for (const pattern of manager.workflow) assert.match(workflow, pattern);
      for (const pattern of manager.absent ?? []) assert.doesNotMatch(workflow, pattern);
    } finally {
      rmTmp(root);
    }
  });
}
