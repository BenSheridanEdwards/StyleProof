import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ciWorkflow, PACKAGE_MANAGERS } from '../bin/init/templates.mjs';

for (const workflow of ['single', 'split']) {
  test(`branch-storage ${workflow} close-prune requires a same-repo head`, () => {
    const generated = ciWorkflow({
      PM: PACKAGE_MANAGERS.npm,
      scaffold: { storage: 'branch', workflow, mode: 'advisory' },
      specPath: 'e2e/styleproof.spec.ts',
      baseUrl: 'http://localhost:3000',
      command: 'npm start',
    });
    const prune = generated.slice(generated.indexOf('\n  prune:'), generated.indexOf('\n  report-sweep:'));
    const condition = prune.match(/^ {4}if: (.+)$/m)?.[1];
    assert.equal(
      condition,
      "github.event_name == 'pull_request' && github.event.action == 'closed' && github.event.pull_request.head.repo.full_name == github.repository",
    );
    // A fork's different head repository cannot satisfy this equality.
    assert.match(condition, /&& github\.event\.pull_request\.head\.repo\.full_name == github\.repository$/);
    // Same-repo close still runs the PR-specific prune with write permission.
    assert.match(prune, /permissions:\n {6}contents: write/);
    assert.match(prune, /styleproof-prune-reports\.mjs/);
    assert.match(prune, /--pull-request '\$\{\{ github\.event\.pull_request\.number \}\}'/);
  });
}
