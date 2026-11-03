import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import yaml from 'js-yaml';
import { mkTmp, rmTmp } from './helpers.mjs';

const action = yaml.load(fs.readFileSync(new URL('../action.yml', import.meta.url), 'utf8'));
const steps = action.runs.steps;
const step = (name) => steps.find((entry) => entry.name === name || entry.id === name);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const marker = '<!-- styleproof-report -->';

function expressionValue(expression, values = {}, outcome = 'success') {
  const source = String(expression ?? 'success()').replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  const resolved = source
    .replace(/\b(always|success|failure|cancelled)\(\)/g, (_, name) => String(name === 'always' || name === outcome))
    .replace(/\b(?:inputs|steps|github)[\w.-]+/g, (key) => JSON.stringify(values[key] ?? ''));
  return Function(`return (${resolved})`)();
}

// Evaluate the source condition, including GitHub's implicit success() guard.
function condition(expression, values = {}, outcome = 'success') {
  if (!/\b(always|success|failure|cancelled)\(\)/.test(expression ?? '') && outcome !== 'success') return false;
  return Boolean(expressionValue(expression, values, outcome));
}

async function program(
  name,
  values = {},
  { comments = [], statuses = [], head = A, state = 'open', unavailable = false } = {},
) {
  const entry = step(name);
  assert.ok(entry, name);
  const outputs = {};
  const writes = [];
  const logs = [];
  const github = {
    paginate: async () => {
      if (unavailable) throw new Error('offline');
      return comments;
    },
    rest: {
      issues: {
        listComments() {},
        createComment: async (request) => writes.push(request),
        updateComment: async (request) => writes.push(request),
      },
      pulls: { get: async () => ({ data: { state, head: { sha: head } } }) },
      repos: {
        listCommitStatusesForRef: async () => {
          if (unavailable) throw new Error('offline');
          return { data: statuses };
        },
        createCommitStatus: async (request) => statuses.unshift(request),
        getCollaboratorPermissionLevel: async () => ({ data: { permission: 'read' } }),
      },
    },
  };
  const defaults = {
    'steps.context.outputs.head-sha': A,
    'steps.context.outputs.pr-number': '7',
    'inputs.status-context': 'StyleProof',
    'inputs.comment-marker': marker,
    'toJSON(inputs.comment-marker)': JSON.stringify(marker),
    'github.run_id': '100',
    'github.run_attempt': '2',
    'steps.delivery.outputs.upload': 'false',
    'steps.verdict.outputs.state': 'STYLE_REVIEW_REQUIRED',
    'inputs.mode': 'review-gate',
    'inputs.report-storage': 'artifact',
    'inputs.report-retention-days': '14',
    'inputs.capture-outcome': 'success',
  };
  const resolve = (text) => String(text).replace(/\$\{\{ (.+?) \}\}/g, (_, key) => values[key] ?? defaults[key] ?? '');
  const env = { GITHUB_ACTION_PATH: new URL('../', import.meta.url).pathname };
  for (const [key, value] of Object.entries(entry.env ?? {})) env[key] = resolve(value);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('github', 'context', 'core', 'process', 'require', resolve(entry.with.script))(
    github,
    {
      repo: { owner: 'owner', repo: 'repo' },
      runId: 100,
      eventName: 'pull_request',
      payload: { repository: { private: false } },
    },
    {
      setOutput: (key, value) => {
        outputs[key] = value;
      },
      info: (message) => logs.push(message),
      warning() {},
    },
    { env },
    (name) => (name === 'fs' ? { existsSync: () => false } : createRequire(import.meta.url)(name)),
  );
  return { outputs, writes, statuses, logs };
}

