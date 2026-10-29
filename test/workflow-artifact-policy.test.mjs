import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { load } from 'js-yaml';

const workflows = ['.github/workflows', 'example'].flatMap((directory) =>
  fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.yml'))
    .map((name) => {
      const file = `${directory}/${name}`;
      return { file, workflow: load(fs.readFileSync(file, 'utf8')) };
    }),
);
const steps = (workflow) => Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);

test('workflow uploads have explicit short retention and exclude bulky browser evidence', () => {
  for (const { file, workflow } of workflows) {
    for (const step of steps(workflow).filter((step) => step.uses?.startsWith('actions/upload-artifact@'))) {
      const inputs = step.with ?? {};
      const label = `${file}: ${inputs.name ?? step.uses}`;
      assert.ok(Object.hasOwn(inputs, 'retention-days'), `${label}: explicit retention required`);

      // Approval receipts carry authorization for the repository's retention window.
      if (file.endsWith('/styleproof-approve-reusable.yml') || file === 'example/styleproof-approve.yml') {
        assert.equal(inputs['retention-days'], '${{ github.retention_days }}');
        assert.equal(inputs.path, 'styleproof-approval.txt');
        continue;
      }
      const limit = file.startsWith('example/') ? 3 : 1;
      assert.ok(
        Number.isInteger(inputs['retention-days']) && inputs['retention-days'] > 0 && inputs['retention-days'] <= limit,
        `${label}: retention must be 1..${limit} days`,
      );
      assert.equal(typeof inputs.path, 'string', `${label}: upload path required`);
      assert.doesNotMatch(inputs.path, /test-results|playwright-report|trace|\.zip/i, label);
    }
  }
});

test('browser shard upload contains only the three JSON receipts needed by e2e-evidence', () => {
  const { workflow } = workflows.find(({ file }) => file === '.github/workflows/ci.yml');
  const upload = steps(workflow).find((step) => step.with?.name === 'e2e-shard-${{ matrix.shard }}');
  assert.deepEqual(upload.with.path.trim().split(/\s+/).sort(), [
    '.styleproof/ci/determinism-oracle.json',
    '.styleproof/ci/inventory.json',
    '.styleproof/ci/shard.json',
  ]);
  assert.match(workflow.jobs['e2e-evidence'].steps.at(-1).run, /verify-e2e-shards\.mjs .* 6$/);
});

test('dogfood inherits the 14-day Action report retention default', () => {
  const action = load(fs.readFileSync('action.yml', 'utf8'));
  assert.equal(action.inputs['report-retention-days'].default, '14');
  const { workflow } = workflows.find(({ file }) => file === '.github/workflows/styleproof-dogfood.yml');
  for (const step of steps(workflow)) {
    assert.equal(Object.hasOwn(step.with ?? {}, 'report-retention-days'), false);
  }
});

test('gitleaks disables artifact uploads while retaining its scan', () => {
  const scans = workflows
    .flatMap(({ workflow }) => steps(workflow))
    .filter((step) => step.uses?.startsWith('gitleaks/gitleaks-action@'));
  assert.ok(scans.length > 0);
  for (const step of scans) {
    assert.equal(step.env?.GITLEAKS_ENABLE_UPLOAD_ARTIFACT, 'false');
    assert.notEqual(step['continue-on-error'], true);
  }
});
