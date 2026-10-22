import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { needsBrowserLanes } from '../scripts/ci-path-filters.mjs';

/**
 * The stable `required` check must explain why browser proof was either
 * required and complete, or legitimately unnecessary (#839). It used to accept
 * `success` or `skipped` for every browser lane without reading the path
 * filter's `e2e` decision, so browser work that was unexpectedly skipped looked
 * the same as a top-level prose-only change.
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

/** No changed paths: the filter said false and the browser lanes skipped. */
function emptyChange(overrides = {}) {
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

// Replay compiler output captured from the integrity-verified picomatch 2.3.1
// locked by this action revision. This is not a dynamic execution of dorny.
// The separate policy test permits exactly the universal positive pattern;
// keeping the historical ** output reproduces the original hosted false skip.
const compiled = JSON.parse(fs.readFileSync(new URL('./fixtures/ci-path-filter/pinned-regex.json', import.meta.url)));
const patterns = [
  ...fs.readFileSync(new URL('../.github/path-filters.yml', import.meta.url), 'utf8').matchAll(/^ {2}- '([^']+)'$/gm),
].map((match) => match[1]);

test('captured matcher provenance agrees with the pinned action and its compiler options', () => {
  assert.ok(ci.includes(`dorny/paths-filter@${compiled.action.revision} # v3.0.2`));
  assert.equal(compiled.action.revision, '0e4a8c6effa4802afeda77dc8d303f8176d7dfad');
  assert.equal(compiled.picomatch.version, '2.3.1');
  assert.deepEqual(compiled.options, { dot: true });
  assert.deepEqual(
    compiled.patterns.map(({ pattern }) => pattern),
    ['**', '([\\s\\S]+)'],
  );
  assert.ok(patterns.length > 0, 'an empty filter must not make every() vacuously true');
});

for (const term of ['\n', '\r', '\u2028', '\u2029']) {
  for (const file of [`docs/theme${term}.css`, `src/${term}/theme.css`, `${term}theme.css`, `theme.css${term}`]) {
    test(`captured hosted matcher for ${JSON.stringify(file)} makes required reject skipped browsers`, () => {
      const historical = compiled.patterns.find(({ pattern }) => pattern === '**');
      assert.equal(new RegExp(historical.source, historical.flags).test(file), false, 'original hosted symptom');
      const decision =
        patterns.length > 0 &&
        patterns.every((pattern) => {
          const captured = compiled.patterns.find((entry) => entry.pattern === pattern);
          assert.ok(
            captured,
            `unsupported pattern ${pattern}: regenerate pinned compiler evidence and review the policy`,
          );
          return new RegExp(captured.source, captured.flags).test(file);
        });
      const { passed, output } = runRequired(
        emptyChange({
          changes: { result: 'success', outputs: { e2e: String(decision) } },
        }),
      );
      assert.equal(decision, true, `${JSON.stringify(file)} was not selected by the captured hosted matcher`);
      assert.equal(passed, false, output);
      assert.match(output, /E2E_RESULT was 'skipped' \(want success\)/);
    });
  }
}

test('the captured universal pattern selects ordinary and control-character paths but rejects an empty filename', () => {
  const universal = compiled.patterns.find(({ pattern }) => pattern === '([\\s\\S]+)');
  const matcher = new RegExp(universal.source, universal.flags);
  for (const file of ['README.md', '.agents\\theme.css', 'theme.css', '\t.css', '\u0001.css', '\u0085.css']) {
    assert.equal(matcher.test(file), true, JSON.stringify(file));
  }
  assert.equal(matcher.test(''), false);
});

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

test('an empty changed-file inventory with planned browser skips passes', () => {
  const { passed, output } = runRequired(
    emptyChange({ changes: { result: 'success', outputs: { e2e: String(needsBrowserLanes([])) } } }),
  );
  assert.ok(passed, output);
  assert.match(output, /no browser paths changed; browser lanes may skip/);
});

for (const file of [
  'README.md',
  'docs/demo/report.html',
  'docs/demo/theme.css',
  'docs/demo/theme.js',
  'docs/demo/tokens.json',
  'docs/demo/theme.svg',
  'docs/proof/new/report.png',
  'docs/new/theme.future',
  'docs/setup.md',
  '.agents\\theme.css',
]) {
  test(`${file}: the shared path policy makes required reject skipped browser proof`, () => {
    const { passed, output } = runRequired(
      emptyChange({ changes: { result: 'success', outputs: { e2e: String(needsBrowserLanes([file])) } } }),
    );
    assert.equal(passed, false, output);
    assert.match(output, /browser paths changed; e2e shards, evidence and detection corpus must succeed/);
    assert.match(output, /E2E_RESULT was 'skipped' \(want success\)/);
  });
}

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
    test(`an empty inventory still rejects ${lane} = '${result}'`, () => {
      const { passed, output } = runRequired(emptyChange({ [lane]: { result } }));
      assert.equal(passed, false, output);
      assert.match(output, new RegExp(`was '${result}' \\(want success or skipped\\)`));
    });
  }
}

for (const result of ['failure', 'cancelled', 'skipped']) {
  test(`a path filter that ended '${result}' is not trusted, even if it said false`, () => {
    const { passed, output } = runRequired(emptyChange({ changes: { result, outputs: { e2e: 'false' } } }));
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
    const { passed, output } = runRequired(emptyChange({ changes }));
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
      ['empty-inventory', emptyChange],
    ]) {
      test(`${kind} change still requires ${job} (node matrix / platform smoke) to succeed, rejecting '${result}'`, () => {
        const { passed, output } = runRequired(change({ [job]: { result } }));
        assert.equal(passed, false, output);
        assert.match(output, /was '.*' \(want success\)/);
      });
    }
  }
}
