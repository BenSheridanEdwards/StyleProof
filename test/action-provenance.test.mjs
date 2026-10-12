// Synthetic provenance inputs, not browser captures or product evidence. No network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test, { after } from 'node:test';
import os from 'node:os';

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-provenance-'));
after(() => fs.rmSync(evidence, { recursive: true, force: true }));
const moduleAt = (name) => import(pathToFileURL(path.join(checkout, name)).href);
const { makeMap, writeCapture, solidPng } = await moduleAt('test/helpers.mjs');
const { COVERAGE_LEDGER } = await moduleAt('dist/coverage.js');
const { decideReviewStatus } = await moduleAt('dist/review-status.js');
const action = fs.readFileSync(path.join(checkout, 'action.yml'), 'utf8');
const contextStep = action.split('    - id: context\n')[1].split('    # Policy config:')[0];
const script = contextStep
  .split('        script: |\n')[1]
  .split('\n')
  .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
  .join('\n');
assert.ok(script.includes('resolveActionContext'), 'execute the real Action context script');
assert.match(action, /STYLEPROOF_EXPECTED_BASE_SHA: \$\{\{ steps.context.outputs.base-sha \}\}/);
assert.match(action, /--expected-before-sha "\$STYLEPROOF_EXPECTED_BASE_SHA"/);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const executeContext = new AsyncFunction('context', 'github', 'core', script);
process.env.GITHUB_ACTION_PATH = checkout;

