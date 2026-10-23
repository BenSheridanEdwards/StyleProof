import assert from 'node:assert/strict';
import { runHosted } from './browser-lanes-fixtures.mjs';
import { runRequired, sameTreeChange } from './ci-required.mjs';

export function assertHosted(fixture, expected = true, options = {}) {
  const result = runHosted(fixture, options);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.decision.lanes, expected);
  assert.equal(result.output.lanes, String(expected));
  assert.equal(result.output.proof, result.decision.proof);
  const required = runRequired(
    sameTreeChange({
      changes: { result: 'success', outputs: { e2e: result.output.lanes, e2e_proof: result.output.proof } },
    }),
  );
  assert.equal(required.passed, !expected, required.output);
  return result;
}
