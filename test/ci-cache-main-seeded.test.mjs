import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { load } from 'js-yaml';

function hasPushTrigger(trigger) {
  if (typeof trigger === 'string') return trigger === 'push';
  if (Array.isArray(trigger)) return trigger.includes('push');
  return Object.hasOwn(trigger ?? {}, 'push');
}

test('push triggers support strings, lists and maps', () => {
  for (const trigger of ['push', ['pull_request', 'push'], { push: null }]) {
    assert.equal(hasPushTrigger(trigger), true);
  }
  for (const trigger of ['pull_request', ['pull_request'], {}, undefined]) {
    assert.equal(hasPushTrigger(trigger), false);
  }
});

const workflows = fs
  .readdirSync('.github/workflows')
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({
    name,
    workflow: load(fs.readFileSync(`.github/workflows/${name}`, 'utf8')),
  }));

for (const { name, workflow } of workflows) {
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    const steps = job.steps ?? [];
    test(`${name}: ${jobName} restores pnpm before install and saves afterwards`, () => {
      const restoreIndex = steps.findIndex(
        (step) => step.uses?.startsWith('actions/cache/restore@') && step.with?.path?.includes('pnpm-store'),
      );
      if (restoreIndex < 0 && !steps.some((step) => /pnpm store path/.test(step.run ?? ''))) return;
      const installIndexes = steps.flatMap((step, index) => (/pnpm install/.test(step.run ?? '') ? [index] : []));
      assert.ok(restoreIndex >= 0, 'pnpm cache restore is required');
      assert.ok(installIndexes.length > 0, 'pnpm install is required');
      for (const index of installIndexes) assert.ok(restoreIndex < index, 'restore must precede install');
      const restore = steps[restoreIndex];
      for (const [index, step] of steps.entries()) {
        if (
          step.uses?.startsWith('actions/cache/save@') &&
          step.with.key === `\${{ steps.${restore.id}.outputs.cache-primary-key }}`
        ) {
          assert.ok(
            installIndexes.every((installIndex) => installIndex < index),
            'save must follow install',
          );
        }
      }
    });
    test(`${name}: ${jobName} runs pnpm store discovery in bash`, () => {
      for (const step of steps.filter((step) => /pnpm store path/.test(step.run ?? ''))) {
        assert.equal(step.shell, 'bash');
      }
    });
    test(`${name}: ${jobName} keys Playwright caches by installed browser set`, () => {
      const installs = steps.filter((step) => /playwright install/.test(step.run ?? ''));
      const browserSets = installs.map((step) =>
        step.run
          .match(/playwright install\s+([^\n]+)/)[1]
          .split(/\s+/)
          .filter((word) => !word.startsWith('-'))
          .sort()
          .join('-'),
      );
      for (const step of steps.filter(
        (step) => step.uses?.startsWith('actions/cache/') && step.with?.path?.includes('ms-playwright'),
      )) {
        assert.ok(browserSets.length > 0, 'cache must declare an installed browser set');
        assert.equal(new Set(browserSets).size, 1, 'conditional installs must agree');
        const restore = step.uses.startsWith('actions/cache/save@')
          ? steps.find((candidate) => step.with.key === `\${{ steps.${candidate.id}.outputs.cache-primary-key }}`)
          : step;
        assert.ok(restore, 'save must use the restore key');
        assert.ok(restore.with.key.endsWith(`-${browserSets[0]}`), restore.with.key);
      }
    });
    test(`${name}: ${jobName} restores caches and only seeds on default-branch pushes`, () => {
      for (const step of steps) {
        const label = `${name}: ${jobName}: ${step.name ?? step.uses}`;
        assert.ok(!step.uses?.startsWith('actions/cache@'), label);

        if (step.uses?.startsWith('actions/setup-node@')) {
          assert.equal(Object.hasOwn(step.with ?? {}, 'cache'), false, label);
        }

        if (step.uses?.startsWith('actions/cache/restore@')) {
          assert.equal(step.uses, 'actions/cache/restore@v6', label);
          const key = step.with.key;
          assert.match(key, /runner\.os/, label);

          if (step.with.path.includes('ms-playwright')) {
            assert.match(key, /steps\.playwright-version\.outputs\.version/, label);
          } else {
            assert.match(key, /hashFiles\('pnpm-lock\.yaml'\)/, label);
            assert.match(key, /steps\.node\.outputs\.node-version/, label);
          }
        }

        if (step.uses?.startsWith('actions/cache/save@')) {
          assert.equal(step.uses, 'actions/cache/save@v6', label);

          const restore = steps.find(
            (candidate) => step.with.key === `\${{ steps.${candidate.id}.outputs.cache-primary-key }}`,
          );

          assert.ok(restore?.uses === 'actions/cache/restore@v6', label);
          assert.equal(step.with.path, restore.with.path, label);

          const installGuard =
            name === 'release.yml' && restore.id === 'pnpm-cache' ? " && steps.check.outputs.released == 'true'" : '';

          assert.equal(
            step.if,
            `github.event_name == 'push' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch) && steps.${restore.id}.outputs.cache-hit != 'true'${restore.id === 'playwright-cache' ? " && steps.playwright-cache.outputs.cache-primary-key != ''" : ''}${installGuard}`,
            label,
          );
          assert.ok(hasPushTrigger(workflow.on), `${label}: seeding requires a push trigger`);
        }
      }
    });
  }
}
