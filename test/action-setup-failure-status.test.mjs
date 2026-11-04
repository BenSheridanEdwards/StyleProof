import assert from 'node:assert/strict';
import filesystem from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import test, { after } from 'node:test';
import configurationParser from 'js-yaml';
import { resolveActionContext } from '../dist/action-context.js';
import { mkTmp as createTemporaryDirectory, rmTmp as removeTemporaryDirectory } from './helpers.mjs';

const actionDirectory = new URL('../', import.meta.url).pathname;
const steps = configurationParser.load(filesystem.readFileSync(path.join(actionDirectory, 'action.yml'), 'utf8')).runs
  .steps;
const stepNamed = (name) => steps.find((entry) => entry.name === name || entry.id === name);
const headCommit = 'a'.repeat(40);
const baseCommit = 'b'.repeat(40);
const reviewDigest = 'd'.repeat(64);
const repository = { owner: 'owner', repo: 'repo' };
const forkRepository = { id: 2, full_name: 'fork-owner/repo' };
const canonicalCreator = { type: 'Bot', login: 'github-actions[bot]' };
const runAddress = 'https://github.com/owner/repo/actions/runs/900';
const missingRuntimeDirectory = createTemporaryDirectory('styleproof-missing-runtime-');
filesystem.mkdirSync(path.join(missingRuntimeDirectory, 'scripts'));
const failureModule = path.join(actionDirectory, 'scripts/action-setup-failure.mjs');
if (filesystem.existsSync(failureModule)) {
  filesystem.copyFileSync(failureModule, path.join(missingRuntimeDirectory, 'scripts/action-setup-failure.mjs'));
}
after(() => removeTemporaryDirectory(missingRuntimeDirectory));

function eventContext(eventName) {
  const pullRequest = { number: 7, base: { sha: baseCommit }, head: { sha: headCommit, repo: forkRepository } };
  return {
    repo: repository,
    runId: 900,
    eventName,
    payload: {
      repository: { default_branch: 'main' },
      ...(eventName === 'workflow_run'
        ? { workflow_run: { head_sha: headCommit, head_repository: forkRepository, pull_requests: [pullRequest] } }
        : { pull_request: pullRequest }),
    },
  };
}

function approvedStatus() {
  return {
    context: 'StyleProof',
    state: 'success',
    description: 'Approved by @reviewer (run 555)',
    target_url: 'https://github.com/owner/repo/actions/runs/555',
    creator: canonicalCreator,
    created_at: '2026-01-01T10:00:30Z',
  };
}

function statusStore(statuses = []) {
  const writes = [];
  const warnings = [];
  const messages = [];
  const github = {
    paginate: async () => [],
    rest: {
      issues: { listComments() {} },
      actions: {
        getWorkflowRun: async () => ({
          data: {
            status: 'completed',
            conclusion: 'success',
            event: 'issue_comment',
            head_branch: 'main',
            triggering_actor: { login: 'reviewer' },
            run_started_at: '2026-01-01T10:00:00Z',
            updated_at: '2026-01-01T10:01:00Z',
          },
        }),
        listWorkflowRunArtifacts: async () => ({
          data: { artifacts: [{ name: `styleproof-approval-7-${headCommit}-${reviewDigest}`, expired: false }] },
        }),
      },
      repos: {
        listPullRequestsAssociatedWithCommit: async () => ({ data: [] }),
        listCommitStatusesForRef: async () => ({ data: statuses }),
        createCommitStatus: async (request) => {
          writes.push(request);
          statuses.unshift({ ...request, creator: canonicalCreator, created_at: '2026-01-02T10:00:00Z' });
        },
      },
    },
  };
  const core = { warning: (message) => warnings.push(message), info: (message) => messages.push(message) };
  return { github, core, statuses, writes, warnings, messages };
}

