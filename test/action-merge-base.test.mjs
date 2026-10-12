import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveActionContext } from '../dist/action-context.js';

// Synthetic immutable graph: A is the fork point, B the advanced target, H the captured head.
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const H = 'c'.repeat(40);
const X = 'd'.repeat(40);
const repo = { owner: 'example', repo: 'demo' };
const pullRequest = (base = B, head = H, fullName = 'example/demo') => ({
  number: 12,
  base: { sha: base, ref: 'main' },
  head: { sha: head, ref: 'topic', repo: { full_name: fullName } },
});
const response = (base = B, ancestor = A) => ({
  data: {
    base_commit: { sha: base },
    merge_base_commit: { sha: ancestor },
    // These deliberately misleading paginated commits must never supply H.
    commits: [{ sha: X }],
    total_commits: 400,
  },
});
function mockClient(result = response(), associated = []) {
  const comparisons = [];
  const associations = [];
  return {
    comparisons,
    associations,
    github: {
      async request(route, args) {
        comparisons.push({ route, args });
        if (result instanceof Error) throw result;
        return result;
      },
      rest: {
        repos: {
          async listPullRequestsAssociatedWithCommit(args) {
            associations.push(args);
            return { data: associated };
          },
        },
      },
    },
  };
}
const input = (mock, overrides = {}) => ({
  eventName: 'pull_request',
  payload: { pull_request: pullRequest() },
  repo,
  github: mock.github,
  comparisonBase: 'merge-base',
  ...overrides,
});
const exactRequest = {
  route: 'GET /repos/{owner}/{repo}/compare/{basehead}',
  args: { ...repo, basehead: `${B}...${H}`, page: 1, per_page: 1 },
};

