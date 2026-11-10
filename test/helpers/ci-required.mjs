import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { load } from 'js-yaml';

const ci = fs.readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');

export function requiredStep(source = ci) {
  const job = load(source).jobs.required;
  assert.ok(job, 'ci.yml has no required job');
  const step = job.steps.find((candidate) => candidate.env?.E2E_DECISION);
  assert.ok(step?.run, 'required step must declare env and run');
  const env = {};
  for (const [name, expression] of Object.entries(step.env)) {
    const match = expression.match(/^\$\{\{\s*(needs\.[\w-]+\.(?:result|outputs\.[\w-]+))\s*\}\}$/);
    assert.ok(match, `unexpected env expression in required step: ${expression}`);
    env[name] = match[1];
  }
  return { env, body: step.run };
}

const step = requiredStep();

/** Resolve `needs.<job>.result` / `needs.<job>.outputs.<name>` the way Actions does: missing is ''. */
function resolve(expression, needs) {
  const [, job, ...rest] = expression.split('.');
  let value = needs[job];
  for (const key of rest) value = value?.[key];
  return value === undefined ? '' : String(value);
}

export function runRequired(needs) {
  const env = { PATH: process.env.PATH };
  for (const [name, expression] of Object.entries(step.env)) env[name] = resolve(expression, needs);
  const result = spawnSync('bash', ['-c', step.body], { env, encoding: 'utf8' });
  return { passed: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

/** A complete browser change: the decider said true and every lane ran green. */
export function productChange(overrides = {}) {
  return {
    changes: { result: 'success', outputs: { e2e: 'true' } },
    build: { result: 'success' },
    coverage: { result: 'success' },
    'coverage-shards': { result: 'success' },
    'cli-smoke': { result: 'success' },
    e2e: { result: 'success' },
    'e2e-evidence': { result: 'success' },
    'detection-corpus': { result: 'success' },
    ...overrides,
  };
}

/** Proven identical trees: the decider said false and browser lanes skipped. */
export function sameTreeChange(overrides = {}) {
  return productChange({
    changes: { result: 'success', outputs: { e2e: 'false', e2e_proof: `same-tree:${'a'.repeat(40)}` } },
    e2e: { result: 'skipped' },
    'e2e-evidence': { result: 'skipped' },
    'detection-corpus': { result: 'skipped' },
    ...overrides,
  });
}