async function executeStep(entry, values, store, context, runtimeDirectory = actionDirectory) {
  const resolve = (source) => String(source).replace(/\$\{\{ (.+?) \}\}/g, (_, key) => values[key] ?? '');
  const environment = { GITHUB_ACTION_PATH: runtimeDirectory };
  for (const [name, value] of Object.entries(entry.env ?? {})) environment[name] = resolve(value);
  const outputs = {};
  const execute = Object.getPrototypeOf(async function () {}).constructor;
  await new execute('github', 'context', 'core', 'process', 'require', resolve(entry.with.script))(
    store.github,
    context,
    { ...store.core, setOutput: (name, value) => (outputs[name] = value) },
    { env: environment },
    createRequire(import.meta.url),
  );
  return outputs;
}

// Composite failure() reads the composite's status. Conditions without a status
// function have an implicit success() guard, including every later normal step.
function stepRuns(entry, values, compositeStatus) {
  const expression = String(entry.if ?? 'success()').replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  if (!/\b(always|success|failure|cancelled)\(\)/.test(expression) && compositeStatus !== 'success') return false;
  const resolved = expression
    .replace(/\b(always|success|failure|cancelled)\(\)/g, (_, name) =>
      String(name === 'always' || name === compositeStatus),
    )
    .replace(/\b(?:inputs|steps|github)[\w.-]+/g, (key) => JSON.stringify(values[key] ?? ''));
  return Boolean(Function(`return (${resolved})`)());
}

async function runComposite({
  failingStep,
  eventName,
  mode,
  requireApproval,
  approved,
  runtimeDirectory,
  captureOutcome = 'success',
  context = eventContext(eventName),
  store = statusStore(approved ? [approvedStatus()] : []),
}) {
  const values = {
    'inputs.mode': mode,
    'inputs.require-approval': requireApproval ? 'true' : 'false',
    'inputs.fail-on-diff': 'true',
    'inputs.comparison-base': 'pull-request-base',
    'inputs.capture-outcome': captureOutcome,
    'inputs.status-context': 'StyleProof',
    'inputs.comment-marker': '<!-- styleproof-report -->',
    'github.event_name': eventName,
    'github.run_id': '900',
    'github.run_attempt': '2',
  };
  let compositeStatus = 'success';
  const executedSteps = [];
  for (const entry of steps) {
    if (!stepRuns(entry, values, compositeStatus)) {
      if (entry.id) values[`steps.${entry.id}.outcome`] = 'skipped';
      continue;
    }
    const name = entry.name ?? entry.id;
    executedSteps.push(name);
    if (name === failingStep) {
      compositeStatus = 'failure';
      if (entry.id) values[`steps.${entry.id}.outcome`] = 'failure';
      continue;
    }
    if (
      [
        'context',
        'Set review failure status',
        'Set certify failure status',
        'Set review status',
        'Mark review status pending',
      ].includes(name)
    ) {
      const outputs = await executeStep(entry, values, store, context, runtimeDirectory);
      for (const [name, value] of Object.entries(outputs)) values[`steps.${entry.id}.outputs.${name}`] = value;
    }
    if (entry.id) values[`steps.${entry.id}.outcome`] = 'success';
  }
  return { ...store, compositeStatus, executedSteps, values };
}

for (const [mode, requireApproval] of [
  ['review-gate', false],
  ['migration', false],
  ['advisory', false],
  ['certify', true],
  ['certify', false],
]) {
  for (const eventName of mode === 'certify' && !requireApproval
    ? ['workflow_run']
    : ['pull_request', 'workflow_run']) {
    for (const failingStep of ['Install StyleProof action runtime', 'context']) {
      for (const approved of [false, true]) {
        test(`${mode}, require approval ${requireApproval}, ${eventName}: ${failingStep} fails on ${approved ? 'approved rerun' : 'first run'}`, async () => {
          const runtimeDirectory = failingStep === 'context' ? actionDirectory : missingRuntimeDirectory;
          const result = await runComposite({
            failingStep,
            eventName,
            mode,
            requireApproval,
            approved,
            runtimeDirectory,
          });
          assert.equal(result.compositeStatus, 'failure');
          assert.equal(result.writes.length, 1, 'failed setup must write a terminal status');
          assert.deepEqual(result.writes[0], {
            ...repository,
            sha: headCommit,
            context: 'StyleProof',
            state: 'failure',
            description: 'StyleProof setup failed — re-run for a verdict',
            target_url: runAddress,
          });
          assert.equal(result.statuses[0].state, 'failure', 'an earlier approval must no longer stand');
          assert.ok(result.statuses[0].description.length <= 140);
          assert.ok(!result.executedSteps.includes('Mark review status pending'));
          if (failingStep !== 'context') {
            assert.ok(!result.executedSteps.includes('context'));
            assert.ok(result.warnings.some((message) => /run order.*failing closed/.test(message)));
          }
        });
      }
    }
  }
}

