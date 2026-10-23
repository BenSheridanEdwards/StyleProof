import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Certify mode with fail-on-diff fails the job on any reviewable change ("Fail on
 * diff") and never sets a review status. These tests execute the Action's real
 * comment program from action.yml: its footer must say the certify gate failed (or
 * passed) the job, never that StyleProof is advisory or that a check stays green,
 * even when styleproof.config sets blocking: 'advisory' (#938).
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const actionYml = fs.readFileSync(path.join(root, 'action.yml'), 'utf8');
const nativeRequire = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const REPOSITORY = 'acme/app';
const ARTIFACT_URL = `https://github.com/${REPOSITORY}/actions/runs/9001/artifacts/77`;
const CERTIFY_GATE_EXPRESSION =
  "inputs.fail-on-diff == 'true' && inputs.require-approval != 'true' && inputs.mode == 'certify'";

/** Compile the comment step with its env: block, substituting every expression. */
function commentProgram(values) {
  const step = actionYml.match(/- name: Upsert PR comment\n[\s\S]*?(?=\n {4}#|\n {4}- name:|\n {4}- id:)/);
  assert.ok(step, 'action.yml should contain the Upsert PR comment step');
  const resolve = (expression) => {
    assert.ok(Object.hasOwn(values, expression), `no test value for \${{ ${expression} }}`);
    return values[expression];
  };
  const environment = {};
  const envBlock = step[0].match(/\n {6}env:\n([\s\S]*?)\n {6}with:/);
  for (const [, name, expression] of envBlock[1].matchAll(/^ {8}([A-Z_]+): \$\{\{ (.+?) \}\}$/gm)) {
    environment[name] = resolve(expression);
  }
  const script = step[0]
    .match(/script: \|\n([\s\S]*)$/)[1]
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n')
    .replace(/\$\{\{ (.+?) \}\}/g, (_, expression) => resolve(expression));
  return { environment, program: new AsyncFunction('require', 'github', 'context', 'core', script) };
}

async function commentBody({
  mode = 'certify',
  failOnDiff = 'true',
  requireApproval = 'false',
  untrusted = false,
  blocking = 'true',
  changed,
  trustState = changed ? 'STYLE_REVIEW_REQUIRED' : 'NO_REVIEWABLE_STYLE_CHANGES',
}) {
  const { environment, program } = commentProgram({
    'steps.context.outputs.pr-number': '42',
    'steps.context.outputs.head-sha': 'c'.repeat(40),
    'steps.context.outputs.untrusted-capture': untrusted ? 'true' : 'false',
    'steps.diff.outputs.changed': changed ? 'true' : 'false',
    'steps.gate.outputs.approved': 'false',
    'steps.gate.outputs.approver': '',
    'steps.verdict.outputs.state': trustState,
    'steps.config.outputs.blocking': blocking,
    'steps.publish.outputs.url || steps.report-artifact.outputs.artifact-url': ARTIFACT_URL,
    'steps.report-artifact.outputs.artifact-digest': 'd'.repeat(64),
    'steps.publish.outputs.sha': '',
    'steps.report.outputs.content-changes': '0',
    'toJSON(inputs.comment-marker)': JSON.stringify('<!-- styleproof-report -->'),
    'github.run_id': '9001',
    'github.run_attempt': '1',
    'inputs.mode': mode,
    [CERTIFY_GATE_EXPRESSION]: String(
      failOnDiff.toLowerCase() === 'true' &&
        requireApproval.toLowerCase() !== 'true' &&
        mode.toLowerCase() === 'certify',
    ),
    'inputs.status-context': 'StyleProof',
    'inputs.base-capture-failed': 'false',
    'inputs.report-storage': 'artifact',
    'inputs.require-approval': requireApproval,
    'inputs.include-content': 'false',
    'inputs.report-retention-days': '30',
  });
  const comments = [];
  const github = {
    paginate: async (route, params) => (await route(params)).data,
    rest: {
      issues: {
        listComments: async () => ({ data: [] }),
        createComment: async (input) => comments.push(input),
        updateComment: async () => assert.fail('unexpected comment update'),
      },
    },
  };
  const context = { repo: { owner: 'acme', repo: 'app' }, runId: 9001, payload: { repository: { private: false } } };
  const core = { setOutput() {}, info() {} };
  const requireForScript = (specifier) => (specifier === 'fs' ? { existsSync: () => false } : nativeRequire(specifier));
  const previous = { ...process.env };
  Object.assign(process.env, environment, { GITHUB_ACTION_PATH: root });
  try {
    await program(requireForScript, github, context, core);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
  assert.equal(comments.length, 1);
  return comments[0].body;
}

const ADVISORY = /advisory|remains green/i;

test('a failing certify run says the certify gate fails the job, not that StyleProof is advisory', async () => {
  for (const blocking of ['true', 'advisory']) {
    const body = await commentBody({ blocking, changed: true });
    assert.doesNotMatch(body, ADVISORY, `blocking: ${blocking}`);
    assert.match(body, /Certify mode: .*the certify gate fails this job/, `blocking: ${blocking}`);
    assert.match(body, /rebuild the map with `styleproof-map` and rerun the report/);
  }
});

test('a clean certify run says certification passes, not that StyleProof is advisory', async () => {
  for (const blocking of ['true', 'advisory']) {
    const body = await commentBody({ blocking, changed: false });
    assert.doesNotMatch(body, ADVISORY, `blocking: ${blocking}`);
    assert.match(body, /Certify mode: no reviewable computed-style changes — certification passes\./);
  }
});

test('runs that never fail on a diff keep the advisory footer', async () => {
  for (const scenario of [
    { mode: 'advisory', changed: true },
    { mode: 'certify', failOnDiff: 'false', changed: true },
  ]) {
    const body = await commentBody(scenario);
    assert.match(body, /Advisory-only mode: StyleProof is advisory for this repository\./, JSON.stringify(scenario));
    assert.doesNotMatch(body, /certify gate/);
  }
});

test('a certify evidence failure keeps its own trust guidance', async () => {
  const body = await commentBody({ changed: true, trustState: 'CERTIFICATION_FAILED' });
  assert.match(body, /reviewer approval cannot clear this failure/);
  assert.doesNotMatch(body, /certify gate/);
});

test('a fork capture in certify mode never says certification passes', async () => {
  for (const blocking of ['true', 'advisory']) {
    for (const changed of [false, true]) {
      const body = await commentBody({ untrusted: true, blocking, changed });
      assert.match(body, /Fork PR — .*StyleProof cannot certify this pull request/);
      assert.doesNotMatch(body, /certification passes|remains green/i);
      if (changed) assert.match(body, /the certify gate fails this job/);
      else assert.doesNotMatch(body, /certify gate fails/);
      assert.doesNotMatch(body, /Approve all changes/);
    }
  }
});

test('a fork capture with fail-on-diff disabled never claims certification or a failing gate', async () => {
  const body = await commentBody({ untrusted: true, failOnDiff: 'false', changed: true });
  assert.match(body, /StyleProof cannot certify this pull request/);
  assert.doesNotMatch(body, /certify gate fails|certification passes/);
});

test('mixed-case fail-on-diff matches the Fail on diff gate', async () => {
  for (const failOnDiff of ['True', 'TRUE']) {
    const body = await commentBody({ failOnDiff, changed: true });
    assert.match(body, /the certify gate fails this job/);
    assert.doesNotMatch(body, ADVISORY);
  }
  const body = await commentBody({ failOnDiff: 'False', changed: true });
  assert.match(body, /Advisory-only mode: StyleProof is advisory/);
});

test('mixed-case require-approval shows the approval box', async () => {
  const body = await commentBody({
    mode: 'certify',
    requireApproval: 'True',
    changed: true,
    trustState: 'STYLE_REVIEW_REQUIRED',
  });
  assert.match(body, /- \[ \] \*\*Approve all changes\*\*/);
  assert.match(body, /Tick \*\*Approve all changes\*\*/);
  assert.doesNotMatch(body, /certify gate/);
});

test("the comment's certify gate is the Fail on diff condition", () => {
  const failIf = actionYml.match(/- name: Fail on diff\n\s+if: (.+)\n/)?.[1];
  const gateExpression = actionYml
    .match(/- name: Upsert PR comment\n[\s\S]*?(?=\n {4}#|\n {4}- name:|\n {4}- id:)/)?.[0]
    .match(/STYLEPROOF_CERTIFY_GATE: \$\{\{ (.+?) \}\}/)?.[1];
  assert.equal(gateExpression, CERTIFY_GATE_EXPRESSION);
  assert.equal(failIf, `steps.diff.outputs.changed == 'true' && ${gateExpression}`);
});
