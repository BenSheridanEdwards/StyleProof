import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commentStepExpressions, runActionComment } from './action-comment-harness.mjs';

const PINNED = {
  'github.run_attempt': 'run receipt, not copy',
  'github.run_id': 'run receipt, not copy',
  'inputs.github-token': 'credential, never rendered',
  'inputs.report-retention-days': 'one artifact expiry line; its value does not change wording',
  'inputs.status-context': 'a name interpolated into the footer',
  'steps.context.outputs.head-sha': 'receipt marker',
  'steps.context.outputs.pr-number': 'link path',
  'steps.delivery.outputs.upload': 'a skipped upload posts no report content',
  'steps.publish.outputs.sha': 'link path',
  'steps.publish.outputs.url || steps.report-artifact.outputs.artifact-url': 'link path (follows storage)',
  'steps.report-artifact.outputs.artifact-digest': 'receipt marker',
  'steps.verdict.outputs.diff-digest': 'receipt marker',
  'toJSON(inputs.comment-marker)': 'hidden marker',
};
// This focused smoke pins these inputs; broader combinations belong to the later matrix.
PINNED['inputs.base-capture-failed'] = 'public branch-storage review-gate smoke default';
PINNED["inputs.fail-on-diff == 'true' && inputs.require-approval != 'true' && inputs.mode == 'certify'"] =
  'public branch-storage review-gate smoke default';
PINNED['inputs.include-content'] = 'public branch-storage review-gate smoke default';
PINNED['inputs.mode'] = 'public branch-storage review-gate smoke default';
PINNED['inputs.report-storage'] = 'public branch-storage review-gate smoke default';
PINNED['inputs.require-approval'] = 'public branch-storage review-gate smoke default';
PINNED['steps.config.outputs.blocking'] = 'public branch-storage review-gate smoke default';
PINNED['steps.context.outputs.untrusted-capture'] = 'public branch-storage review-gate smoke default';
PINNED['steps.diff.outputs.changed'] = 'public branch-storage review-gate smoke default';
PINNED['steps.report.outputs.content-changes'] = 'public branch-storage review-gate smoke default';
PINNED['steps.verdict.outputs.state'] = 'public branch-storage review-gate smoke default';
const VARIED = [];

test('the harness varies or pins every input the comment step reads', () => {
  const unaccounted = commentStepExpressions().filter((e) => !VARIED.includes(e) && !(e in PINNED));
  assert.deepEqual(unaccounted, []);
});

test('posts a public branch-storage review-gate report', async () => {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-comment-'));
  try {
    fs.writeFileSync(path.join(reportDir, 'report.md'), '## 🗺️ StyleProof report\n\nTiny report.\n');
    fs.writeFileSync(path.join(reportDir, 'report.json'), '{}');
    const body = await runActionComment({ reportDir, mode: 'review-gate', trustState: 'STYLE_REVIEW_REQUIRED' });
    assert.match(body, /StyleProof report/);
    assert.match(body, /View the side-by-side visual report →/);
    assert.ok(body.includes(`https://github.com/BenSheridanEdwards/StyleProof/blob/${'a'.repeat(40)}/pr-42/report.md`));
    assert.match(body, /\[ \]/);
  } finally {
    fs.rmSync(reportDir, { recursive: true, force: true });
  }
});
