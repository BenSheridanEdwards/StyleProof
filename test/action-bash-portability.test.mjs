import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * The Action's shell steps must survive `set -u` on bash 3.2 — what macOS
 * ships, and therefore what every self-hosted macOS runner executes.
 *
 * Regression (#457): the report step ran `set -euo pipefail` and then expanded
 * `"${state_identity_arguments[@]}"`. That array is EMPTY whenever
 * `require-state-identity` is false — the default — and bash 3.2 treats an
 * empty array expansion under `set -u` as an unbound variable (bash 4.4 fixed
 * this). Every macOS consumer's report step died with
 *
 *     line 16: state_identity_arguments[@]: unbound variable
 *
 * which skipped publication and terminated the run as CERTIFICATION_FAILED —
 * a total visual-gate outage that looked like a certification problem rather
 * than a shell portability bug.
 *
 * This test executes the REAL step bodies from action.yml under the system
 * bash with the empty-array configuration, so the guard cannot regress.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const actionYml = fs.readFileSync(path.join(here, '..', 'action.yml'), 'utf8');

/** Pull a `run: |` block out of action.yml by a line it uniquely contains. */
function runBlockContaining(uniqueLine) {
  const lines = actionYml.split('\n');
  const anchor = lines.findIndex((line) => line.includes(uniqueLine));
  assert.notEqual(anchor, -1, `action.yml no longer contains: ${uniqueLine}`);
  let start = anchor;
  while (start >= 0 && !/^\s+run: \|/.test(lines[start])) start -= 1;
  assert.notEqual(start, -1, `no run block above: ${uniqueLine}`);
  const indent = lines[start].match(/^(\s+)/)[1] + '  ';
  const body = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() !== '' && !line.startsWith(indent)) break;
    body.push(line.slice(indent.length));
  }
  return body.join('\n');
}

/**
 * Make a step body runnable off-CI: neutralise the GitHub `${{ }}` expressions
 * and replace the node invocation with a recorder, so the test exercises the
 * SHELL semantics (which is where the bug lived) and nothing else.
 */
function runnableStep(body) {
  return (
    body
      .replace(/\$\{\{[^}]*\}\}/g, 'placeholder')
      // Replace only the COMMAND, never its arguments: the array expansions are
      // exactly what is under test, so stripping the whole line would make this
      // test vacuous (it did, on the first attempt).
      .replace(/node "\$GITHUB_ACTION_PATH\/bin\/[a-z-]+\.mjs"/g, 'true')
  );
}

const EMPTY_ARRAY_ENVIRONMENT = {
  ...process.env,
  // Both defaults produce EMPTY argument arrays — the exact configuration that
  // broke every macOS consumer.
  STYLEPROOF_REQUIRE_STATE_IDENTITY: 'false',
  STYLEPROOF_INCLUDE_CONTENT: 'false',
  STYLEPROOF_EXPECTED_BASE_SHA: 'a'.repeat(40),
  STYLEPROOF_EXPECTED_HEAD_SHA: 'b'.repeat(40),
  GITHUB_ACTION_PATH: path.join(here, '..'),
  GITHUB_OUTPUT: '/dev/null',
};

for (const [stepName, uniqueLine] of [
  ['diff', 'styleproof-diff.mjs'],
  ['report', 'styleproof-report.mjs'],
]) {
  test(`the ${stepName} step survives empty argument arrays under set -u (bash 3.2)`, () => {
    const script = runnableStep(runBlockContaining(uniqueLine));
    // `set -u` is forced on regardless of what the step itself sets, so this
    // stays a portability test even if a step's own flags change.
    const result = spawnSync('bash', ['-u', '-c', script], {
      encoding: 'utf8',
      env: EMPTY_ARRAY_ENVIRONMENT,
      cwd: fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'styleproof-action-step-')),
    });
    assert.doesNotMatch(
      result.stderr ?? '',
      /unbound variable/,
      `${stepName} step tripped set -u on an empty array — guard it as ` +
        '${arr[@]+"${arr[@]}"}, which expands to nothing on bash 3.2 ' +
        `instead of erroring.\n${result.stderr}`,
    );
  });
}