for (const outcome of [
  'failure',
  'cancelled',
  'timed_out',
  'skipped',
  'startup_failure',
  'action_required',
  'invalid',
]) {
  test(`capture ${outcome} fails before pending, diff and comment`, () => {
    assert.equal(action.inputs['capture-outcome']?.default, 'success');
    const early = step('Check capture outcome');
    assert.ok(early);
    assert.equal(steps.indexOf(early), steps.indexOf(step('context')) + 1);
    assert.ok(steps.indexOf(early) < steps.indexOf(step('review-pending')));
    assert.equal(condition(early.if, {}, outcome === 'cancelled' ? 'cancelled' : 'success'), true);
    const result = spawnSync('bash', ['-c', early.run], {
      encoding: 'utf8',
      env: { ...process.env, STYLEPROOF_CAPTURE_OUTCOME: outcome },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /capture|cancelled/i);
    for (const name of ['diff', 'review-pending', 'certify-pending', 'comment', 'publish']) {
      assert.equal(condition(step(name).if, {}, 'failure'), false, name);
    }
  });
}

for (const outcome of ['failure', 'cancelled']) {
  test(`review terminal status runs on ${outcome}`, () => {
    assert.equal(
      condition(
        step('Set review failure status').if,
        {
          'steps.context.outputs.pr-number': '7',
          'inputs.mode': 'review-gate',
        },
        outcome,
      ),
      true,
    );
  });
}

for (const [capture, cancelled, description] of [
  ['action_required', '', 'StyleProof capture awaits workflow approval — approve, then re-run'],
  ['failure', '', 'StyleProof capture failed — re-run for a verdict'],
  ['skipped', '', 'StyleProof capture failed — re-run for a verdict'],
  ['startup_failure', '', 'StyleProof capture failed — re-run for a verdict'],
  ['cancelled', '', 'StyleProof run cancelled — re-run for a verdict'],
  ['timed_out', '', 'StyleProof run cancelled — re-run for a verdict'],
  ['success', 'true', 'StyleProof run cancelled — re-run for a verdict'],
  ['success', '', 'StyleProof run failed — see the run'],
]) {
  test(`terminal description for capture ${capture}, job cancelled ${cancelled}`, async () => {
    const statuses = [{ context: 'StyleProof', state: 'success', description: 'Approved by @reviewer' }];
    await program(
      'Set review failure status',
      { 'inputs.capture-outcome': capture, 'steps.run-cancelled.outputs.cancelled': cancelled },
      { statuses },
    );
    assert.equal(statuses[0].state, 'failure');
    assert.equal(statuses[0].description, description);
    assert.ok(description.length <= 140);
    assert.equal(statuses[0].target_url, 'https://github.com/owner/repo/actions/runs/100');
  });
}

test('cancellation marker uses the real cancelled() condition', () => {
  const entry = step('run-cancelled');
  assert.ok(entry);
  assert.equal(condition(entry.if, {}, 'cancelled'), true);
  assert.equal(condition(entry.if, {}, 'failure'), false);
});

for (const proof of ['status', 'comment', 'none', 'unavailable']) {
  test(`failure write orders runs with ${proof} evidence and fails closed`, async () => {
    const statuses =
      proof === 'status'
        ? [{ context: 'StyleProof', target_url: 'https://github.com/owner/repo/actions/runs/200', state: 'success' }]
        : [];
    const comments =
      proof === 'comment'
        ? [
            {
              user: { type: 'Bot', login: 'github-actions[bot]' },
              body: `${marker}\n<!-- styleproof-sha:${A} -->\n<!-- styleproof-run-id:200 run-attempt:1 -->`,
            },
          ]
        : [];
    await program('Set review failure status', {}, { statuses, comments, unavailable: proof === 'unavailable' });
    assert.equal(
      statuses[0]?.state,
      ['status', 'comment'].includes(proof) ? (proof === 'status' ? 'success' : undefined) : 'failure',
    );
  });
}

for (const [head, existingHead, existingRun, stale, count] of [
  [B, B, '200', 'false', 0],
  [A, A, '200', 'true', 0],
  [A, A, '99', 'false', 1],
]) {
  test(`comment delivery orders head ${head[0]}, receipt ${existingHead[0]} run ${existingRun}`, async () => {
    const body = `${marker}\n<!-- styleproof-sha:${existingHead} -->\n<!-- styleproof-run-id:${existingRun} run-attempt:1 -->`;
    const result = await program(
      'comment',
      {},
      { head, comments: [{ id: 1, user: { type: 'Bot', login: 'github-actions[bot]' }, body }] },
    );
    assert.equal(result.outputs['stale-delivery'], stale);
    assert.equal(result.writes.length, count);
  });
}

for (const workflow of ['single', 'split'])
  for (const storage of ['artifact', 'branch'])
    for (const mode of ['certify', 'review-gate', 'advisory']) {
      test(`scaffold ${workflow}/${storage}/${mode} delivers failed captures and isolates concurrency`, () => {
        const root = mkTmp();
        try {
          fs.writeFileSync(`${root}/package.json`, '{"name":"fixture","private":true}');
          // Invoke from the fixture, as consumers do.
          const init = spawnSync(
            process.execPath,
            [
              new URL('../bin/styleproof-init.mjs', import.meta.url).pathname,
              '--workflow',
              workflow,
              '--storage',
              storage,
              '--mode',
              mode,
              '--external-server',
            ],
            { cwd: root, encoding: 'utf8' },
          );
          assert.equal(init.status, 0, init.stderr);
          const capture = yaml.load(fs.readFileSync(`${root}/.github/workflows/styleproof.yml`, 'utf8'));
          const job = capture.jobs[workflow === 'single' ? 'styleproof' : 'capture'];
          assert.equal(capture.concurrency, undefined);
          assert.equal(job.concurrency['cancel-in-progress'], true);
          assert.match(job.concurrency.group, /github.workflow/);
          assert.match(job.concurrency.group, /github.event.pull_request.number/);
          for (const name of ['publish-base', 'prune', 'sweep'])
            if (capture.jobs[name]) assert.equal(capture.jobs[name].concurrency, undefined);
          const report =
            workflow === 'single'
              ? job
              : yaml.load(fs.readFileSync(`${root}/.github/workflows/styleproof-report.yml`, 'utf8')).jobs.report;
          const actionStep = report.steps.find((entry) => entry.uses?.includes('BenSheridanEdwards/StyleProof@'));
          for (const outcome of ['failure', 'cancelled']) assert.equal(condition(actionStep.if, {}, outcome), true);
          if (workflow === 'single') assert.equal(actionStep.with['capture-outcome'], '${{ steps.maps.outcome }}');
          else {
            for (const outcome of ['success', 'failure', 'cancelled', 'timed_out', 'startup_failure']) {
              assert.equal(
                condition(report.if, {
                  'github.event.workflow_run.event': 'pull_request',
                  'github.event.workflow_run.conclusion': outcome,
                }),
                true,
              );
            }
            assert.equal(
              condition(report.if, {
                'github.event.workflow_run.event': 'pull_request',
                'github.event.workflow_run.conclusion': 'skipped',
              }),
              false,
            );
            const download = report.steps.find((entry) => entry.uses?.startsWith('actions/download-artifact'));
            assert.ok(download.id);
            for (const entry of [download, report.steps.find((entry) => entry.id === 'capture-meta')]) {
              assert.equal(condition(entry.if, { 'github.event.workflow_run.conclusion': 'failure' }), false);
              assert.equal(condition(entry.if, { 'github.event.workflow_run.conclusion': 'success' }), true);
            }
            for (const conclusion of ['success', 'failure', 'cancelled', 'timed_out']) {
              for (const downloadOutcome of ['success', 'failure', 'cancelled', 'skipped']) {
                assert.equal(
                  expressionValue(actionStep.with['capture-outcome'], {
                    'github.event.workflow_run.conclusion': conclusion,
                    [`steps.${download.id}.outcome`]: downloadOutcome,
                  }),
                  conclusion === 'success' ? downloadOutcome : conclusion,
                );
              }
            }
            assert.equal(
              condition(report.if, {
                'github.event.workflow_run.event': 'push',
                'github.event.workflow_run.conclusion': 'failure',
              }),
              false,
            );
            assert.match(actionStep.with['capture-outcome'], /github.event.workflow_run.conclusion/);
            assert.match(actionStep.with['capture-outcome'], new RegExp(`steps\\.${download.id}\\.outcome`));
            assert.equal(report.concurrency['cancel-in-progress'], true);
            assert.match(report.concurrency.group, /head_repository.full_name/);
            assert.match(report.concurrency.group, /head_branch/);
          }
        } finally {
          rmTmp(root);
        }
      });
    }

for (const name of [
  'comment',
  'status',
  'publish',
  'report-artifact',
  'Set review failure status',
  'Set certify failure status',
]) {
  test(`a delayed run marked stale by pending cannot write through ${name}`, async () => {
    const statuses = [
      { context: 'StyleProof', state: 'failure', target_url: 'https://github.com/owner/repo/actions/runs/200' },
    ];
    const result = await program('review-pending', {}, { statuses });
    assert.equal(result.outputs['stale-delivery'], 'true');
    const values = {
      'steps.context.outputs.pr-number': '7',
      'inputs.mode': name === 'Set certify failure status' ? 'certify' : 'review-gate',
      'inputs.fail-on-diff': 'true',
      'inputs.report-storage': name === 'publish' ? 'branch' : 'artifact',
      'steps.delivery.outputs.upload': 'true',
      'github.event_name': 'workflow_run',
      'steps.review-pending.outputs.stale-delivery': result.outputs['stale-delivery'],
    };
    const outcome = name.includes('failure') ? 'failure' : 'success';
    // Evaluate the real YAML guard: run 200 failed without creating a comment receipt.
    assert.equal(condition(step(name).if, values, outcome), false);
    assert.equal(result.writes.length, 0);
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].state, 'failure');
    assert.equal(statuses[0].target_url, 'https://github.com/owner/repo/actions/runs/200');
  });
}