test('a setup failure revokes carry-forward even when a later rerun presents the original approval receipt', async () => {
  const result = await runComposite({
    failingStep: 'context',
    eventName: 'pull_request',
    mode: 'review-gate',
    approved: true,
  });
  const values = {
    'steps.diff.outputs.changed': 'true',
    'steps.verdict.outputs.diff-digest': reviewDigest,
    'steps.context.outputs.pr-number': '7',
    'steps.context.outputs.head-sha': headCommit,
    'steps.review-pending.outputs.prior-status': JSON.stringify(approvedStatus()),
  };
  const context = eventContext('pull_request');
  assert.equal(
    (await executeStep(stepNamed('gate'), values, statusStore([approvedStatus()]), context)).approved,
    'true',
  );
  assert.equal((await executeStep(stepNamed('gate'), values, result, context)).approved, 'false');
  values['steps.review-pending.outputs.prior-status'] = JSON.stringify(result.statuses[0]);
  assert.equal((await executeStep(stepNamed('gate'), values, result, context)).approved, 'false');
});

test('the approve workflow refuses to tick-approve the setup failure description', async () => {
  const workflow = configurationParser.load(
    filesystem.readFileSync(new URL('../.github/workflows/styleproof-approve-reusable.yml', import.meta.url), 'utf8'),
  );
  const script = Object.values(workflow.jobs)
    .flatMap((job) => job.steps)
    .find((entry) => entry.with?.script?.includes('const readPendingStatus =')).with.script;
  const reader = script.slice(
    script.indexOf('const readPendingStatus ='),
    script.indexOf('\n\n', script.indexOf('const readPendingStatus =')),
  );
  const execute = Object.getPrototypeOf(async function () {}).constructor;
  const eligible = new execute(
    'github',
    'context',
    'headSha',
    'STATUS',
    'reportUrl',
    `${reader}\nreturn readPendingStatus();`,
  );
  const store = statusStore([
    {
      ...approvedStatus(),
      state: 'failure',
      description: 'StyleProof setup failed — re-run for a verdict',
      target_url: runAddress,
    },
  ]);
  assert.equal(await eligible(store.github, eventContext('pull_request'), headCommit, 'StyleProof', runAddress), false);
  store.statuses[0].description = 'StyleProof changes need sign-off — tick the box in the report comment';
  assert.equal(await eligible(store.github, eventContext('pull_request'), headCommit, 'StyleProof', runAddress), true);
});

test('failure identity matches the normal resolver for trusted associations and exact-head fork lookup', async () => {
  const { resolveSetupFailureContext } = await import('../scripts/action-setup-failure.mjs');
  for (const eventName of ['pull_request', 'pull_request_target', 'pull_request_review', 'workflow_run']) {
    for (const embedded of [true, false]) {
      const context = eventContext(eventName);
      const store = statusStore();
      const pullRequest = {
        state: 'open',
        number: 7,
        base: { sha: baseCommit },
        head: { sha: headCommit, repo: forkRepository },
      };
      if (!embedded && context.payload.workflow_run) context.payload.workflow_run.pull_requests = [];
      store.github.rest.repos.listPullRequestsAssociatedWithCommit = async () => ({ data: [pullRequest] });
      const normal = await resolveActionContext({ ...context, github: store.github });
      assert.deepEqual(await resolveSetupFailureContext({ ...context, repository, ...store }), {
        pullRequestNumber: Number(normal.prNumber),
        headCommit: normal.headSha,
      });
    }
  }
});

