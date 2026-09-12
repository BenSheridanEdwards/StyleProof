/**
 * E2E coverage for #536: verify `styleproof-init --upgrade` produces exact template
 * files for each generator variant. TDD failing-first: this test asserts exact
 * template parity, so any drift in generated output vs the canonical templates will
 * fail this test.
 *
 * @see https://github.com/BenSheridanEdwards/StyleProof/issues/536
 */
import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const INIT_BIN = path.resolve(import.meta.dirname, '..', 'bin', 'styleproof-init.mjs');

function mkTmp(prefix = 'styleproof-scaffold-drift-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTmp(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runInit(cwd: string, args: string[] = [], env: Record<string, string> = {}): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [INIT_BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function readFile(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function touch(root: string, rel: string): void {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '');
}

test.describe('styleproof-init scaffold drift E2E (#536)', () => {
  test.describe('--upgrade produces exact templates for each generator variant', () => {
    const packageManagers = [
      { name: 'npm', lockfile: null, installPattern: /npm ci/ },
      { name: 'yarn', lockfile: 'yarn.lock', installPattern: /npx -y yarn@1\.22\.22/ },
      { name: 'pnpm', lockfile: 'pnpm-lock.yaml', installPattern: /pnpm install/ },
      { name: 'bun', lockfile: 'bun.lock', installPattern: /bun install/ },
    ];

    for (const pm of packageManagers) {
      test(`${pm.name}: --upgrade refreshes workflow to exact template`, async () => {
        const root = mkTmp();
        try {
          if (pm.lockfile) touch(root, pm.lockfile);
          fs.writeFileSync(
            path.join(root, 'package.json'),
            JSON.stringify({ scripts: { build: 'build', start: 'start' } }),
          );

          // Initial scaffold
          const init = runInit(root, ['--dir', 'e2e/styleproof.spec.ts']);
          expect(init.status).toBe(0);

          // Simulate drift: append to the workflow
          const workflowPath = '.github/workflows/styleproof.yml';
          const originalWorkflow = readFile(root, workflowPath);
          fs.writeFileSync(path.join(root, workflowPath), originalWorkflow + '\n# drifted content\n');

          // --check should detect the drift
          const check = runInit(root, ['--check', '--dir', 'e2e/styleproof.spec.ts']);
          expect(check.status).toBe(1);
          expect(check.stdout).toMatch(/stale.*styleproof\.yml/);

          // --upgrade should restore it
          const upgrade = runInit(root, ['--upgrade', '--dir', 'e2e/styleproof.spec.ts']);
          expect(upgrade.status).toBe(0);
          expect(upgrade.stdout).toMatch(/refreshed.*styleproof\.yml/);

          // After upgrade, --check should pass
          const checkAfter = runInit(root, ['--check', '--dir', 'e2e/styleproof.spec.ts']);
          expect(checkAfter.status).toBe(0);
          expect(checkAfter.stdout).toMatch(/all machine-owned files match/);

          // Verify the workflow matches the expected pattern for this package manager
          const workflow = readFile(root, workflowPath);
          expect(workflow).toMatch(pm.installPattern);
          expect(workflow).not.toContain('# drifted content');
        } finally {
          rmTmp(root);
        }
      });
    }

    test('approval workflow scaffolds a thin caller to the reusable workflow (#598)', async () => {
      const root = mkTmp();
      try {
        fs.writeFileSync(
          path.join(root, 'package.json'),
          JSON.stringify({ scripts: { build: 'build', start: 'start' } }),
        );

        const init = runInit(root, ['--dir', 'e2e/styleproof.spec.ts']);
        expect(init.status).toBe(0);

        const generatedApprove = readFile(root, '.github/workflows/styleproof-approve.yml');

        // The generated workflow should be a thin caller to the reusable workflow
        expect(generatedApprove).toMatch(/name: StyleProof approve/);
        expect(generatedApprove).toMatch(/# StyleProof approval caller/);
        expect(generatedApprove).toMatch(/issue_comment:/);
        expect(generatedApprove).toMatch(/types: \[edited\]/);
        expect(generatedApprove).toMatch(
          /uses: BenSheridanEdwards\/StyleProof\/\.github\/workflows\/styleproof-approve-reusable\.yml@v7/,
        );
        expect(generatedApprove).toMatch(/status-context: StyleProof/);
        expect(generatedApprove).toMatch(/allow-self-approval: false/);
        expect(generatedApprove).toMatch(/token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);

        // Should NOT contain the full approval logic — that's in the reusable workflow
        expect(generatedApprove).not.toContain('actions/github-script');
        expect(generatedApprove).not.toContain('createCommitStatus');
      } finally {
        rmTmp(root);
      }
    });

    test('pre-push hook template is consistent across runs', async () => {
      const root1 = mkTmp();
      const root2 = mkTmp();
      try {
        for (const root of [root1, root2]) {
          spawnSync('git', ['init', '-q'], { cwd: root, stdio: 'pipe' });
          fs.writeFileSync(
            path.join(root, 'package.json'),
            JSON.stringify({ scripts: { build: 'build', start: 'start' } }),
          );
        }

        runInit(root1, ['--dir', 'e2e/styleproof.spec.ts']);
        runInit(root2, ['--dir', 'e2e/styleproof.spec.ts']);

        const hook1 = readFile(root1, '.githooks/pre-push');
        const hook2 = readFile(root2, '.githooks/pre-push');
        expect(hook1).toBe(hook2);

        // Verify hook structure
        expect(hook1).toMatch(/^#!/);
        expect(hook1).toContain('StyleProof pre-push');
        expect(hook1).toContain('exec ./node_modules/.bin/styleproof-prepush');
      } finally {
        rmTmp(root1);
        rmTmp(root2);
      }
    });
  });

  test.describe('generator variants produce deterministic output', () => {
    test('Next.js app router scaffold is deterministic', async () => {
      const root1 = mkTmp();
      const root2 = mkTmp();
      try {
        for (const root of [root1, root2]) {
          fs.writeFileSync(
            path.join(root, 'package.json'),
            JSON.stringify({ scripts: { build: 'next build' }, dependencies: { next: '^15.0.0' } }),
          );
          touch(root, 'app/page.tsx');
          touch(root, 'app/about/page.tsx');
        }

        runInit(root1, ['--dir', 'e2e/styleproof.spec.ts']);
        runInit(root2, ['--dir', 'e2e/styleproof.spec.ts']);

        const spec1 = readFile(root1, 'e2e/styleproof.spec.ts');
        const spec2 = readFile(root2, 'e2e/styleproof.spec.ts');
        expect(spec1).toBe(spec2);

        // Verify Next.js-specific content
        expect(spec1).toContain('discoverNextRoutes');
        expect(spec1).toContain('ROUTES');
      } finally {
        rmTmp(root1);
        rmTmp(root2);
      }
    });

    test('non-Next crawl scaffold is deterministic', async () => {
      const root1 = mkTmp();
      const root2 = mkTmp();
      try {
        for (const root of [root1, root2]) {
          fs.writeFileSync(
            path.join(root, 'package.json'),
            JSON.stringify({ scripts: { build: 'build', start: 'start' } }),
          );
          touch(root, 'src/components/Button.tsx');
        }

        runInit(root1, ['--dir', 'e2e/styleproof.spec.ts']);
        runInit(root2, ['--dir', 'e2e/styleproof.spec.ts']);

        const spec1 = readFile(root1, 'e2e/styleproof.spec.ts');
        const spec2 = readFile(root2, 'e2e/styleproof.spec.ts');
        expect(spec1).toBe(spec2);

        // Verify crawl-specific content
        expect(spec1).toContain('defineCrawlCapture');
        expect(spec1).not.toContain('discoverNextRoutes');
      } finally {
        rmTmp(root1);
        rmTmp(root2);
      }
    });

    test('config file is deterministic across identical environments', async () => {
      const root1 = mkTmp();
      const root2 = mkTmp();
      try {
        for (const root of [root1, root2]) {
          fs.writeFileSync(
            path.join(root, 'package.json'),
            JSON.stringify({ scripts: { build: 'build', start: 'start' } }),
          );
        }

        runInit(root1, ['--dir', 'e2e/styleproof.spec.ts', '--base-url', 'http://localhost:4000']);
        runInit(root2, ['--dir', 'e2e/styleproof.spec.ts', '--base-url', 'http://localhost:4000']);

        const config1 = readFile(root1, 'playwright.styleproof.config.ts');
        const config2 = readFile(root2, 'playwright.styleproof.config.ts');
        expect(config1).toBe(config2);

        // Verify config content
        expect(config1).toContain('Generated by styleproof-init');
        expect(config1).toContain('localhost:4000');
      } finally {
        rmTmp(root1);
        rmTmp(root2);
      }
    });
  });

  test.describe('--check detects specific drift types', () => {
    test('detects missing hook', async () => {
      const root = mkTmp();
      try {
        spawnSync('git', ['init', '-q'], { cwd: root, stdio: 'pipe' });
        spawnSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'pipe' });
        fs.writeFileSync(
          path.join(root, 'package.json'),
          JSON.stringify({ scripts: { build: 'build', start: 'start' } }),
        );

        const check = runInit(root, ['--check', '--dir', 'e2e/styleproof.spec.ts']);
        expect(check.status).toBe(1);
        expect(check.stdout).toMatch(/missing.*pre-push/);
      } finally {
        rmTmp(root);
      }
    });

    test('detects stale workflow after manual edit', async () => {
      const root = mkTmp();
      try {
        fs.writeFileSync(
          path.join(root, 'package.json'),
          JSON.stringify({ scripts: { build: 'build', start: 'start' } }),
        );

        runInit(root, ['--dir', 'e2e/styleproof.spec.ts']);

        // Modify the workflow
        const workflowPath = path.join(root, '.github/workflows/styleproof.yml');
        const content = fs.readFileSync(workflowPath, 'utf8');
        fs.writeFileSync(workflowPath, content.replace('StyleProof capture', 'Modified capture'));

        const check = runInit(root, ['--check', '--dir', 'e2e/styleproof.spec.ts']);
        expect(check.status).toBe(1);
        expect(check.stdout).toMatch(/stale.*styleproof\.yml/);
      } finally {
        rmTmp(root);
      }
    });
  });

  test.describe('framework-specific templates', () => {
    test('Vite project gets correct preview command', async () => {
      const root = mkTmp();
      try {
        fs.writeFileSync(
          path.join(root, 'package.json'),
          JSON.stringify({
            scripts: { build: 'vite build' },
            devDependencies: { vite: '^6.0.0' },
          }),
        );

        const init = runInit(root, ['--dir', 'e2e/styleproof.spec.ts', '--base-url', 'http://127.0.0.1:4173']);
        expect(init.status).toBe(0);

        const config = readFile(root, 'playwright.styleproof.config.ts');
        expect(config).toMatch(/vite preview/);
        expect(config).toMatch(/--host 127\.0\.0\.1 --port 4173/);
      } finally {
        rmTmp(root);
      }
    });

    test('Next.js project gets correct build and start command', async () => {
      const root = mkTmp();
      try {
        fs.writeFileSync(
          path.join(root, 'package.json'),
          JSON.stringify({
            scripts: { build: 'next build' },
            dependencies: { next: '^15.0.0' },
          }),
        );

        const init = runInit(root, ['--dir', 'e2e/styleproof.spec.ts', '--base-url', 'http://127.0.0.1:3100']);
        expect(init.status).toBe(0);

        const config = readFile(root, 'playwright.styleproof.config.ts');
        expect(config).toMatch(/npm run build && npx next start -p 3100/);
      } finally {
        rmTmp(root);
      }
    });
  });
});