test('capture failure in an older attempt preserves a newer attempt receipt', async () => {
  const comments = [
    {
      user: { type: 'Bot', login: 'github-actions[bot]' },
      body: `${marker}\n<!-- styleproof-sha:${A} -->\n<!-- styleproof-run-id:100 run-attempt:3 -->`,
    },
  ];
  const result = await program('Set review failure status', {}, { comments });
  assert.equal(result.statuses.length, 0);
});

for (const outcome of ['failure', 'cancelled']) {
  test(`split certify delivers terminal failure on ${outcome}, direct certify sets no status`, async () => {
    const values = {
      'steps.context.outputs.pr-number': '7',
      'inputs.mode': 'certify',
      'inputs.fail-on-diff': 'true',
      'inputs.require-approval': 'false',
      'github.event_name': 'workflow_run',
    };
    assert.equal(condition(step('Set certify failure status').if, values, outcome), true);
    assert.equal(
      condition(step('Set certify failure status').if, { ...values, 'github.event_name': 'pull_request' }, outcome),
      false,
    );
    assert.equal(
      condition(step('Set review failure status').if, { ...values, 'github.event_name': 'pull_request' }, outcome),
      false,
    );
    const result = await program('Set certify failure status');
    assert.equal(result.statuses[0].state, 'failure');
    assert.equal(result.statuses[0].sha, A);
  });
}