test('failure identity rejects moved heads, closed lookup results and other repositories', async () => {
  const { resolveSetupFailureContext } = await import('../scripts/action-setup-failure.mjs');
  const otherRepository = { id: 1, full_name: 'owner/repo' };
  for (const candidate of [
    { state: 'open', head: { sha: baseCommit, repo: forkRepository } },
    { state: 'closed', head: { sha: headCommit, repo: forkRepository } },
    { state: 'open', head: { sha: headCommit, repo: otherRepository } },
    { state: 'open', head: { sha: headCommit } },
  ]) {
    const context = eventContext('workflow_run');
    context.payload.workflow_run.pull_requests[0].head.repo = otherRepository;
    const store = statusStore();
    store.github.rest.repos.listPullRequestsAssociatedWithCommit = async () => ({
      data: [{ number: 7, ...candidate }],
    });
    assert.equal(await resolveSetupFailureContext({ ...context, repository, ...store }), undefined);
    assert.equal((await resolveActionContext({ ...context, github: store.github })).prNumber, '');
  }
});

test('setup failure uses payload-only head proof without requiring a base or an available lookup API', async () => {
  const { resolveSetupFailureContext, setSetupFailureStatus } = await import('../scripts/action-setup-failure.mjs');
  for (const eventName of ['pull_request', 'pull_request_target', 'pull_request_review', 'workflow_run']) {
    const context = eventContext(eventName);
    const pullRequest = context.payload.pull_request ?? context.payload.workflow_run.pull_requests[0];
    delete pullRequest.base;
    const store = statusStore();
    store.github.rest.repos.listPullRequestsAssociatedWithCommit = async () => {
      throw new Error('offline');
    };
    assert.deepEqual(await resolveSetupFailureContext({ ...context, repository, ...store }), {
      pullRequestNumber: 7,
      headCommit,
    });
    await setSetupFailureStatus({
      ...store,
      context,
      actionPath: missingRuntimeDirectory,
      statusContext: 'Custom status',
      commentMarker: '<!-- custom -->',
      runAttempt: '2',
    });
    assert.equal(store.statuses[0].context, 'Custom status');
    assert.equal(store.statuses[0].state, 'failure');
  }
});

test('unprovable setup failure heads warn and never write a status', async () => {
  const { setSetupFailureStatus } = await import('../scripts/action-setup-failure.mjs');
  for (const payload of [
    { workflow_run: { head_sha: headCommit, head_repository: forkRepository } },
    {
      workflow_run: {
        head_sha: headCommit,
        pull_requests: eventContext('workflow_run').payload.workflow_run.pull_requests,
      },
    },
    { workflow_run: { head_sha: 'short', head_repository: forkRepository } },
  ]) {
    const store = statusStore();
    store.github.rest.repos.listPullRequestsAssociatedWithCommit = async () => {
      throw new Error('offline');
    };
    await setSetupFailureStatus({
      ...store,
      context: { ...eventContext('workflow_run'), payload },
      actionPath: actionDirectory,
      statusContext: 'StyleProof',
    });
    assert.equal(store.writes.length, 0);
    assert.ok(store.warnings.some((message) => /no trusted PR head/.test(message)));
  }
});

test('available supersession helpers preserve a proven newer verdict after setup fails', async () => {
  const { setSetupFailureStatus } = await import('../scripts/action-setup-failure.mjs');
  const store = statusStore([{ ...approvedStatus(), target_url: 'https://github.com/owner/repo/actions/runs/1000' }]);
  await setSetupFailureStatus({
    ...store,
    context: eventContext('pull_request'),
    actionPath: actionDirectory,
    statusContext: 'StyleProof',
    commentMarker: '<!-- styleproof-report -->',
    runAttempt: '2',
  });
  assert.equal(store.writes.length, 0);
  assert.ok(store.messages.some((message) => /later run/.test(message)));
});

