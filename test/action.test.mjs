import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { COVERAGE_LEDGER } from '../dist/coverage.js';
import { readMapManifest } from '../dist/map-store.js';
import { fixtureCompatibilityKey, fixtureContentHash, makeMap, writeCapture } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const actionYml = fs.readFileSync(path.join(here, '..', 'action.yml'), 'utf8');
const dogfoodYml = fs.readFileSync(path.join(here, '..', '.github/workflows/action-dogfood.yml'), 'utf8');
const publishBin = fs.readFileSync(path.join(here, '..', 'bin', 'styleproof-publish-report.mjs'), 'utf8');
const publishModule = fs.readFileSync(path.join(here, '..', 'src', 'report-publish.ts'), 'utf8');

function extractActionStep(stepStartPattern, stepEndPattern) {
  return actionYml.match(new RegExp(`${stepStartPattern}[\\s\\S]*?(?=${stepEndPattern})`));
}

function stampActionFixture(dir, sha) {
  fs.writeFileSync(
    path.join(dir, 'styleproof-manifest.json'),
    JSON.stringify({
      version: 1,
      packageVersion: 'test',
      sha,
      dirty: false,
      spec: 'e2e/styleproof.spec.ts',
      specHash: fixtureContentHash('test'),
      platform: process.platform,
      arch: process.arch,
      nodeMajor: process.versions.node.split('.')[0],
      screenshots: false,
      har: false,
      compatibilityKey: fixtureCompatibilityKey('action-receipt-parity-test'),
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  fs.writeFileSync(
    path.join(dir, COVERAGE_LEDGER),
    JSON.stringify({ version: 1, expected: ['home'], exclude: {}, determinism: 'self-checked' }),
  );
}

function actionReportMergeScript() {
  const match = actionYml.match(/ {8}node --input-type=module <<'NODE'\n([\s\S]*?)\n {8}NODE/);
  assert.ok(match, 'action.yml should contain the report merge Node program');
  return `${match[1]
    .split('\n')
    .map((line) => line.replace(/^ {8}/, ''))
    .join('\n')}\n`;
}

test('production diff and report receipts pass through the exact Action merge program', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-action-receipts-'));
  try {
    const before = path.join(root, 'before');
    const after = path.join(root, 'after');
    const state = { id: 'home-ready', revision: 'fixture-v2' };
    const map = {
      ...makeMap({ elements: { 'body > button:nth-child(1)': { tag: 'button', style: { color: 'black' } } } }),
      metadata: { productState: state },
    };
    writeCapture(before, 'home@1280', map, null);
    writeCapture(after, 'home@1280', map, null);
    stampActionFixture(before, 'a'.repeat(40));
    stampActionFixture(after, 'b'.repeat(40));

    const diff = spawnSync(
      process.execPath,
      [
        path.join(here, '..', 'bin/styleproof-diff.mjs'),
        before,
        after,
        '--json',
        'styleproof-diff.json',
        '--expected-before-sha',
        'a'.repeat(40),
        '--expected-after-sha',
        'b'.repeat(40),
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(diff.status, 0, diff.stderr || diff.stdout);
    const report = spawnSync(
      process.execPath,
      [
        path.join(here, '..', 'bin/styleproof-report.mjs'),
        before,
        after,
        '--out',
        'styleproof-report',
        '--expected-before-sha',
        'a'.repeat(40),
        '--expected-after-sha',
        'b'.repeat(40),
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(report.status, 0, report.stderr || report.stdout);

    const mergeScript = path.join(root, 'merge.mjs');
    const output = path.join(root, 'github-output');
    fs.writeFileSync(mergeScript, actionReportMergeScript());
    fs.writeFileSync(output, '');
    const actionEnv = {
      ...process.env,
      STYLEPROOF_INCLUDE_CONTENT: 'false',
      STYLEPROOF_EXPECTED_BASE_SHA: 'a'.repeat(40),
      STYLEPROOF_EXPECTED_HEAD_SHA: 'b'.repeat(40),
      GITHUB_ACTION_PATH: path.join(here, '..'),
      GITHUB_OUTPUT: output,
    };
    const merge = spawnSync(process.execPath, [mergeScript], {
      cwd: root,
      encoding: 'utf8',
      env: actionEnv,
    });
    assert.equal(merge.status, 0, merge.stderr || merge.stdout);

    const reportJsonPath = path.join(root, 'styleproof-report', 'report.json');
    const diffJsonPath = path.join(root, 'styleproof-diff.json');
    const honestReport = JSON.parse(fs.readFileSync(reportJsonPath, 'utf8'));
    const honestDiff = JSON.parse(fs.readFileSync(diffJsonPath, 'utf8'));

    const emptyBefore = path.join(root, 'empty-before');
    fs.mkdirSync(emptyBefore);
    const firstAdoptionDiffPath = path.join(root, 'first-adoption-diff.json');
    const firstAdoptionReportDir = path.join(root, 'first-adoption-report');
    const firstAdoptionDiffRun = spawnSync(
      process.execPath,
      [
        path.join(here, '..', 'bin/styleproof-diff.mjs'),
        emptyBefore,
        after,
        '--json',
        firstAdoptionDiffPath,
        '--expected-before-sha',
        'a'.repeat(40),
        '--expected-after-sha',
        'b'.repeat(40),
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(firstAdoptionDiffRun.status, 3, firstAdoptionDiffRun.stderr || firstAdoptionDiffRun.stdout);
    const firstAdoptionReportRun = spawnSync(
      process.execPath,
      [
        path.join(here, '..', 'bin/styleproof-report.mjs'),
        emptyBefore,
        after,
        '--out',
        firstAdoptionReportDir,
        '--expected-before-sha',
        'a'.repeat(40),
        '--expected-after-sha',
        'b'.repeat(40),
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(firstAdoptionReportRun.status, 1, firstAdoptionReportRun.stderr || firstAdoptionReportRun.stdout);
    const firstAdoptionReport = JSON.parse(fs.readFileSync(path.join(firstAdoptionReportDir, 'report.json'), 'utf8'));
    const firstAdoptionDiff = JSON.parse(fs.readFileSync(firstAdoptionDiffPath, 'utf8'));
    fs.writeFileSync(reportJsonPath, JSON.stringify(firstAdoptionReport));
    fs.writeFileSync(diffJsonPath, JSON.stringify(firstAdoptionDiff));
    const firstAdoption = spawnSync(process.execPath, [mergeScript], {
      cwd: root,
      encoding: 'utf8',
      env: actionEnv,
    });
    assert.equal(firstAdoption.status, 0, firstAdoption.stderr || firstAdoption.stdout);

    const forgedNoCapturePairedReport = structuredClone(honestReport);
    const forgedNoCapturePairedDiff = structuredClone(honestDiff);
    for (const receipt of [forgedNoCapturePairedReport, forgedNoCapturePairedDiff]) {
      receipt.evidenceBinding.before.fileCount = 0;
      receipt.evidenceBinding.before.mapCount = 0;
      receipt.evidenceBinding.before.byteCount = 0;
      receipt.evidenceBinding.before.digest = 'f48e6aba19b611a71a2cd234bf3994d257291364f54080d3ad4f1b5be79902fd';
      receipt.sourceBinding.before.observed = null;
      receipt.sourceBinding.before.result = 'no-capture';
      receipt.sourceBinding.compatibility = 'not-applicable';
    }
    fs.writeFileSync(reportJsonPath, JSON.stringify(forgedNoCapturePairedReport));
    fs.writeFileSync(diffJsonPath, JSON.stringify(forgedNoCapturePairedDiff));
    const forgedNoCapturePaired = spawnSync(process.execPath, [mergeScript], {
      cwd: root,
      encoding: 'utf8',
      env: actionEnv,
    });
    assert.equal(forgedNoCapturePaired.status, 1, forgedNoCapturePaired.stderr || forgedNoCapturePaired.stdout);
    assert.match(forgedNoCapturePaired.stderr, /comparison.*source|topology/i);

    const forgedEmptyReport = structuredClone(firstAdoptionReport);
    const forgedEmptyDiff = structuredClone(firstAdoptionDiff);
    forgedEmptyReport.evidenceBinding.before.digest = 'f'.repeat(64);
    forgedEmptyDiff.evidenceBinding.before.digest = 'f'.repeat(64);
    fs.writeFileSync(reportJsonPath, JSON.stringify(forgedEmptyReport));
    fs.writeFileSync(diffJsonPath, JSON.stringify(forgedEmptyDiff));
    const forgedEmpty = spawnSync(process.execPath, [mergeScript], {
      cwd: root,
      encoding: 'utf8',
      env: actionEnv,
    });
    assert.equal(forgedEmpty.status, 1, forgedEmpty.stderr || forgedEmpty.stdout);
    assert.match(forgedEmpty.stderr, /evidence-binding receipts are missing or malformed/i);

    fs.writeFileSync(reportJsonPath, JSON.stringify(honestReport));
    fs.writeFileSync(diffJsonPath, JSON.stringify(honestDiff));

    const impossibleFileCountReport = structuredClone(honestReport);
    const impossibleFileCountDiff = structuredClone(honestDiff);
    impossibleFileCountReport.evidenceBinding.after.fileCount = 100_001;
    impossibleFileCountDiff.evidenceBinding.after.fileCount = 100_001;
    fs.writeFileSync(reportJsonPath, JSON.stringify(impossibleFileCountReport));
    fs.writeFileSync(diffJsonPath, JSON.stringify(impossibleFileCountDiff));
    const impossibleFileCount = spawnSync(process.execPath, [mergeScript], {
      cwd: root,
      encoding: 'utf8',
      env: actionEnv,
    });
    assert.equal(impossibleFileCount.status, 1, impossibleFileCount.stderr || impossibleFileCount.stdout);
    assert.match(impossibleFileCount.stderr, /evidence-binding receipts are missing or malformed/i);

    fs.writeFileSync(reportJsonPath, JSON.stringify(honestReport));
    fs.writeFileSync(diffJsonPath, JSON.stringify(honestDiff));
    const impossibleByteCountReport = structuredClone(honestReport);
    const impossibleByteCountDiff = structuredClone(honestDiff);
    impossibleByteCountReport.evidenceBinding.after.byteCount = 128 * 1024 * 1024 + 1;
    impossibleByteCountDiff.evidenceBinding.after.byteCount = 128 * 1024 * 1024 + 1;
    fs.writeFileSync(reportJsonPath, JSON.stringify(impossibleByteCountReport));
    fs.writeFileSync(diffJsonPath, JSON.stringify(impossibleByteCountDiff));
    const impossibleByteCount = spawnSync(process.execPath, [mergeScript], {
      cwd: root,
      encoding: 'utf8',
      env: actionEnv,
    });
    assert.equal(impossibleByteCount.status, 1, impossibleByteCount.stderr || impossibleByteCount.stdout);
    assert.match(impossibleByteCount.stderr, /evidence-binding receipts are missing or malformed/i);

    const impossibleMinimumBytesReport = structuredClone(honestReport);
    const impossibleMinimumBytesDiff = structuredClone(honestDiff);
    for (const receipt of [impossibleMinimumBytesReport, impossibleMinimumBytesDiff]) {
      receipt.evidenceBinding.after.fileCount = 3;
      receipt.evidenceBinding.after.mapCount = 1;
      receipt.evidenceBinding.after.byteCount = 1;
    }
    fs.writeFileSync(reportJsonPath, JSON.stringify(impossibleMinimumBytesReport));
    fs.writeFileSync(diffJsonPath, JSON.stringify(impossibleMinimumBytesDiff));
    const impossibleMinimumBytes = spawnSync(process.execPath, [mergeScript], {
      cwd: root,
      encoding: 'utf8',
      env: actionEnv,
    });
    assert.equal(impossibleMinimumBytes.status, 1, impossibleMinimumBytes.stderr || impossibleMinimumBytes.stdout);
    assert.match(impossibleMinimumBytes.stderr, /evidence-binding receipts are missing or malformed/i);

    const populatedEmptyDigestReport = structuredClone(honestReport);
    const populatedEmptyDigestDiff = structuredClone(honestDiff);
    for (const receipt of [populatedEmptyDigestReport, populatedEmptyDigestDiff]) {
      receipt.evidenceBinding.after.digest = 'f48e6aba19b611a71a2cd234bf3994d257291364f54080d3ad4f1b5be79902fd';
    }
    fs.writeFileSync(reportJsonPath, JSON.stringify(populatedEmptyDigestReport));
    fs.writeFileSync(diffJsonPath, JSON.stringify(populatedEmptyDigestDiff));
    const populatedEmptyDigest = spawnSync(process.execPath, [mergeScript], {
      cwd: root,
      encoding: 'utf8',
      env: actionEnv,
    });
    assert.equal(populatedEmptyDigest.status, 1, populatedEmptyDigest.stderr || populatedEmptyDigest.stdout);
    assert.match(populatedEmptyDigest.stderr, /evidence-binding receipts are missing or malformed/i);

    fs.writeFileSync(reportJsonPath, JSON.stringify(honestReport));
    fs.writeFileSync(diffJsonPath, JSON.stringify(honestDiff));
    const impossiblePerFileArithmeticReport = structuredClone(honestReport);
    const impossiblePerFileArithmeticDiff = structuredClone(honestDiff);
    for (const receipt of [impossiblePerFileArithmeticReport, impossiblePerFileArithmeticDiff]) {
      receipt.evidenceBinding.after.fileCount = 2;
      receipt.evidenceBinding.after.mapCount = 1;
      receipt.evidenceBinding.after.byteCount = 128 * 1024 * 1024;
    }
    fs.writeFileSync(reportJsonPath, JSON.stringify(impossiblePerFileArithmeticReport));
    fs.writeFileSync(diffJsonPath, JSON.stringify(impossiblePerFileArithmeticDiff));
    const impossiblePerFileArithmetic = spawnSync(process.execPath, [mergeScript], {
      cwd: root,
      encoding: 'utf8',
      env: actionEnv,
    });
    assert.equal(
      impossiblePerFileArithmetic.status,
      1,
      impossiblePerFileArithmetic.stderr || impossiblePerFileArithmetic.stdout,
    );
    assert.match(impossiblePerFileArithmetic.stderr, /evidence-binding receipts are missing or malformed/i);

    fs.writeFileSync(reportJsonPath, JSON.stringify(honestReport));
    fs.writeFileSync(diffJsonPath, JSON.stringify(honestDiff));
    const emptyEvidenceReport = structuredClone(honestReport);
    const emptyEvidenceDiff = structuredClone(honestDiff);
    for (const receipt of [emptyEvidenceReport, emptyEvidenceDiff]) {
      receipt.evidenceBinding.after.fileCount = 0;
      receipt.evidenceBinding.after.mapCount = 0;
      receipt.evidenceBinding.after.byteCount = 0;
      receipt.evidenceBinding.after.digest = 'f48e6aba19b611a71a2cd234bf3994d257291364f54080d3ad4f1b5be79902fd';
    }
    fs.writeFileSync(reportJsonPath, JSON.stringify(emptyEvidenceReport));
    fs.writeFileSync(diffJsonPath, JSON.stringify(emptyEvidenceDiff));
    const emptyEvidence = spawnSync(process.execPath, [mergeScript], {
      cwd: root,
      encoding: 'utf8',
      env: actionEnv,
    });
    assert.equal(emptyEvidence.status, 1, emptyEvidence.stderr || emptyEvidence.stdout);
    assert.match(emptyEvidence.stderr, /source-binding receipts are missing, malformed/i);

    fs.writeFileSync(reportJsonPath, JSON.stringify(honestReport));
    fs.writeFileSync(diffJsonPath, JSON.stringify(honestDiff));
    const honestDigestToken = `"digest":"${honestReport.evidenceBinding.before.digest}"`;
    const duplicateDigestToken = `"digest":"${'f'.repeat(64)}",${honestDigestToken}`;
    fs.writeFileSync(reportJsonPath, JSON.stringify(honestReport).replace(honestDigestToken, duplicateDigestToken));
    fs.writeFileSync(diffJsonPath, JSON.stringify(honestDiff).replace(honestDigestToken, duplicateDigestToken));
    const duplicateDigest = spawnSync(process.execPath, [mergeScript], {
      cwd: root,
      encoding: 'utf8',
      env: actionEnv,
    });
    assert.equal(duplicateDigest.status, 1, duplicateDigest.stderr || duplicateDigest.stdout);
    assert.match(duplicateDigest.stderr, /duplicate json key|missing or malformed/i);

    fs.writeFileSync(reportJsonPath, JSON.stringify(honestReport));
    fs.writeFileSync(diffJsonPath, JSON.stringify(honestDiff));
    const digestMismatch = structuredClone(honestReport);
    digestMismatch.evidenceBinding.after.digest = 'f'.repeat(64);
    fs.writeFileSync(reportJsonPath, JSON.stringify(digestMismatch));
    const mismatchedEvidence = spawnSync(process.execPath, [mergeScript], {
      cwd: root,
      encoding: 'utf8',
      env: actionEnv,
    });
    assert.equal(mismatchedEvidence.status, 1, mismatchedEvidence.stderr || mismatchedEvidence.stdout);
    assert.match(mismatchedEvidence.stderr, /evidence-binding receipts disagree/i);

    const impossibleSourceBinding = {
      status: 'bound',
      compatibility: 'not-applicable',
      before: { expected: 'a'.repeat(40), observed: null, result: 'no-capture' },
      after: { expected: 'b'.repeat(40), observed: 'b'.repeat(40), result: 'matched' },
    };
    fs.writeFileSync(reportJsonPath, JSON.stringify({ ...honestReport, sourceBinding: impossibleSourceBinding }));
    fs.writeFileSync(diffJsonPath, JSON.stringify({ ...honestDiff, sourceBinding: impossibleSourceBinding }));
    const matchingImpossible = spawnSync(process.execPath, [mergeScript], {
      cwd: root,
      encoding: 'utf8',
      env: actionEnv,
    });
    assert.equal(matchingImpossible.status, 1, matchingImpossible.stderr || matchingImpossible.stdout);
    assert.match(matchingImpossible.stderr, /source-binding receipts are missing, malformed/i);

    fs.writeFileSync(reportJsonPath, JSON.stringify({ ...honestReport, sourceBinding: { status: 'bound' } }));
    fs.writeFileSync(diffJsonPath, JSON.stringify({ ...honestDiff, sourceBinding: { status: 'bound' } }));
    const malformedEqual = spawnSync(process.execPath, [mergeScript], {
      cwd: root,
      encoding: 'utf8',
      env: actionEnv,
    });
    assert.equal(malformedEqual.status, 1, malformedEqual.stderr || malformedEqual.stdout);
    assert.match(malformedEqual.stderr, /source-binding receipts are missing, malformed/i);

    fs.writeFileSync(reportJsonPath, JSON.stringify(honestReport));
    fs.writeFileSync(diffJsonPath, JSON.stringify(honestDiff));
    const contradictory = { ...honestReport };
    contradictory.comparison = {
      ...contradictory.comparison,
      status: 'future-state',
      blocksCertification: false,
    };
    fs.writeFileSync(reportJsonPath, JSON.stringify(contradictory));
    const rejected = spawnSync(process.execPath, [mergeScript], {
      cwd: root,
      encoding: 'utf8',
      env: actionEnv,
    });
    assert.equal(rejected.status, 1, rejected.stderr || rejected.stdout);
    assert.match(rejected.stderr, /report receipts disagree with the validated diff/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('composite action builds its checkout before running local bins', () => {
  const installStep = actionYml.match(/- name: Install StyleProof action runtime[\s\S]*?(?=\n\s{4}#|\n\s{4}- id:)/);

  assert.ok(installStep, 'action.yml should include an action runtime install step');
  assert.match(installStep[0], /npm ci --ignore-scripts/);
  assert.match(installStep[0], /npm run build/);
  assert.doesNotMatch(installStep[0], /npm ci .*--omit=dev/);
});

test('composite action publishes a durable no-change report on a clean first run', () => {
  const reportStep = extractActionStep('- id: report', '\\n\\s{4}#|\\n\\s{4}- id:');
  const publishStep = extractActionStep('- id: publish', '\\n\\s{4}- name: Upsert PR comment');
  const commentStep = extractActionStep('- name: Upsert PR comment', '\\n\\s{4}#|\\n\\s{4}- name:');

  assert.ok(reportStep, 'action.yml should include a local report generation step');
  assert.ok(publishStep, 'action.yml should include a report publish step');
  assert.ok(commentStep, 'action.yml should include a PR comment step');
  assert.doesNotMatch(reportStep[0], /if: steps\.diff\.outputs/);
  assert.match(reportStep[0], /rm -rf styleproof-report/);
  assert.match(reportStep[0], /styleproof-report\.mjs/);
  assert.doesNotMatch(reportStep[0], /styleproof-report\.mjs[^\n]*\|\| true/);
  assert.match(reportStep[0], /report_exit_code=\$\?/);
  assert.match(reportStep[0], /"\$report_exit_code" -ne 0.*"\$report_exit_code" -ne 1/);
  // The run receipt is embedded by the API publisher before upload.
  assert.match(publishStep[0], /styleproof-publish-report\.mjs/);
  assert.match(
    publishBin,
    /styleproof-receipt head-sha:\$\{options\['head-sha'\]\} run-id:\$\{options\['run-id'\]\} run-attempt:\$\{options\['run-attempt'\]\}/,
  );
  assert.match(commentStep[0], /const url =/);
  assert.doesNotMatch(commentStep[0], /if \(!report\)/);
  assert.doesNotMatch(
    dogfoodYml.match(/- id: clean[\s\S]*?(?=\n\s{6}- name: Assert clean output)/)[0],
    /fail-on-diff:/,
  );
});

test('composite action names style certification precisely and can publish advisory content evidence', () => {
  const reportStep = extractActionStep('- id: report', '\\n\\s{4}#|\\n\\s{4}- id:');
  const commentStep = extractActionStep('- name: Upsert PR comment', '\\n\\s{4}#|\\n\\s{4}- name:');
  const statusStep = extractActionStep('- name: Set review status', '\\n\\s{4}#|\\n\\s{4}- name:');

  assert.ok(reportStep, 'action.yml should include a local report generation step');
  assert.ok(commentStep, 'action.yml should include a PR comment step');
  assert.ok(statusStep, 'action.yml should include a review-status step');
  assert.match(actionYml, /include-content:[\s\S]*?default: 'false'/);
  assert.match(actionYml, /content-changes:[\s\S]*?steps\.report\.outputs\.content-changes/);
  assert.match(reportStep[0], /STYLEPROOF_INCLUDE_CONTENT/);
  assert.match(reportStep[0], /--include-content/);
  assert.match(reportStep[0], /generated\.content\.evaluated/);
  assert.match(reportStep[0], /generated\.content\.changes/);
  assert.match(actionYml, /NO_REVIEWABLE_STYLE_CHANGES/);
  assert.match(actionYml, /STYLE_REVIEW_REQUIRED/);
  assert.match(commentStep[0], /Content\/structure was not evaluated/);
  assert.match(commentStep[0], /advisory content\/structure change/);
  assert.match(commentStep[0], /StyleProof is advisory/);
  assert.doesNotMatch(commentStep[0], /To accept: rebuild the map/);
  assert.match(statusStep[0], /No reviewable computed-style changes/);
  assert.doesNotMatch(actionYml, /NO_VISUAL_CHANGES|VISUAL_APPROVAL_REQUIRED|No visual changes/);
});

test('composite action never clones the report branch to publish', () => {
  const publishStep = extractActionStep('- id: publish', '\\n\\s{4}- name: Upsert PR comment');

  assert.ok(publishStep, 'action.yml should include a report publish step');
  // Cloning makes publish cost the size of the whole branch and dies once the
  // branch reaches a few GB; the API publisher costs the size of this report.
  assert.doesNotMatch(publishStep[0], /git clone/);
  assert.doesNotMatch(publishStep[0], /git push/);
  // Transient API failures and the fast-forward race stay inside a bounded
  // retry loop in the publisher module.
  assert.match(publishModule, /maximumAttempts \?\? 5/);
  assert.match(publishModule, /force: false/);
});

test('certify mode fails only when the difference verdict changed', () => {
  const failOnDifferenceStep = actionYml.match(/- name: Fail on diff[\s\S]*?(?=\n\s{4}#|\n\s{4}- name:)/);

  assert.ok(failOnDifferenceStep, 'action.yml should include the certify-mode difference gate');
  assert.match(failOnDifferenceStep[0], /steps\.diff\.outputs\.changed == 'true'/);
  assert.doesNotMatch(failOnDifferenceStep[0], /steps\.diff\.outputs\.report == 'true'/);
});

test('composite action only compares explicit base/head directories', () => {
  assert.match(actionYml, /baseline-dir:[\s\S]*?required: true/);
  assert.doesNotMatch(actionYml, /base-ref:/);
  assert.doesNotMatch(actionYml, /--base-ref/);
  assert.match(actionYml, /styleproof-diff\.mjs" "\$\{\{ inputs\.baseline-dir \}\}" "\$\{\{ inputs\.fresh-dir \}\}"/);
  assert.match(actionYml, /styleproof-report\.mjs" "\$\{\{ inputs\.baseline-dir \}\}" "\$\{\{ inputs\.fresh-dir \}\}"/);
});

test('composite action publishes every generated report crop', () => {
  const publishStep = extractActionStep('- id: publish', '\\n\\s{4}- name: Upsert PR comment');

  assert.ok(publishStep, 'action.yml should include a report publish step');
  // collectReportFiles takes every crops/*.png, not a hardcoded suffix list.
  assert.match(publishBin, /collectReportFiles/);
  assert.match(publishModule, /cropFileName\.endsWith\('\.png'\)/);
  assert.doesNotMatch(publishModule, /-composite\.png|-annotated\.png|-new\.png/);
});

test('composite action binds report commits and links to the exact report revision', () => {
  const publishStep = extractActionStep('- id: publish', '\\n\\s{4}- name: Upsert PR comment');

  assert.ok(publishStep, 'action.yml should include a report publish step');
  assert.match(publishStep[0], /REPORT_SHA='\$\{\{ steps\.context\.outputs\.head-sha \}\}'/);
  // The commit message binds the folder to the exact head SHA, and the
  // advertised links pin the exact published commit.
  assert.match(publishBin, /StyleProof report \$\{options\['report-path'\]\} @ \$\{options\['head-sha'\]\}/);
  assert.match(publishBin, /blob\/\$\{commitSha\}\/\$\{options\['report-path'\]\}\/report\.md/);
  assert.match(publishBin, /raw\.githubusercontent\.com\/\$\{options\.repository\}\/\$\{commitSha\}/);
});

test('composite action marks certify-mode comments with their source head SHA', () => {
  const commentStep = extractActionStep('- name: Upsert PR comment', '\\n\\s{4}#|\\n\\s{4}- name:');

  assert.ok(commentStep, 'action.yml should include a PR comment step');
  assert.match(commentStep[0], /\.\.\.\(headSha \? \[`<!-- styleproof-sha:\$\{headSha\} -->`\] : \[\]\)/);
});

test('action dogfood fixtures are asserted and deterministic unless the scenario overrides trust', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-action-dogfood-'));
  const baseSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  try {
    const generated = spawnSync(
      process.execPath,
      [path.join(here, '..', 'scripts/action-dogfood-fixtures.mjs'), root, baseSha, headSha],
      {
        encoding: 'utf8',
      },
    );
    assert.equal(generated.status, 0, generated.stderr);
    const baseManifest = readMapManifest(path.join(root, 'clean-base'));
    const headManifest = readMapManifest(path.join(root, 'clean-head'));
    assert.equal(baseManifest.sha, baseSha);
    assert.equal(headManifest.sha, headSha);
    assert.equal(baseManifest.compatibilityKey, headManifest.compatibilityKey);
    const clean = JSON.parse(fs.readFileSync(path.join(root, 'clean-base', 'styleproof-coverage.json'), 'utf8'));
    assert.deepEqual(clean.expected, ['home']);
    assert.equal(clean.determinism, 'self-checked');
    const newHead = JSON.parse(fs.readFileSync(path.join(root, 'new-head', 'styleproof-coverage.json'), 'utf8'));
    assert.deepEqual(newHead.expected, ['home', 'pricing']);
    const certfail = JSON.parse(fs.readFileSync(path.join(root, 'certfail-head', 'styleproof-coverage.json'), 'utf8'));
    assert.deepEqual(certfail.expected, ['home']);
    assert.equal(certfail.determinism, 'unproven');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dogfood workflow runs the local composite action against every trust-state class', () => {
  assert.doesNotMatch(dogfoodYml, /workflow_dispatch/);
  assert.match(
    dogfoodYml,
    /node scripts\/action-dogfood-fixtures\.mjs action-dogfood '\$\{\{ github\.event\.pull_request\.base\.sha \}\}' '\$\{\{ github\.event\.pull_request\.head\.sha \}\}'/,
  );
  assert.match(dogfoodYml, /uses: \.\/\n/g);
  assert.equal(dogfoodYml.match(/uses: \.\//g)?.length, 9);
  assert.match(dogfoodYml, /action-dogfood\/clean-base/);
  assert.match(dogfoodYml, /action-dogfood\/changed-base/);
  assert.match(dogfoodYml, /action-dogfood\/new-base/);
  assert.match(dogfoodYml, /action-dogfood\/residue-base/);
  assert.match(dogfoodYml, /action-dogfood\/removed-base/);
  assert.match(dogfoodYml, /action-dogfood\/degraded-base/);
  assert.match(dogfoodYml, /steps\.clean\.outputs\.report-url }}'/);
  assert.match(dogfoodYml, /steps\.changed\.outputs\.changed }}' = 'true'/);
  assert.match(dogfoodYml, /steps\.new-surface\.outputs\.changed }}' = 'true'/);
  assert.match(dogfoodYml, /steps\.clean\.outputs\.trust-state }}' = 'NO_REVIEWABLE_STYLE_CHANGES'/);
  assert.match(dogfoodYml, /steps\.changed\.outputs\.trust-state }}' = 'STYLE_REVIEW_REQUIRED'/);
  assert.match(dogfoodYml, /steps\.content-advisory\.outputs\.content-changes }}' = '1'/);
  assert.match(dogfoodYml, /Content and structure changes \(advisory\)/);
  assert.match(dogfoodYml, /steps\.residue\.outputs\.trust-state }}' = 'DATA_RESIDUE_UNACKNOWLEDGED'/);
  assert.match(dogfoodYml, /action-dogfood\/partial-base/);
  assert.match(dogfoodYml, /steps\.partial-baseline\.outputs\.trust-state }}' = 'PARTIAL_BASELINE'/);
  assert.match(dogfoodYml, /steps\.degraded\.outputs\.trust-state }}' = 'DEGRADED_BASELINE'/);
  // The inventory removal must FAIL the action even with fail-on-diff off.
  assert.match(dogfoodYml, /steps\.removed\.outcome }}' = 'failure'/);
  assert.match(dogfoodYml, /steps\.removed\.outputs\.trust-state }}' = 'INVENTORY_REMOVAL_UNACKNOWLEDGED'/);
  // Unproven provenance is dogfooded end-to-end as CERTIFICATION_FAILED — the
  // state 4.6.2's content-geometry bug hid in, undetected because it was never
  // exercised here.
  assert.match(dogfoodYml, /action-dogfood\/certfail-base/);
  assert.match(dogfoodYml, /steps\.certfail\.outputs\.trust-state }}' = 'CERTIFICATION_FAILED'/);
  assert.match(dogfoodYml, /steps\.certfail\.outcome }}' = 'failure'/);
});

test('composite action classifies every non-certifying coverage/determinism basis as CERTIFICATION_FAILED', () => {
  const verdict = actionYml.match(/- id: verdict[\s\S]*?(?=\n\s{4}- id:|\n\s{4}- name:|\n\s{4}#)/);
  assert.ok(verdict, 'action.yml should classify the diff before approval/status logic');
  assert.match(verdict[0], /diff\.coverage\?\.basis !== 'complete'/);
  assert.match(verdict[0], /diff\.determinism\?\.status !== 'proven'/);
  assert.doesNotMatch(verdict[0], /basis === 'incomplete'/);
  assert.doesNotMatch(verdict[0], /status === 'unproven'/);
});

test('composite action treats inaccessible confidence as CERTIFICATION_FAILED', () => {
  const report = actionYml.match(/- id: report[\s\S]*?(?=\n\s{4}- id: verdict)/);
  assert.ok(report, 'report step should merge confidence into the machine diff payload');
  assert.match(report[0], /diff\.confidence = generated\.confidence/);
  const verdict = actionYml.match(/- id: verdict[\s\S]*?(?=\n\s{4}- id:|\n\s{4}- name:|\n\s{4}#)/);
  assert.ok(verdict);
  assert.match(verdict[0], /diff\.confidence\?\.counts\?\.inaccessible/);
  assert.match(verdict[0], /CERTIFICATION_FAILED/);
});

test('composite action exposes one precedence-ordered machine-readable trust verdict', () => {
  assert.match(actionYml, /trust-state:[\s\S]*?steps\.trust\.outputs\.state/);
  assert.match(actionYml, /data-residue-keys:[\s\S]*?steps\.verdict\.outputs\.data-residue-keys/);
  const verdict = actionYml.match(/- id: verdict[\s\S]*?(?=\n\s{4}- id:|\n\s{4}- name:|\n\s{4}#)/);
  assert.ok(verdict, 'action.yml should classify the diff before approval/status logic');
  const residue = verdict[0].indexOf("state = 'DATA_RESIDUE_UNACKNOWLEDGED'");
  const inventory = verdict[0].indexOf("state = 'INVENTORY_REMOVAL_UNACKNOWLEDGED'");
  const certification = verdict[0].indexOf("state = 'CERTIFICATION_FAILED'");
  const partial = verdict[0].indexOf("state = 'PARTIAL_BASELINE'");
  const degraded = verdict[0].indexOf("state = 'DEGRADED_BASELINE'");
  const styleReview = verdict[0].indexOf("state = 'STYLE_REVIEW_REQUIRED'");
  assert.ok(
    residue > 0 &&
      inventory > residue &&
      degraded > inventory &&
      certification > degraded &&
      partial > certification &&
      styleReview > partial,
  );
  // The verdict's degraded-baseline check must accept the same values the
  // GitHub-expression gate downstream accepts (case-insensitive 'true').
  assert.match(verdict[0], /base-capture-failed[^\n]*\.toLowerCase\(\) === 'true'/);
  const terminal = actionYml.match(/- id: trust[\s\S]*$/);
  assert.ok(terminal, 'action.yml should always expose a terminal trust state');
  assert.match(terminal[0], /if: always\(\)/);
  assert.match(terminal[0], /REPORT_PUBLICATION_FAILED/);
  // The trust step names failure DOMAINS, not just "publish wasn't success":
  // publish failure and delivery (comment/status) failure both mean the reviewer
  // may be looking at a stale or absent report; a merely-skipped publish must NOT
  // masquerade as a publication failure.
  assert.match(terminal[0], /publishOutcome === 'failure'/);
  assert.match(terminal[0], /publishOutcome !== 'success'/);
  assert.match(terminal[0], /steps\.comment\.outcome/);
  assert.match(terminal[0], /steps\.status\.outcome/);
  assert.match(actionYml, /- name: Upsert PR comment\n\s+id: comment/);
  assert.match(actionYml, /- name: Set review status\n\s+id: status/);
});

test('composite action hard-gates partial baseline repair debt', () => {
  assert.match(actionYml, /PARTIAL_BASELINE/);
  const gate = actionYml.match(/- name: Block on partial baseline[\s\S]*?(?=\n\s{4}- name:|\n\s{4}- id:|$)/);
  assert.ok(gate, 'action.yml should fail rather than certify ledger-explained baseline gaps');
  assert.match(gate[0], /verdict\.outputs\.state == 'PARTIAL_BASELINE'/);
  assert.match(gate[0], /exit 1/);
  assert.doesNotMatch(gate[0], /require-approval/, 'visual approval cannot clear partial baseline');
});

test('composite action exposes and hard-gates degraded head-only evidence', () => {
  assert.match(actionYml, /base-capture-failed:[\s\S]*?default: 'false'/);
  assert.match(actionYml, /DEGRADED_BASELINE/);
  const gate = actionYml.match(/- name: Block on degraded baseline[\s\S]*?(?=\n\s{4}- name:|\n\s{4}- id:|$)/);
  assert.ok(gate, 'action.yml should fail rather than certify a head-only report');
  assert.match(gate[0], /inputs\.base-capture-failed == 'true'/);
  assert.match(gate[0], /exit 1/);
  assert.doesNotMatch(gate[0], /require-approval/, 'visual approval cannot turn degraded evidence into a comparison');
});

test('composite action hard-gates on unacknowledged navigable removals in both modes', () => {
  // Reads the inventory verdict the diff writes, and fails when a removal is unacknowledged
  // — independent of the style-approval box; on by default (config can opt out).
  assert.match(actionYml, /--json styleproof-diff\.json/);
  const gate = actionYml.match(
    /- name: Block on unacknowledged navigable removals[\s\S]*?(?=\n\s{4}- name:|\n\s{4}- id:|$)/,
  );
  assert.ok(gate, 'action.yml should include the inventory removal gate step');
  assert.match(gate[0], /gate-inventory-removals != 'false'/);
  assert.match(gate[0], /i\.unacknowledged/);
  assert.match(gate[0], /staleAcknowledgements/, 'stale acknowledgements gate too — the ledger must not rot');
  assert.match(gate[0], /exit 1/);
  assert.doesNotMatch(gate[0], /require-approval/, 'the removal gate must fire in BOTH modes');
});

test('composite action fails closed on unexpected diff exit codes', () => {
  // A node crash / OOM / SIGTERM (127/137/143/…) must never read as "no changes".
  const diffStep = actionYml.match(/- id: diff[\s\S]*?(?=\n\s{4}- id:|\n\s{4}- name:)/);
  assert.ok(diffStep, 'action.yml should include the diff step');
  assert.match(diffStep[0], /-ne 0.*-ne 1.*-ne 3|failing closed/s, 'unexpected exit codes hard-fail');
});

test('composite action hard-gates the canonical certification verdict the approve box cannot clear', () => {
  const gate = actionYml.match(
    /- name: Block on unapprovable certification failures[\s\S]*?(?=\n\s{4}- name:|\n\s{4}- id:|$)/,
  );
  assert.ok(gate, 'action.yml should include the provenance gate step');
  assert.match(gate[0], /STYLEPROOF_TRUST_STATE/);
  assert.match(gate[0], /steps\.verdict\.outputs\.state/);
  assert.match(gate[0], /CERTIFICATION_FAILED/);
  assert.match(gate[0], /exit 1/);
  assert.doesNotMatch(
    gate[0],
    /coverage\?\.|determinism\?\.|dataResidue\?\.|comparison\?\.|reportConsistency\?\./,
    'the terminal gate must not reimplement a narrower copy of the canonical verdict',
  );
  assert.doesNotMatch(gate[0], /require-approval/, 'the provenance gate must fire in BOTH modes');
});

test('composite action maps raw-only report inconsistency to CERTIFICATION_FAILED not style review', () => {
  const verdict = actionYml.match(/- id: verdict[\s\S]*?(?=\n\s{4}- id:|\n\s{4}- name:|\n\s{4}#)/);
  assert.ok(verdict, 'action.yml should classify the diff before approval/status logic');
  assert.match(verdict[0], /reportConsistency/);
  assert.match(verdict[0], /rawOnlyNoReviewable|raw_only_no_reviewable/);
  // Assignment order: raw-only shares the CERTIFICATION_FAILED branch, which must
  // appear before the STYLE_REVIEW_REQUIRED assignment (state = '…' only).
  const certAssign = verdict[0].indexOf("state = 'CERTIFICATION_FAILED'");
  const styleReviewAssign = verdict[0].indexOf("state = 'STYLE_REVIEW_REQUIRED'");
  assert.ok(
    certAssign > 0 && styleReviewAssign > certAssign,
    'CERTIFICATION_FAILED assignment must outrank style review',
  );
  assert.match(verdict[0], /rawOnlyNoReviewable\) state = 'CERTIFICATION_FAILED'/);
  // Approval checkbox only for STYLE_REVIEW_REQUIRED — never for consistency failure.
  const commentStep = extractActionStep('- name: Upsert PR comment', '\\n\\s{4}#|\\n\\s{4}- name:');
  assert.ok(commentStep, 'PR comment step present');
  assert.match(commentStep[0], /trustState === 'STYLE_REVIEW_REQUIRED'/);
  assert.match(commentStep[0], /report\/diff consistency|reflow source/i);
});

test('composite action classifies report-time correspondence collapse before approval or publication', () => {
  const report = actionYml.match(/- id: report[\s\S]*?(?=\n\s{4}- id:|\n\s{4}- name:|\n\s{4}#)/);
  assert.ok(report, 'action.yml should generate the report before classifying trust');
  assert.match(report[0], /styleproof-report\.mjs/);
  assert.match(report[0], /styleproof-report\/report\.json/);
  assert.match(report[0], /diff\.reportConsistency\s*=\s*generated\.reportConsistency/);
  assert.match(report[0], /isDeepStrictEqual/);
  assert.match(report[0], /report receipts disagree with the validated diff/i);
  assert.doesNotMatch(report[0], /diff\.comparison\s*=\s*generated\.comparison/);
  assert.doesNotMatch(report[0], /diff\.comparability\s*=\s*generated\.comparability/);
  assert.match(report[0], /writeFileSync\('styleproof-diff\.json'/);

  const reportIndex = actionYml.indexOf('- id: report');
  const verdictIndex = actionYml.indexOf('- id: verdict');
  const gateIndex = actionYml.indexOf('- id: gate');
  const publishIndex = actionYml.indexOf('- id: publish');
  assert.ok(
    reportIndex > 0 && verdictIndex > reportIndex,
    'report consistency must exist before verdict classification',
  );
  assert.ok(gateIndex > verdictIndex, 'approval lookup must consume the final trust verdict ordering');
  assert.ok(publishIndex > gateIndex, 'network publication follows local report generation and classification');

  const publish = actionYml.match(/- id: publish[\s\S]*?(?=\n\s{4}- id:|\n\s{4}- name:|\n\s{4}#)/);
  assert.ok(publish);
  assert.doesNotMatch(publish[0], /styleproof-report\.mjs/, 'publication must not regenerate a second report');
});

test('composite action blocks unapproved changes by default (opt out with "blocking": false)', () => {
  // The policy default flipped in v4: absent/blank config → blocking ON, so the config
  // step emits 'true' unless the file explicitly sets "blocking": false.
  const configStep = actionYml.match(/- id: config[\s\S]*?(?=\n\s{4}- id:|\n\s{4}- name:)/);

  assert.ok(configStep, 'action.yml should include a config step');
  assert.match(configStep[0], /const \{ loadStyleProofConfig \} = await import/);
  assert.doesNotMatch(configStep[0], /STYLEPROOF_CONFIG_FILE/);
  assert.match(configStep[0], /StyleProof: loaded styleproof\.config\.json policy/);
  assert.doesNotMatch(configStep[0], /ignoring unreadable styleproof\.config\.json/);
  assert.match(
    configStep[0],
    /core\.setOutput\('blocking', cfg\.blocking === false \? 'false' : 'true'\);/,
    'blocking must default to true — only an explicit false opts out',
  );

  // The block step fails the job on UNAPPROVED review-gate changes, so a repo without a
  // branch-protection rule still gets a red check out of the box.
  const blockStep = actionYml.match(/- name: Block on unapproved changes[\s\S]*?(?=\n\s{4}- name:|\n\s{4}- id:|$)/);
  assert.ok(blockStep, 'action.yml should include the unapproved-changes block step');
  assert.match(blockStep[0], /inputs\.require-approval == 'true'/);
  assert.match(blockStep[0], /steps\.config\.outputs\.blocking == 'true'/);
  assert.match(blockStep[0], /steps\.verdict\.outputs\.state == 'STYLE_REVIEW_REQUIRED'/);
  assert.match(blockStep[0], /steps\.gate\.outputs\.approved != 'true'/);
  assert.match(blockStep[0], /exit 1/);

  // An APPROVED change must NOT hit the block step (approved != 'true' guards it), and
  // certify mode is untouched — the block step is review-gate only.
  assert.doesNotMatch(blockStep[0], /fail-on-diff/);
});

test('composite action requires approval for new-surface-only reports', () => {
  const diffStep = actionYml.match(/- id: diff[\s\S]*?(?=\n\s{4}#|\n\s{4}- id:|\n\s{4}- name:)/);

  assert.ok(diffStep, 'action.yml should include a diff step');
  assert.match(diffStep[0], /\[ "\$code" -eq 1 \] \|\| \[ "\$code" -eq 3 \]/);
  assert.match(diffStep[0], /echo "changed=true"/);
});

test('dogfood workflow runs on every same-repo PR', () => {
  assert.match(dogfoodYml, /pull_request:\s*\n\npermissions:/);
  assert.doesNotMatch(dogfoodYml, /\n\s+paths:/);
});

test('dogfood workflow asserts the PR report comment and branch artifact', () => {
  assert.ok(dogfoodYml.includes('Assert PR report was published'));
  assert.ok(dogfoodYml.includes('<!-- styleproof-report -->'));
  assert.match(dogfoodYml, /blob\/\[0-9a-f\]\{40\}\/\$\{report_path\}/);
  assert.ok(dogfoodYml.includes('/issues/${PR_NUMBER}/comments'));
  assert.ok(dogfoodYml.includes('/contents/${report_path}?ref=${REPORT_BRANCH}'));
  assert.ok(dogfoodYml.includes('Label published report as synthetic dogfood evidence'));
  assert.ok(dogfoodYml.includes('Synthetic action dogfood receipt'));
  assert.ok(dogfoodYml.includes('does not certify this pull request'));
});

test('composite action self-verifies the published receipt before advertising the report URL', () => {
  const publishStep = extractActionStep('- id: publish', '\n\\s{4}- name: Upsert PR comment');

  assert.ok(publishStep, 'action.yml should include a report publish step');
  // The read-back: fetch the report at the EXACT commit being advertised and
  // require the receipt embedded for this run (head SHA + run id + attempt).
  assert.match(publishModule, /application\/vnd\.github\.raw/);
  assert.match(publishModule, /report\.md\?ref=\$\{options\.commitSha\}/);
  assert.match(publishModule, /published\.includes\(options\.expectedReceipt\)/);
  // Fail CLOSED on a dead or mismatched report — never a green run with a bad URL.
  assert.match(publishModule, /do not trust this run's report/);
  // The url/raw-base outputs exist ONLY once verification passed.
  const verifiedIndex = publishBin.indexOf('await verifyPublishedReceipt(');
  const urlIndex = publishBin.indexOf('url=https://github.com/');
  assert.ok(verifiedIndex > 0 && urlIndex > verifiedIndex, 'outputs are written only after the receipt verifies');
});

test('composite action retries transient GitHub API failures on networked github-script steps', () => {
  const networkedSteps = [
    /- id: context[\s\S]*?github-token:[^\n]+\n\s+retries: 3/,
    /- id: gate[\s\S]*?github-token:[^\n]+\n\s+retries: 3/,
    /- name: Upsert PR comment[\s\S]*?github-token:[^\n]+\n\s+retries: 3/,
    /- name: Set review status[\s\S]*?github-token:[^\n]+\n\s+retries: 3/,
  ];
  for (const pattern of networkedSteps) assert.match(actionYml, pattern);
});

test('composite action verdict honors the gateInventoryRemovals opt-out end to end', () => {
  const verdict = extractActionStep('- id: verdict', '\n\\s{4}- id:|\n\\s{4}- name:');
  assert.ok(verdict, 'action.yml should include the verdict step');
  // The opt-out must reach the CLASSIFICATION, not just the job-fail step:
  // without it the commit status stayed an unclearable red (the approval box is
  // only rendered for STYLE_REVIEW_REQUIRED).
  assert.match(verdict[0], /steps\.config\.outputs\.gate-inventory-removals/);
  assert.match(
    verdict[0],
    /gateInventoryRemovals\s*\n?\s*\? \(diff\.inventory|gateInventoryRemovals[\s\S]{0,120}inventory/,
  );
});

test('composite action binds diff and report receipts to trusted GitHub base and head SHAs', () => {
  const contextStep = actionYml.match(/- id: context[\s\S]*?(?=\n\s{4}#|\n\s{4}- id:)/);
  const diffStep = actionYml.match(/- id: diff[\s\S]*?(?=\n\s{4}#|\n\s{4}- id:)/);
  const reportStep = actionYml.match(/- id: report[\s\S]*?(?=\n\s{4}- id: verdict)/);
  assert.ok(contextStep);
  assert.ok(diffStep);
  assert.ok(reportStep);
  assert.match(contextStep[0], /const \{ prNumber, baseSha, headSha \} = await resolveActionContext/);
  assert.match(contextStep[0], /Boolean\(baseSha\)/);
  assert.match(contextStep[0], /core\.setOutput\('base-sha', resolved \? baseSha : ''\)/);
  for (const step of [diffStep[0], reportStep[0]]) {
    assert.match(step, /STYLEPROOF_EXPECTED_BASE_SHA: \$\{\{ steps\.context\.outputs\.base-sha \}\}/);
    assert.match(step, /STYLEPROOF_EXPECTED_HEAD_SHA: \$\{\{ steps\.context\.outputs\.head-sha \}\}/);
    assert.match(step, /--expected-before-sha/);
    assert.match(step, /--expected-after-sha/);
  }
  assert.match(diffStep[0], /trusted base\/head SHA context is required/i);
  assert.match(reportStep[0], /isDeepStrictEqual\(generated\.sourceBinding, diff\.sourceBinding\)/);
});

test('composite action makes required product-state identity a closed-set certification gate', () => {
  const diffStep = actionYml.match(/- id: diff[\s\S]*?(?=\n\s{4}#|\n\s{4}- id:)/);
  const reportStep = actionYml.match(/- id: report[\s\S]*?(?=\n\s{4}- id: verdict)/);
  const verdict = actionYml.match(/- id: verdict[\s\S]*?(?=\n\s{4}- id:|\n\s{4}- name:|\n\s{4}#)/);
  assert.match(actionYml, /require-state-identity:[\s\S]*?default: 'false'/);
  assert.ok(diffStep);
  assert.ok(reportStep);
  assert.ok(verdict);
  assert.match(diffStep[0], /--require-state-identity/);
  assert.match(reportStep[0], /--require-state-identity/);
  assert.match(reportStep[0], /comparisonCertificationReceipt\(generated\.comparison\)/);
  assert.match(reportStep[0], /comparisonCertificationReceipt\(diff\.comparison\)/);
  assert.match(reportStep[0], /isDeepStrictEqual\(generated\.comparability, diff\.comparability\)/);
  assert.doesNotMatch(reportStep[0], /diff\.comparison = generated\.comparison/);
  assert.doesNotMatch(reportStep[0], /diff\.comparability = generated\.comparability/);
  assert.match(verdict[0], /diff\.comparison\?\.blocksCertification === true/);
  assert.ok(
    verdict[0].indexOf('diff.comparison?.blocksCertification === true') <
      verdict[0].indexOf("state = 'STYLE_REVIEW_REQUIRED'"),
    'comparison failure must be classified before approval-required evidence',
  );
});

test('report CLI exposes strict product-state identity mode and passes it to report generation', () => {
  const reportCli = fs.readFileSync(path.join(here, '..', 'bin', 'styleproof-report.mjs'), 'utf8');
  assert.match(reportCli, /--require-state-identity/);
  assert.match(reportCli, /requireStateIdentity/);
  assert.match(reportCli, /generateStyleMapReport\([\s\S]*?requireStateIdentity/);
});