// Synthetic graph: A is the common ancestor, B is main after branching, H is PR head.
// These stand-in identities are not claims about any actual repository or captures.
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const H = 'c'.repeat(40);
const X = 'd'.repeat(40);
const repo = { owner: 'example', repo: 'demo' };
const identity = { id: 'home-ready', revision: 'fixture-v1' };
const pullRequest = (base = B, head = H, fullName = 'example/demo') => ({
  number: 12,
  base: { sha: base },
  head: { sha: head, repo: { full_name: fullName } },
});
async function context(payload, eventName = 'pull_request', associated = [], comparisonBase, options = {}) {
  const outputs = options.outputs ?? {};
  const calls = [];
  const comparisons = [];
  if (comparisonBase === undefined) delete process.env.STYLEPROOF_COMPARISON_BASE;
  else process.env.STYLEPROOF_COMPARISON_BASE = comparisonBase;
  await executeContext(
    { eventName, payload, repo },
    {
      async request(route, args) {
        comparisons.push({ route, args });
        if (options.error) throw options.error;
        return options.response ?? { data: { base_commit: { sha: B }, merge_base_commit: { sha: A } } };
      },
      rest: {
        repos: {
          async listPullRequestsAssociatedWithCommit(args) {
            calls.push(args);
            return { data: associated };
          },
        },
      },
    },
    {
      setOutput: (key, value) => {
        outputs[key] = value;
      },
      info() {},
      notice() {},
    },
  );
  return { outputs, calls, comparisons };
}
function fixture(name, beforeSha, afterSha = H, beforeState = identity, afterState = identity) {
  const root = fs.mkdtempSync(path.join(evidence, `${name}-`));
  const before = path.join(root, 'before');
  const after = path.join(root, 'after');
  for (const [dir, sha, state] of [
    [before, beforeSha, beforeState],
    [after, afterSha, afterState],
  ]) {
    const map = makeMap({ elements: { 'body > button': { tag: 'button', style: { color: 'black' } } } });
    if (state !== null) map.metadata = { productState: state };
    writeCapture(dir, 'home@1280', map, solidPng(2, 2));
    fs.writeFileSync(
      path.join(dir, 'styleproof-manifest.json'),
      JSON.stringify({
        version: 1,
        packageVersion: 'synthetic-test',
        sha,
        dirty: false,
        spec: 'e2e/example.spec.ts',
        specHash: '1'.repeat(64),
        platform: process.platform,
        arch: process.arch,
        nodeMajor: process.versions.node.split('.')[0],
        screenshots: true,
        har: false,
        compatibilityKey: '0000000000000000',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    fs.writeFileSync(
      path.join(dir, COVERAGE_LEDGER),
      JSON.stringify({
        version: 1,
        expected: ['home'],
        exclude: {},
        determinism: 'self-checked',
      }),
    );
  }
  return { root, before, after };
}
function run(kind, fixture, outputs) {
  const destination = path.join(fixture.root, kind === 'diff' ? 'styleproof-diff.json' : 'styleproof-report');
  const args = [
    path.join(checkout, `bin/styleproof-${kind}.mjs`),
    fixture.before,
    fixture.after,
    kind === 'diff' ? '--json' : '--out',
    destination,
    '--expected-before-sha',
    outputs['base-sha'],
    '--expected-after-sha',
    outputs['head-sha'],
    '--require-state-identity',
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: fixture.root,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.ifError(result.error);
  const receiptPath = kind === 'diff' ? destination : path.join(destination, 'report.json');
  const receipt = fs.existsSync(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath, 'utf8')) : null;
  fs.writeFileSync(
    path.join(fixture.root, `${kind}-execution.json`),
    JSON.stringify(
      {
        status: result.status,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        expectedBase: outputs['base-sha'],
        expectedHead: outputs['head-sha'],
      },
      null,
      2,
    ),
  );
  return { ...result, receipt };
}
function actionEnvironment(captures, outputs) {
  return {
    ...process.env,
    GITHUB_ACTION_PATH: checkout,
    GITHUB_OUTPUT: path.join(captures.root, 'github-output'),
    STYLEPROOF_EXPECTED_BASE_SHA: outputs['base-sha'],
    STYLEPROOF_EXPECTED_HEAD_SHA: outputs['head-sha'],
    STYLEPROOF_BASELINE_DIR: captures.before,
    STYLEPROOF_FRESH_DIR: captures.after,
    STYLEPROOF_REQUIRE_STATE_IDENTITY: 'true',
    STYLEPROOF_INCLUDE_CONTENT: 'false',
    STYLEPROOF_MODE: 'certify',
  };
}
function runActionStep(id, captures, outputs) {
  const match = action.match(
    new RegExp(`    - id: ${id}\\n[\\s\\S]*?      run: \\|\\n([\\s\\S]*?)(?=\\n    #|\\n    - id:)`),
  );
  assert.ok(match, `actual ${id} shell step exists`);
  const source = match[1]
    .split('\n')
    .map((line) => line.replace(/^ {8}/, ''))
    .join('\n');
  const file = path.join(captures.root, `${id}.sh`);
  fs.writeFileSync(file, source);
  return spawnSync('bash', ['-e', '-o', 'pipefail', file], {
    cwd: captures.root,
    encoding: 'utf8',
    timeout: 30_000,
    env: actionEnvironment(captures, outputs),
  });
}
function mergeReceipts(captures, outputs) {
  const match = action.match(/ {8}node --input-type=module <<'NODE'\n([\s\S]*?)\n {8}NODE/);
  assert.ok(match, 'execute the actual receipt guards');
  const file = path.join(captures.root, 'merge.mjs');
  fs.writeFileSync(
    file,
    match[1]
      .split('\n')
      .map((line) => line.replace(/^ {8}/, ''))
      .join('\n'),
  );
  return spawnSync(process.execPath, [file], {
    cwd: captures.root,
    encoding: 'utf8',
    timeout: 30_000,
    env: actionEnvironment(captures, outputs),
  });
}

for (const comparisonBase of [undefined, 'pull-request-base', 'merge-base']) {
  test(`actual Action shell steps and receipt guards share one selected tuple: ${comparisonBase}`, async () => {
    const { outputs, comparisons } = await context({ pull_request: pullRequest() }, 'pull_request', [], comparisonBase);
    const selected = comparisonBase === 'merge-base' ? A : B;
    const captures = fixture('action-steps', selected);
    if (comparisonBase !== 'merge-base') assert.deepEqual(comparisons, []);
    for (const id of ['diff', 'report']) {
      const result = runActionStep(id, captures, outputs);
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
    const diff = JSON.parse(fs.readFileSync(path.join(captures.root, 'styleproof-diff.json'), 'utf8'));
    const reportPath = path.join(captures.root, 'styleproof-report/report.json');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.deepEqual(report.sourceBinding, diff.sourceBinding);
    assert.equal(report.sourceBinding.before.expected, selected);
    assert.equal(report.sourceBinding.after.expected, H);
    assert.equal(report.comparison.requireStateIdentity, true);
    // A receipt bound to another valid SHA must not reach publication.
    report.sourceBinding.before.expected = X;
    report.sourceBinding.before.observed = X;
    fs.writeFileSync(reportPath, JSON.stringify(report));
    const rejected = mergeReceipts(captures, outputs);
    assert.ifError(rejected.error);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /source-binding receipts are missing, malformed, or not bound/);
  });
}

test('comparison-base input enters github-script as data, never executable interpolation', () => {
  assert.match(action, /comparison-base:\n\s+description:[^\n]+\n\s+default: 'pull-request-base'/);
  assert.match(contextStep, /STYLEPROOF_COMPARISON_BASE: \$\{\{ inputs.comparison-base \}\}/);
  assert.match(script, /comparisonBase: process.env.STYLEPROOF_COMPARISON_BASE/);
  assert.doesNotMatch(script, /\$\{\{ inputs.comparison-base/);
  assert.doesNotMatch(contextStep, /continue-on-error/);
});
for (const [name, strategy, options] of [
  ['unknown enum', 'main', {}],
  ['script-looking data', "'; throw Error('injected'); //", {}],
  ['API denial', 'merge-base', { error: new Error('403') }],
  [
    'wrong returned base',
    'merge-base',
    { response: { data: { base_commit: { sha: X }, merge_base_commit: { sha: A } } } },
  ],
  ['missing ancestor', 'merge-base', { response: { data: { base_commit: { sha: B } } } }],
]) {
  test(`context failure emits no partial outputs or success path: ${name}`, async () => {
    const outputs = {};
    await assert.rejects(
      context({ pull_request: pullRequest() }, 'pull_request', [], strategy, { ...options, outputs }),
    );
    assert.deepEqual(outputs, {});
  });
}
for (const [before, after, side] of [
  [B, H, 'before'],
  [A, X, 'after'],
]) {
  test(`merge-base provenance rejects wrong captured ${side}`, async () => {
    const { outputs } = await context({ pull_request: pullRequest() }, 'pull_request', [], 'merge-base');
    const captures = fixture('opt-in-wrong-source', before, after);
    for (const kind of ['diff', 'report']) mismatch(run(kind, captures, outputs), side);
  });
}
for (const state of [null, { id: 'home-loading', revision: 'fixture-v1' }]) {
  test(`merge-base provenance does not waive product-state identity: ${JSON.stringify(state)}`, async () => {
    const { outputs } = await context({ pull_request: pullRequest() }, 'pull_request', [], 'merge-base');
    const captures = fixture('opt-in-state', A, H, identity, state);
    for (const kind of ['diff', 'report']) {
      const result = run(kind, captures, outputs);
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.equal(result.receipt.comparison.blocksCertification, true);
      assert.equal(result.receipt.sourceBinding.status, 'bound');
      assert.equal(
        decideReviewStatus({
          trustState: 'CERTIFICATION_FAILED',
          untrustedCapture: true,
          advisoryMode: false,
          approved: true,
        }).state,
        'failure',
      );
    }
  });
}
test('merge-base fork provenance still needs manual approval, even for clean maps', async () => {
  const { outputs } = await context(
    { pull_request: pullRequest(B, H, 'contributor/demo') },
    'pull_request',
    [],
    'merge-base',
  );
  assert.equal(outputs['untrusted-capture'], 'true');
  const captures = fixture('opt-in-fork', A);
  for (const kind of ['diff', 'report']) {
    const result = run(kind, captures, outputs);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const status = {
      trustState: 'NO_REVIEWABLE_STYLE_CHANGES',
      untrustedCapture: true,
      advisoryMode: false,
      approved: false,
    };
    assert.equal(decideReviewStatus(status).state, 'pending');
    assert.equal(decideReviewStatus({ ...status, advisoryMode: true }).state, 'pending');
    assert.equal(decideReviewStatus({ ...status, approved: true }).state, 'success');
  }
});
test('workflow_run later target history cannot be repaired using artifact historical claims', async () => {
  const { outputs, comparisons } = await context(
    { workflow_run: { head_sha: H, head_repository: { full_name: 'example/demo' }, artifact: { baseSha: A } } },
    'workflow_run',
    [{ ...pullRequest(), state: 'open' }],
    'merge-base',
    {
      response: { data: { base_commit: { sha: B }, merge_base_commit: { sha: X } } },
    },
  );
  assert.equal(outputs['head-sha'], H);
  assert.equal(outputs['base-sha'], X);
  assert.deepEqual(comparisons[0].args, { ...repo, basehead: `${B}...${H}`, page: 1, per_page: 1 });
  const captures = fixture('stale-target-history', A);
  for (const kind of ['diff', 'report']) mismatch(run(kind, captures, outputs), 'before');
});

function mismatch(result, side) {
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, new RegExp(`${side} capture source does not match the trusted SHA`));
  assert.equal(result.receipt, null, 'provenance error cannot publish a comparison receipt');
}

test('opt-in fork-point captures reach both real CLIs with trusted Action provenance', async () => {
  const { outputs, comparisons } = await context({ pull_request: pullRequest() }, 'pull_request', [], 'merge-base');
  const captures = fixture('acceptance-red', A);
  const diff = run('diff', captures, outputs);
  const report = run('report', captures, outputs);
  console.log(
    JSON.stringify({
      syntheticForkPoint: A,
      eventBase: B,
      trustedHead: H,
      actionBase: outputs['base-sha'],
      diffExit: diff.status,
      reportExit: report.status,
      diffError: diff.stderr.trim(),
      reportError: report.stderr.trim(),
    }),
  );
  assert.equal(diff.status, 0, diff.stderr);
  assert.equal(report.status, 0, report.stderr);
  assert.deepEqual(comparisons, [
    {
      route: 'GET /repos/{owner}/{repo}/compare/{basehead}',
      args: { ...repo, basehead: `${B}...${H}`, page: 1, per_page: 1 },
    },
  ]);
  assert.deepEqual(report.receipt.sourceBinding, diff.receipt.sourceBinding);
  assert.equal(diff.receipt.sourceBinding.before.expected, A);
  assert.equal(diff.receipt.sourceBinding.after.expected, H);
  assert.equal(diff.receipt.certifiesFully, true);
});
test('default base-tip contract remains source-bound in both real CLIs', async () => {
  const resolved = await context({ pull_request: pullRequest() });
  assert.deepEqual(resolved.calls, []);
  assert.equal(resolved.outputs['base-sha'], B);
  const captures = fixture('default-compatible', B);
  const diff = run('diff', captures, resolved.outputs);
  const report = run('report', captures, resolved.outputs);
  assert.equal(diff.status, 0, diff.stderr || diff.stdout);
  assert.equal(report.status, 0, report.stderr || report.stdout);
  assert.equal(diff.receipt.certifiesFully, true);
  assert.deepEqual(report.receipt.sourceBinding, diff.receipt.sourceBinding);
  assert.equal(diff.receipt.comparison.requireStateIdentity, true);
  assert.equal(diff.receipt.sourceBinding.before.observed, B);
  assert.equal(diff.receipt.sourceBinding.after.observed, H);
});
test('behind-main fork-point capture fails closed at the real Action-to-CLI seam', async () => {
  const { outputs } = await context({ pull_request: pullRequest() });
  const captures = fixture('fork-point-rejected', A);
  mismatch(run('diff', captures, outputs), 'before');
  mismatch(run('report', captures, outputs), 'before');
});
test('artifact and unknown caller SHA fields cannot override trusted Action identity', async () => {
  const { outputs } = await context({
    pull_request: pullRequest(),
    artifact: { baseSha: A, headSha: X, prNumber: 999 },
    expectedBaseSha: A,
  });
  assert.equal(outputs['pr-number'], '12');
  assert.equal(outputs['base-sha'], B);
  assert.equal(outputs['head-sha'], H);
  const captures = fixture('artifact-spoof', A);
  mismatch(run('diff', captures, outputs), 'before');
});
test('wrong captured head fails even with a matching baseline', async () => {
  const { outputs } = await context({ pull_request: pullRequest() });
  const captures = fixture('wrong-head', B, X);
  mismatch(run('diff', captures, outputs), 'after');
  mismatch(run('report', captures, outputs), 'after');
});
for (const [name, base, head] of [
  ['short-base', 'abc', H],
  ['missing-base', undefined, H],
  ['short-head', B, 'abc'],
  ['missing-head', B, undefined],
]) {
  test(`malformed or missing trusted identity emits no tuple: ${name}`, async () => {
    const { outputs } = await context({
      pull_request: {
        number: 12,
        base: { sha: base },
        head: { sha: head },
      },
    });
    assert.equal(outputs['pr-number'], '');
    assert.equal(outputs['base-sha'], '');
    assert.equal(outputs['head-sha'], '');
    const captures = fixture(name, B);
    assert.equal(run('diff', captures, outputs).status, 2);
    assert.equal(run('report', captures, outputs).status, 2);
  });
}
test('same-repo workflow_run preserves exact captured head and trusted embedded association', async () => {
  const { outputs, calls } = await context(
    {
      workflow_run: {
        head_sha: H,
        head_repository: { full_name: 'example/demo' },
        pull_requests: [{ number: 12, base: { sha: B }, head: { sha: H } }],
      },
    },
    'workflow_run',
  );
  assert.deepEqual(calls, []);
  assert.equal(outputs['head-sha'], H);
  assert.equal(outputs['base-sha'], B);
  assert.equal(outputs['untrusted-capture'], 'false');
  mismatch(run('diff', fixture('workflow-fork-point', A), outputs), 'before');
});
test('fork workflow_run ignores unrelated PRs and artifact identity, retaining manual approval', async () => {
  const { outputs, calls } = await context(
    {
      workflow_run: {
        head_sha: H,
        head_repository: { full_name: 'contributor/demo' },
        pull_requests: [{ number: 99, base: { sha: A }, head: { sha: X } }],
        artifact: { prNumber: 99, baseSha: A, headSha: X },
      },
    },
    'workflow_run',
    [
      { state: 'open', number: 99, base: { sha: A }, head: { sha: X } },
      { state: 'closed', number: 98, base: { sha: A }, head: { sha: H } },
      { state: 'open', number: 12, base: { sha: B }, head: { sha: H } },
    ],
  );
  assert.deepEqual(calls, [{ ...repo, commit_sha: H }]);
  assert.equal(outputs['pr-number'], '12');
  assert.equal(outputs['base-sha'], B);
  assert.equal(outputs['head-sha'], H);
  assert.equal(outputs['untrusted-capture'], 'true');
  const input = {
    trustState: 'NO_REVIEWABLE_STYLE_CHANGES',
    untrustedCapture: true,
    advisoryMode: false,
    approved: false,
  };
  assert.equal(decideReviewStatus(input).state, 'pending');
  assert.equal(decideReviewStatus({ ...input, advisoryMode: true }).state, 'pending');
  assert.equal(decideReviewStatus({ ...input, approved: true }).state, 'success');
  assert.equal(decideReviewStatus({ ...input, trustState: 'CERTIFICATION_FAILED', approved: true }).state, 'failure');
  mismatch(run('diff', fixture('fork-workflow', A), outputs), 'before');
});
test('workflow_run missing repository stays untrusted; absent exact-head association emits no tuple', async () => {
  const missingRepository = await context(
    { workflow_run: { head_sha: H, pull_requests: [{ number: 12, base: { sha: B }, head: { sha: H } }] } },
    'workflow_run',
  );
  assert.equal(missingRepository.outputs['untrusted-capture'], 'true');
  const unmatched = await context({ workflow_run: { head_sha: H } }, 'workflow_run', [
    { state: 'open', number: 99, base: { sha: B }, head: { sha: X } },
  ]);
  assert.equal(unmatched.outputs['pr-number'], '');
  assert.equal(unmatched.outputs['base-sha'], '');
  assert.equal(unmatched.outputs['head-sha'], '');
});
for (const [name, state] of [
  ['missing-state', null],
  ['mismatched-state', { id: 'home-loading', revision: 'fixture-v1' }],
]) {
  test(`valid source binding does not bypass required product-state identity: ${name}`, async () => {
    const { outputs } = await context({ pull_request: pullRequest() });
    const captures = fixture(name, B, H, identity, state);
    for (const kind of ['diff', 'report']) {
      const result = run(kind, captures, outputs);
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.equal(result.receipt.comparison.blocksCertification, true);
      assert.equal(result.receipt.sourceBinding.status, 'bound');
    }
  });
}