for (const [mode, requireApproval] of [
  ['review-gate', false],
  ['migration', false],
  ['advisory', false],
  ['certify', true],
  ['certify', false],
]) {
  for (const eventName of ['workflow_run', 'push', 'issue_comment']) {
    test(`${mode}, require approval ${requireApproval}, ${eventName}: successful context without a pull request stays unresolved after a later failure`, async () => {
      const context = eventContext(eventName);
      delete context.payload.pull_request;
      if (context.payload.workflow_run) context.payload.workflow_run.pull_requests = [];
      const store = statusStore();
      let lookupCount = 0;
      store.github.rest.repos.listPullRequestsAssociatedWithCommit = async () => ({
        data:
          ++lookupCount === 1
            ? []
            : [
                {
                  state: 'open',
                  number: 7,
                  base: { sha: baseCommit },
                  head: { sha: headCommit, repo: forkRepository },
                },
              ],
      });
      const result = await runComposite({
        mode,
        requireApproval,
        eventName,
        context,
        store,
        failingStep: 'Check capture outcome',
        captureOutcome: 'failure',
      });
      assert.equal(result.compositeStatus, 'failure');
      assert.equal(result.values['steps.context.outcome'], 'success');
      assert.equal(result.values['steps.context.outputs.pr-number'], '');
      assert.equal(result.writes.length, 0, 'successful unresolved context must not acquire a new status destination');
      assert.equal(result.warnings.length, 0, 'successful setup must not produce a setup-failed warning');
      assert.equal(
        lookupCount,
        eventName === 'workflow_run' ? 1 : 0,
        'no failure-path PR lookup after context success',
      );
    });
  }
}

for (const name of ['Set review failure status', 'Set certify failure status']) {
  test(`${name}: setup cancellation without composite failure writes no status`, () => {
    assert.equal(
      stepRuns(
        stepNamed(name),
        {
          'inputs.mode': name === 'Set review failure status' ? 'review-gate' : 'certify',
          'inputs.fail-on-diff': 'true',
          'inputs.require-approval': 'false',
          'github.event_name': 'workflow_run',
          'steps.context.outcome': 'skipped',
        },
        'cancelled',
      ),
      false,
    );
  });
}

for (const eventName of ['push', 'issue_comment']) {
  test(`${eventName}: failed context without a pull request warns without writing a status`, async () => {
    const context = eventContext(eventName);
    delete context.payload.pull_request;
    const result = await runComposite({
      mode: 'review-gate',
      eventName,
      context,
      failingStep: 'context',
      runtimeDirectory: missingRuntimeDirectory,
    });
    assert.equal(result.writes.length, 0);
    assert.ok(result.warnings.some((message) => /no trusted PR head/.test(message)));
  });
}

for (const [targetAddress, superseded] of [
  ['https://github.com/owner/repo/actions/runs/1000', true],
  ['https://github.com/owner/repo/actions/runs/1000/artifacts/3', true],
  ['https://github.com/owner/repo/actions/runs/900/attempts/3', true],
  ['https://github.com/owner/repo/actions/runs/900/attempts/2', false],
  ['https://github.com/owner/repo/actions/runs/900', false],
  ['https://github.com/owner/repo/actions/runs/900/artifacts/999', false],
  ['https://github.com/owner/repo/actions/runs/899/attempts/3', false],
  [runAddress.replace('/owner/', '/other/').replace('/900', '/1000'), false],
  ['https://example.test/owner/repo/actions/runs/1000', false],
]) {
  test(`missing runtime status receipt ${targetAddress} supersedes setup failure: ${superseded}`, async () => {
    const { setSetupFailureStatus } = await import('../scripts/action-setup-failure.mjs');
    const store = statusStore([
      { ...approvedStatus(), context: 'Other status', target_url: 'https://github.com/owner/repo/actions/runs/9999' },
      { ...approvedStatus(), target_url: targetAddress },
    ]);
    await setSetupFailureStatus({
      ...store,
      context: eventContext('pull_request'),
      actionPath: missingRuntimeDirectory,
      statusContext: 'StyleProof',
      commentMarker: '<!-- styleproof-report -->',
      runAttempt: '2',
    });
    assert.equal(store.writes.length, superseded ? 0 : 1);
    if (superseded) assert.ok(store.messages.some((message) => /later.*run|later.*attempt/.test(message)));
    else assert.equal(store.statuses[0].state, 'failure');
  });
}

