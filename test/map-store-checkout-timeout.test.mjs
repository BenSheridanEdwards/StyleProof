import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { checkoutMapStore, removeTempWorkspace, retryBlocking } from '../dist/map-store/git-transport.js';

for (const stalledCommand of [undefined, 'sparse-checkout', 'checkout']) {
  test(`partial checkout is bounded and never prompts: ${stalledCommand ?? 'success'}`, () => {
    const calls = [];
    const stub = mock.method(childProcess, 'spawnSync', (_file, args, options) => {
      calls.push({ args, options });
      if (args[0] === stalledCommand) {
        return { status: null, stdout: '', stderr: '', error: new Error('spawnSync git ETIMEDOUT') };
      }
      return { status: 0, stdout: args.includes('get-url') ? 'https://example.com/store.git\n' : '', stderr: '' };
    });
    syncBuiltinESMExports();
    let workspace;
    try {
      const outcome = retryBlocking(2, () => {
        try {
          workspace = checkoutMapStore(
            { cwd: process.cwd(), remote: 'origin', branch: 'maps', gitTimeoutMs: 37 },
            { branchExists: true, filter: 'tree:0', sparseSegment: 'bundles' },
          );
          return { value: workspace };
        } catch (error) {
          return { error: error.message };
        }
      });
      const checkoutCalls = calls.filter(({ args }) => ['sparse-checkout', 'checkout'].includes(args[0]));
      assert.ok(checkoutCalls.length > 0);
      for (const { options } of checkoutCalls) {
        assert.equal(options.timeout, 37);
        assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
      }
      if (stalledCommand) {
        assert.deepEqual(outcome.failures, ['spawnSync git ETIMEDOUT', 'spawnSync git ETIMEDOUT']);
        assert.equal(calls.filter(({ args }) => args[0] === stalledCommand).length, 2);
      } else {
        assert.deepEqual(
          checkoutCalls.map(({ args }) => args),
          [
            ['sparse-checkout', 'set', 'bundles'],
            ['checkout', '-q', 'maps'],
          ],
        );
        assert.equal(outcome.value, workspace);
      }
    } finally {
      stub.mock.restore();
      syncBuiltinESMExports();
      removeTempWorkspace(workspace);
    }
  });
}
