import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const ci = fs.readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');

export function requiredStep() {
  const job = ci.match(/\n {2}required:\n[\s\S]*$/)?.[0];
  assert.ok(job, 'ci.yml has no required job');
  const lines = job.split('\n');
  const envStart = lines.findIndex((line) => line === '        env:');
  const runStart = lines.findIndex((line) => line === '        run: |');
  assert.ok(envStart > 0 && runStart > envStart, 'required step must declare env: then run: |');
  const env = {};
  for (const line of lines.slice(envStart + 1, runStart)) {
    const match = line.match(/^ {10}([A-Z0-9_]+): \$\{\{ (needs\.[\w-]+\.(?:result|outputs\.[\w-]+)) \}\}$/);
    assert.ok(match, `unexpected env line in required step: ${line}`);
    env[match[1]] = match[2];
  }
  const body = [];
  for (const line of lines.slice(runStart + 1)) {
    if (line.trim() !== '' && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return { env, body: body.join('\n') };
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
