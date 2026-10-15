import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The stable `required` check must explain why browser proof was either
 * required and complete, or legitimately unnecessary (#839). It used to accept
 * `success` or `skipped` for every browser lane without reading the path
 * filter's `e2e` decision, so browser work that was unexpectedly skipped looked
 * the same as a docs-only change.
 *
 * These tests EXECUTE the real step from ci.yml. Each case builds a GitHub
 * `needs` context, resolves the step's own `env:` expressions against it, and
 * runs the step's `run:` body under bash. A change to either the env wiring or
 * the shell policy is exercised here, not string-matched.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const ci = fs.readFileSync(path.join(here, '..', '.github/workflows/ci.yml'), 'utf8');

function requiredStep() {
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

function runRequired(needs) {
  const env = { PATH: process.env.PATH };
  for (const [name, expression] of Object.entries(step.env)) env[name] = resolve(expression, needs);
  const result = spawnSync('bash', ['-c', step.body], { env, encoding: 'utf8' });
  return { passed: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

/** A complete product (browser) change: the filter said true and every lane ran green. */
function productChange(overrides = {}) {
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

/** A docs-only change: the filter said false and the browser lanes skipped. */
function docsOnlyChange(overrides = {}) {
  return productChange({
    changes: { result: 'success', outputs: { e2e: 'false' } },
    e2e: { result: 'skipped' },
    'e2e-evidence': { result: 'skipped' },
    'detection-corpus': { result: 'skipped' },
    ...overrides,
  });
}

const browserLanes = ['e2e', 'e2e-evidence', 'detection-corpus'];
const badResults = ['skipped', 'cancelled', 'failure', ''];

test('the required step reads the path-filter e2e output and every needed job result', () => {
  assert.equal(step.env.E2E_DECISION, 'needs.changes.outputs.e2e');
  assert.equal(step.env.CHANGES_RESULT, 'needs.changes.result');
  const needs = ci.match(/\n {2}required:\n(?: {4}.+\n)*? {4}needs: \[([^\]]+)\]/)?.[1].split(', ');
  assert.deepEqual(needs, ['changes', 'build', 'e2e', 'e2e-evidence', 'cli-smoke', 'detection-corpus']);
  for (const job of needs.filter((name) => name !== 'changes')) {
    assert.ok(Object.values(step.env).includes(`needs.${job}.result`), `required reads needs.${job}.result`);
  }
});

test('product change with complete browser proof passes', () => {
  const { passed, output } = runRequired(productChange());
  assert.ok(passed, output);
  assert.match(output, /browser paths changed; e2e shards, evidence and detection corpus must succeed/);
});

test('docs-only change with planned browser skips passes', () => {
  const { passed, output } = runRequired(docsOnlyChange());
  assert.ok(passed, output);
  assert.match(output, /no browser paths changed; browser lanes may skip/);
});

test('product change rejects all browser lanes skipped', () => {
  const skipped = { result: 'skipped' };
  const { passed, output } = runRequired(
    productChange({ e2e: skipped, 'e2e-evidence': skipped, 'detection-corpus': skipped }),
  );
  assert.equal(passed, false, output);
  assert.match(output, /E2E_RESULT was 'skipped' \(want success\)/);
});

for (const lane of browserLanes) {
  for (const result of badResults) {
    test(`product change rejects ${lane} = '${result}' (mixed lane results)`, () => {
      const { passed, output } = runRequired(productChange({ [lane]: { result } }));
      assert.equal(passed, false, output);
      assert.match(output, new RegExp(`was '${result}' \\(want success\\)`));
    });
  }
  for (const result of ['cancelled', 'failure', '']) {
    test(`docs-only change still rejects ${lane} = '${result}'`, () => {
      const { passed, output } = runRequired(docsOnlyChange({ [lane]: { result } }));
      assert.equal(passed, false, output);
      assert.match(output, new RegExp(`was '${result}' \\(want success or skipped\\)`));
    });
  }
}

for (const result of ['failure', 'cancelled', 'skipped']) {
  test(`a path filter that ended '${result}' is not trusted, even if it said false`, () => {
    const { passed, output } = runRequired(docsOnlyChange({ changes: { result, outputs: { e2e: 'false' } } }));
    assert.equal(passed, false, output);
    assert.match(output, /CHANGES_RESULT was/);
    assert.match(output, /untrusted \(path filter did not succeed\)/);
  });
}

for (const [label, changes] of [
  ['missing outputs', { result: 'success' }],
  ['missing e2e output', { result: 'success', outputs: {} }],
  ['empty e2e output', { result: 'success', outputs: { e2e: '' } }],
  ['malformed e2e output TRUE', { result: 'success', outputs: { e2e: 'TRUE' } }],
  ['malformed e2e output False', { result: 'success', outputs: { e2e: 'False' } }],
  ['malformed e2e output "false "', { result: 'success', outputs: { e2e: 'false ' } }],
  ['malformed e2e output 0', { result: 'success', outputs: { e2e: '0' } }],
]) {
  test(`${label}: fails closed with skipped browser lanes`, () => {
    const { passed, output } = runRequired(docsOnlyChange({ changes }));
    assert.equal(passed, false, output);
    assert.match(output, /want true or false/);
  });
  test(`${label}: fails closed even when browser lanes succeeded`, () => {
    const { passed, output } = runRequired(productChange({ changes }));
    assert.equal(passed, false, output);
    assert.match(output, /want true or false/);
  });
}

for (const job of ['build', 'cli-smoke']) {
  for (const result of badResults) {
    for (const [kind, change] of [
      ['product', productChange],
      ['docs-only', docsOnlyChange],
    ]) {
      test(`${kind} change still requires ${job} (node matrix / platform smoke) to succeed, rejecting '${result}'`, () => {
        const { passed, output } = runRequired(change({ [job]: { result } }));
        assert.equal(passed, false, output);
        assert.match(output, /was '.*' \(want success\)/);
      });
    }
  }
}