test('missing runtime checks only the newest matching status and fails closed on an unavailable status API', async () => {
  const { setSetupFailureStatus } = await import('../scripts/action-setup-failure.mjs');
  for (const unavailable of [false, true]) {
    const store = statusStore([
      { ...approvedStatus(), target_url: runAddress },
      { ...approvedStatus(), target_url: 'https://github.com/owner/repo/actions/runs/1000' },
    ]);
    if (unavailable)
      store.github.rest.repos.listCommitStatusesForRef = async () => {
        throw new Error('offline');
      };
    await setSetupFailureStatus({
      ...store,
      context: eventContext('pull_request'),
      actionPath: missingRuntimeDirectory,
      statusContext: 'StyleProof',
      commentMarker: '<!-- styleproof-report -->',
      runAttempt: '2',
    });
    assert.equal(store.writes.length, 1);
    assert.equal(store.statuses[0].state, 'failure');
    assert.ok(store.warnings.some((message) => /failing closed/.test(message)));
  }
});

test('failure identity replays the existing action context identity fixtures through both resolvers', async (suite) => {
  const { resolveSetupFailureContext } = await import('../scripts/action-setup-failure.mjs');
  const source = filesystem
    .readFileSync(new URL('./action-context.test.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '');
  const cases = [];
  const execute = Object.getPrototypeOf(async function () {}).constructor;
  const compareResolvers = async (input) => {
    let lookupResponse;
    let lookupParameters;
    const normalClient = {
      rest: {
        repos: {
          listPullRequestsAssociatedWithCommit: async (parameters) => {
            lookupParameters = parameters;
            lookupResponse = await input.github.rest.repos.listPullRequestsAssociatedWithCommit(parameters);
            return lookupResponse;
          },
        },
      },
    };
    const normal = await resolveActionContext({ ...input, github: normalClient });
    const fallbackClient = {
      rest: {
        repos: {
          listPullRequestsAssociatedWithCommit: async (parameters) => {
            assert.ok(lookupResponse, 'fallback lookup must also be required by the normal fixture');
            assert.deepEqual(parameters, lookupParameters);
            return lookupResponse;
          },
        },
      },
    };
    const recovered = await resolveSetupFailureContext({
      ...input,
      repository: input.repo,
      github: fallbackClient,
      core: { warning() {} },
    });
    // A missing/invalid base intentionally prevents a verdict, but not a failure status on a proven head.
    const direct = input.eventName !== 'workflow_run' ? input.payload.pull_request : undefined;
    const headOnly =
      direct?.number > 0 && typeof direct.head?.sha === 'string' && /^[0-9a-f]{40}$/i.test(direct.head.sha);
    const expected = normal.prNumber
      ? { pullRequestNumber: Number(normal.prNumber), headCommit: normal.headSha }
      : headOnly
        ? { pullRequestNumber: direct.number, headCommit: direct.head.sha }
        : undefined;
    assert.deepEqual(recovered, expected);
    return normal;
  };
  await new execute('assert', 'test', 'resolveActionContext', 'reviewStatus', source)(
    assert,
    (name, callback) => {
      if (name.startsWith('resolveActionContext')) cases.push({ name, callback });
    },
    compareResolvers,
    {},
  );
  assert.ok(cases.length >= 8);
  for (const { name, callback } of cases) await suite.test(name, callback);
});
