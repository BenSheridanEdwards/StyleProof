import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import yaml from 'js-yaml';

const steps = yaml.load(fs.readFileSync(new URL('../action.yml', import.meta.url), 'utf8')).runs.steps;
// Evaluate the workflow conditions, including GitHub's implicit success() guard.

function enabled(step, mode, failed) {
  const condition = String(step.if ?? 'success()').replace(/\$\{\{|\}\}/g, '');

  if (failed && !/\b(?:always|failure|cancelled|success)\(/.test(condition)) return false;

  const values = {
    inputs: { mode, 'require-approval': 'false', 'fail-on-diff': 'true' },
    github: { event_name: 'pull_request' },
    steps: Object.fromEntries(
      steps.filter((step) => step.id).map((step) => [step.id, { outputs: { 'pr-number': '7' } }]),
    ),
  };

  const expression = condition.replace(/\b(?:inputs|github|steps)(?:\.[\w-]+)+/g, (path) => {
    const value = path.split('.').reduce((current, key, index) => (index ? current?.[key] : values[key]), undefined);

    return value === undefined ? 'undefined' : JSON.stringify(value);
  });

  return new Function('success', 'failure', 'always', 'cancelled', `return !!(${expression});`)(
    () => !failed,
    () => failed,
    () => true,
    () => false,
  );
}

for (const mode of ['review-gate', 'migration', 'advisory']) {
  test(`1146: ${mode} clears earlier success before processing and fails closed on a rerun`, () => {
    const processing = steps.findIndex((step) => step.id === 'diff');

    const pending = steps.findIndex(
      (step) => /state:\s*'pending'/.test(step.with?.script ?? '') && enabled(step, mode, false),
    );

    assert.ok(
      pending >= 0 && pending < processing,
      `${mode}: no pending-first status before diff; earlier success survives a processing failure`,
    );
  });
  test(`1146: ${mode} replaces earlier success when processing fails`, () => {
    const processing = steps.findIndex((step) => step.id === 'diff');

    const failure = steps.findIndex(
      (step) => /state:\s*'failure'/.test(step.with?.script ?? '') && enabled(step, mode, true),
    );

    assert.ok(failure > processing, `${mode}: no failure status step enabled by failure()`);
  });
}