test('a moved PR head skips only the comment; same-head later receipt skips both deliveries', () => {
  const values = { 'steps.context.outputs.pr-number': '7', 'inputs.mode': 'review-gate' };
  assert.equal(condition(step('status').if, { ...values, 'steps.comment.outputs.stale-delivery': 'false' }), true);
  assert.equal(condition(step('status').if, { ...values, 'steps.comment.outputs.stale-delivery': 'true' }), false);
});

for (const name of ['Set review failure status', 'Set certify failure status']) {
  for (const [state, head, count] of [
    ['open', A, 1],
    ['closed', A, 0],
    ['open', B, 0],
    ['closed', B, 0],
  ]) {
    test(`${name}: failed capture checks live PR ${state} at head ${head[0]}`, async () => {
      const result = await program(name, { 'inputs.capture-outcome': 'failure' }, { state, head });
      assert.equal(result.statuses.length, count);
      if (count === 0) assert.ok(result.logs.some((message) => /closed|head moved/.test(message)));
      else assert.equal(result.statuses[0].state, 'failure');
    });
  }
}

test('an unrelated app cannot preserve an approved status using a forged cross-run receipt', async () => {
  const statuses = [{ context: 'StyleProof', state: 'success', description: 'Approved by @reviewer' }];
  const comments = [
    {
      user: { type: 'Bot', login: 'other-app[bot]' },
      body: `${marker}\n<!-- styleproof-sha:${A} -->\n<!-- styleproof-run-id:999999999999 run-attempt:1 -->`,
    },
  ];
  await program('Set review failure status', { 'inputs.capture-outcome': 'failure' }, { statuses, comments });
  assert.equal(statuses[0].state, 'failure');
});

test('split certify capture awaiting approval has a distinct unapprovable failure', async () => {
  const result = await program('Set certify failure status', { 'inputs.capture-outcome': 'action_required' });
  assert.equal(result.statuses[0].state, 'failure');
  assert.equal(result.statuses[0].description, 'StyleProof capture awaits workflow approval — approve, then re-run');
  assert.ok(result.statuses[0].description.length <= 140);
});
