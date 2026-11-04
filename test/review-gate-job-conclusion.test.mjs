import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';
import { mkTmp, rmTmp, spawnSyncToCompletion } from './helpers.mjs';
import { reviewRun, headCommit } from './review-gate-test-harness.mjs';

const actionDirectory = new URL('../', import.meta.url).pathname;
const action = yaml.load(fs.readFileSync(new URL('../action.yml', import.meta.url), 'utf8'));
const steps = action.runs.steps;

function condition(expression, values, failed) {
  const source = String(expression ?? 'success()').replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  if (!/\b(always|success|failure|cancelled)\(\)/.test(source) && failed) return false;
  const resolved = source
    .replace(/\b(always|success|failure|cancelled)\(\)/g, (_, name) =>
      String(name === 'always' || (name === 'failure' ? failed : name === 'success' && !failed)),
    )
    .replace(/'([^']*)'|\b(?:inputs|steps|github)[\w.-]+/g, (match, literal) =>
      JSON.stringify(literal ?? values[match] ?? ''),
    );
  return Boolean(Function(`return (${resolved})`)());
}

// Walk the real composite order and conditions. Capture/report/publication are
// successful fixtures; execute runtime setup, diff exit handling, status writing,
// and every terminal shell gate. Only external npm and diff work is substituted.
async function runComposite({
  mode = 'review-gate',
  requireApproval = 'false',
  blocking = true,
  approved = 'false',
  verdict = 'STYLE_REVIEW_REQUIRED',
  captureOutcome = 'success',
  setupExitCode = 0,
  diffExitCode = 1,
  baseCaptureFailed = 'false',
  inventory = { unacknowledged: [], staleAcknowledgements: [] },
} = {}) {
  const directory = mkTmp('styleproof-job-conclusion-');
  try {
    const commands = path.join(directory, 'commands');
    fs.mkdirSync(commands);
    fs.writeFileSync(path.join(commands, 'npm'), `#!/bin/bash\nexit ${setupExitCode}\n`, { mode: 0o755 });
    fs.writeFileSync(
      path.join(commands, 'node'),
      `#!/bin/bash\nif [[ "$1" == */bin/styleproof-diff.mjs ]]; then exit ${diffExitCode}; fi\nexec "$STYLEPROOF_TEST_NODE" "$@"\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(directory, 'styleproof-diff.json'), JSON.stringify({ inventory }));
    fs.mkdirSync(path.join(directory, 'styleproof-report'));
    fs.writeFileSync(path.join(directory, 'styleproof-report/report.json'), '{}');
    fs.writeFileSync(path.join(directory, 'styleproof.config.json'), JSON.stringify({ blocking }));
    const review = reviewRun({ mode });

    if (approved !== 'true') review.statuses.length = 0;

    const values = Object.fromEntries(
      Object.entries(action.inputs).map(([name, input]) => [`inputs.${name}`, String(input.default ?? '')]),
    );
    Object.assign(values, {
      'inputs.mode': mode,
      'inputs.require-approval': requireApproval,
      'inputs.capture-outcome': captureOutcome,
      'inputs.base-capture-failed': baseCaptureFailed,
      'steps.context.outputs.pr-number': '7',
      'steps.context.outputs.base-sha': 'b'.repeat(40),
      'steps.context.outputs.head-sha': headCommit,
      'steps.verdict.outputs.diff-digest': review.values['steps.verdict.outputs.diff-digest'],
      'github.run_id': '900',
      'github.run_attempt': '1',
      'steps.context.outputs.untrusted-capture': 'false',
      'steps.verdict.outputs.state': verdict,
      'steps.gate.outputs.approved': approved,
    });
    const resolve = (source) =>
      String(source).replace(/\$\{\{ (.+?) \}\}/g, (_, expression) => String(expressionValue(expression, values)));
    const statuses = review.statusWrites;
    const failures = [];
    const completed = [];
    const statusIndex = steps.findIndex((entry) => entry.name === 'Set review status');
    const trustIndex = steps.findIndex((entry) => entry.id === 'trust');
    for (const [index, entry] of steps.entries()) {
      if (!condition(entry.if, values, failures.length > 0)) continue;
      const name = entry.name ?? entry.id;
      const environment = {
        ...process.env,
        PATH: `${commands}:${process.env.PATH}`,
        GITHUB_ACTION_PATH: actionDirectory,
        GITHUB_WORKSPACE: directory,
        GITHUB_OUTPUT: path.join(directory, 'outputs'),
        RUNNER_TEMP: directory,
        STYLEPROOF_TEST_NODE: process.execPath,
        ...Object.fromEntries(Object.entries(entry.env ?? {}).map(([key, value]) => [key, resolve(value)])),
      };
      if (entry.id === 'config' || name === 'Set review status') {
        const outputs = {};
        const program = new (Object.getPrototypeOf(async function () {}).constructor)(
          'github',
          'context',
          'core',
          'process',
          'require',
          resolve(entry.with.script),
        );
        await program(
          review.github,
          {
            repo: { owner: 'owner', repo: 'repo' },
            runId: 900,
            eventName: 'pull_request',
            payload: { repository: { default_branch: 'main' } },
          },
          {
            setOutput: (key, value) => {
              outputs[key] = value;
            },
            info() {},
          },
          { env: environment },
          () => ({ existsSync: () => false }),
        );
        for (const [key, value] of Object.entries(outputs)) values[`steps.${entry.id}.outputs.${key}`] = value;
      } else if (
        entry.run &&
        (name === 'Install StyleProof action runtime' ||
          name === 'Check capture outcome' ||
          entry.id === 'diff' ||
          (index > statusIndex && index < trustIndex))
      ) {
        const result = spawnSyncToCompletion('bash', ['-e', '-o', 'pipefail', '-c', resolve(entry.run)], {
          cwd: directory,
          env: environment,
          encoding: 'utf8',
        });
        if (result.status !== 0) failures.push({ name, status: result.status, output: result.stderr + result.stdout });
        if (entry.id === 'diff' && result.status === 0) {
          values['steps.diff.outputs.changed'] = diffExitCode === 0 ? 'false' : 'true';
        }
      }
      completed.push(name);
    }
    return { failures, statuses, completed, blocking: values['steps.config.outputs.blocking'] };
  } finally {
    rmTmp(directory);
  }
}

function expressionValue(expression, values) {
  return (
    expression
      .split(' || ')
      .map((key) => values[key])
      .find(Boolean) ?? ''
  );
}

const reviewModes = [
  { mode: 'review-gate', requireApproval: 'false' },
  { mode: 'migration', requireApproval: 'false' },
  { mode: 'certify', requireApproval: 'true' },
];

for (const settings of reviewModes) {
  for (const blocking of [true, false]) {
    for (const approved of ['false', 'true']) {
      test(`completed ${settings.mode}, require-approval ${settings.requireApproval}, blocking ${blocking}, approved ${approved} keeps the job green`, async () => {
        const result = await runComposite({ ...settings, blocking, approved });
        assert.deepEqual(result.failures, [], 'review must gate only the commit status');
        assert.equal(result.blocking, String(blocking), 'both boolean policies remain accepted');
        assert.equal(result.statuses.length, 1);
        assert.equal(result.statuses[0].state, approved === 'true' ? 'success' : 'failure');
        assert.equal(result.statuses[0].context, 'StyleProof');
        assert.ok(result.completed.includes('Block on unapprovable certification failures'));
      });
    }
  }
  for (const [name, scenario, failureStep, failureStatus] of [
    ['capture failure', { captureOutcome: 'failure' }, 'Check capture outcome', 1],
    ['setup failure', { setupExitCode: 17 }, 'Install StyleProof action runtime', 17],
    ['invalid inputs', { mode: 'invalid' }, 'diff', 2],
    ['diff crash', { diffExitCode: 137 }, 'diff', 137],
    ['degraded baseline', { baseCaptureFailed: 'true', verdict: 'DEGRADED_BASELINE' }, 'Block on degraded baseline', 1],
    ['partial baseline', { verdict: 'PARTIAL_BASELINE' }, 'Block on partial baseline', 1],
    ['certification failure', { verdict: 'CERTIFICATION_FAILED' }, 'Block on unapprovable certification failures', 1],
    ['data residue', { verdict: 'DATA_RESIDUE_UNACKNOWLEDGED' }, 'Block on unapprovable certification failures', 1],
    [
      'inventory removal',
      { verdict: 'INVENTORY_REMOVAL_UNACKNOWLEDGED', inventory: { unacknowledged: ['route:/settings'] } },
      'Block on unacknowledged navigable removals',
      1,
    ],
  ]) {
    test(`${settings.mode}, require-approval ${settings.requireApproval} still fails the job on ${name}`, async () => {
      const result = await runComposite({ ...settings, ...scenario });
      assert.deepEqual(
        result.failures.map(({ name, status }) => ({ name, status })),
        [{ name: failureStep, status: failureStatus }],
      );
      if (['capture failure', 'setup failure', 'invalid inputs', 'diff crash'].includes(name)) {
        assert.deepEqual(result.statuses, [], 'failed processing cannot publish a successful review verdict');
      }
    });
  }
}

test('certify still fails the job on a diff', async () => {
  const result = await runComposite({ mode: 'certify' });
  assert.deepEqual(
    result.failures.map(({ name }) => name),
    ['Fail on diff'],
  );
});

for (const settings of [{ mode: 'advisory' }, { blocking: 'advisory' }]) {
  test(`advisory styles remain green for ${JSON.stringify(settings)}`, async () => {
    const result = await runComposite(settings);
    assert.deepEqual(result.failures, []);
    assert.equal(result.statuses[0].state, 'success');
  });
}