for (const comparisonBase of [undefined, 'pull-request-base']) {
  test(`default preserves original result shape and makes no compare request: ${comparisonBase}`, async () => {
    const mock = mockClient(new Error('must not request'));
    assert.deepEqual(await resolveActionContext(input(mock, { comparisonBase })), {
      prNumber: '12',
      baseSha: B,
      headSha: H,
      untrustedCapture: false,
    });
    assert.deepEqual(mock.comparisons, []);
    assert.deepEqual(mock.associations, []);
  });
}
for (const fullName of ['example/demo', 'contributor/demo']) {
  test(`merge-base uses immutable trusted repository-network SHA request: ${fullName}`, async () => {
    const mock = mockClient();
    const resolved = await resolveActionContext(
      input(mock, { payload: { pull_request: pullRequest(B, H, fullName) } }),
    );
    assert.deepEqual(resolved, {
      prNumber: '12',
      baseSha: A,
      baseTipSha: B,
      comparisonBase: 'merge-base',
      headSha: H,
      untrustedCapture: fullName !== 'example/demo',
    });
    assert.deepEqual(mock.comparisons, [exactRequest]);
  });
}
test('merge-base can equal the base tip', async () => {
  const mock = mockClient(response(B, B));
  const resolved = await resolveActionContext(input(mock));
  assert.equal(resolved.baseSha, B);
  assert.equal(resolved.baseTipSha, B);
  assert.deepEqual(mock.comparisons, [exactRequest]);
});
for (const [label, result] of [
  ['missing response', undefined],
  ['null response', null],
  ['absent data', {}],
  ['null data', { data: null }],
  ['absent fields', { data: {} }],
  ['missing merge-base SHA', { data: { base_commit: { sha: B }, merge_base_commit: {} } }],
  ...[undefined, null, '', 'abc', A.toUpperCase(), 'g'.repeat(40), 42, {}, [], `${A}\n`].map((sha, i) => [
    `invalid ancestor ${i}`,
    { data: { base_commit: { sha: B }, merge_base_commit: { sha } } },
  ]),
  ...[undefined, null, '', 'abc', B.toUpperCase(), X, 42].map((sha, i) => [
    `invalid returned base ${i}`,
    { data: { base_commit: { sha }, merge_base_commit: { sha: A } } },
  ]),
  ['unavailable fork commit', new Error('404')],
  ['unrelated history', new Error('409')],
  ['access denied', new Error('403')],
  ['rate limited', new Error('429')],
]) {
  test(`merge-base fails closed without fallback: ${label}`, async () => {
    const mock = mockClient(null);
    mock.github.request = async (route, args) => {
      mock.comparisons.push({ route, args });
      if (result instanceof Error) throw result;
      return result;
    };
    await assert.rejects(resolveActionContext(input(mock)));
    assert.deepEqual(mock.comparisons, [exactRequest]);
  });
}
for (const comparisonBase of [
  '',
  'MERGE-BASE',
  'merge-base ',
  'main',
  A,
  null,
  42,
  {},
  "'; throw Error('injected'); //",
]) {
  test(`unknown strategy rejects before association or comparison: ${JSON.stringify(comparisonBase)}`, async () => {
    const mock = mockClient();
    await assert.rejects(
      resolveActionContext(
        input(mock, { comparisonBase, eventName: 'workflow_run', payload: { workflow_run: { head_sha: H } } }),
      ),
      /comparison-base/,
    );
    assert.deepEqual(mock.comparisons, []);
    assert.deepEqual(mock.associations, []);
  });
}
for (const side of ['base', 'head']) {
  for (const sha of [undefined, null, '', 'abc', B.toUpperCase(), 'g'.repeat(40), 42, {}, `${B}\n`, 'main']) {
    test(`malformed trusted ${side} rejects before compare: ${JSON.stringify(sha)}`, async () => {
      const pr = pullRequest();
      pr[side].sha = sha;
      const mock = mockClient();
      await assert.rejects(resolveActionContext(input(mock, { payload: { pull_request: pr } })));
      assert.deepEqual(mock.comparisons, []);
    });
  }
}
for (const invalidRepo of [
  {},
  { owner: '', repo: 'demo' },
  { owner: 'example', repo: '../demo' },
  { owner: 42, repo: 'demo' },
]) {
  test(`merge-base rejects invalid trusted repository: ${JSON.stringify(invalidRepo)}`, async () => {
    const mock = mockClient();
    await assert.rejects(resolveActionContext(input(mock, { repo: invalidRepo })));
    assert.deepEqual(mock.comparisons, []);
  });
}
test('artifacts, caller SHAs, forged numbers and mutable refs cannot select identities or strategy', async () => {
  const mock = mockClient();
  const resolved = await resolveActionContext(
    input(mock, {
      expectedBaseSha: X,
      baseSha: X,
      headSha: X,
      prNumber: 999,
      payload: {
        pull_request: pullRequest(),
        ref: 'main',
        artifact: {
          baseSha: X,
          headSha: X,
          prNumber: 999,
          comparisonBase: 'pull-request-base',
          repo: 'attacker/elsewhere',
        },
      },
    }),
  );
  assert.equal(resolved.baseSha, A);
  assert.equal(resolved.headSha, H);
  assert.equal(resolved.prNumber, '12');
  assert.deepEqual(mock.comparisons, [exactRequest]);
});
for (const fullName of ['example/demo', 'contributor/demo', undefined]) {
  test(`workflow_run retains captured H and fork classification: ${fullName}`, async () => {
    const mock = mockClient();
    const resolved = await resolveActionContext(
      input(mock, {
        eventName: 'workflow_run',
        payload: {
          pull_request: pullRequest(X, X),
          workflow_run: {
            head_sha: H,
            head_repository: fullName ? { full_name: fullName } : null,
            pull_requests: [pullRequest()],
          },
        },
      }),
    );
    assert.equal(resolved.headSha, H);
    assert.equal(resolved.baseSha, A);
    assert.equal(resolved.untrustedCapture, fullName !== 'example/demo');
    assert.deepEqual(mock.associations, []);
    assert.deepEqual(mock.comparisons, [exactRequest]);
  });
}
test('fork fallback ignores unrelated and stale associations, never replaces captured H', async () => {
  const mock = mockClient(response(), [
    { ...pullRequest(X, X), state: 'open', number: 99 },
    { ...pullRequest(X, H), state: 'closed', number: 98 },
    { ...pullRequest(), state: 'open' },
  ]);
  const resolved = await resolveActionContext(
    input(mock, {
      eventName: 'workflow_run',
      payload: {
        workflow_run: {
          head_sha: H,
          head_repository: { full_name: 'contributor/demo' },
          pull_requests: [{ ...pullRequest(X, X), number: 99 }],
          artifact: { headSha: X },
        },
      },
    }),
  );
  assert.equal(resolved.prNumber, '12');
  assert.equal(resolved.headSha, H);
  assert.equal(resolved.untrustedCapture, true);
  assert.deepEqual(mock.associations, [{ ...repo, commit_sha: H }]);
  assert.deepEqual(mock.comparisons, [exactRequest]);
});
test('no valid exact-head association means no compare and no partial tuple', async () => {
  const mock = mockClient(response(), [{ ...pullRequest(B, X), state: 'open' }]);
  await assert.rejects(
    resolveActionContext(
      input(mock, {
        eventName: 'workflow_run',
        payload: {
          workflow_run: { head_sha: H, pull_requests: [pullRequest(B, X)] },
        },
      }),
    ),
  );
  assert.deepEqual(mock.comparisons, []);
});
test('merge-base requires a positive integer trusted PR number', async () => {
  for (const number of [undefined, 0, -1, 1.5, '12']) {
    const mock = mockClient();
    await assert.rejects(
      resolveActionContext(input(mock, { payload: { pull_request: { ...pullRequest(), number } } })),
    );
    assert.deepEqual(mock.comparisons, []);
  }
});
