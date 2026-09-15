import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  validateLiveText,
  requireLiveTextCapture,
  LiveTextError,
  containsAgeClockText,
  isAgeOnlyDrift,
  isLiveTextChange,
  auditLiveTextChanges,
  isLiveTextGeometryPath,
  liveTextFreezeError,
} from '../dist/live-text.js';
import { diffContentMaps, diffStyleMaps } from '../dist/diff.js';
import { assessComparisonTruth, isGeometryOnlyGroup } from '../dist/change-groups.js';
import { generateStyleMapReport } from '../dist/report.js';
import { assessCertificationEvidence, classifyStyleProofVerdict } from '../dist/verdict.js';
import { makeMap, rmTmp, solidPng, tmpDirs, writeCapture } from './helpers.mjs';

const AGE_PATH = 'body > span.age:nth-child(1)';

function ageMap({ text, width, liveText, extraStyle } = {}) {
  return {
    ...makeMap({
      elements: {
        [AGE_PATH]: {
          tag: 'span',
          cls: 'age',
          rect: [20, 20, width, 16],
          style: { width: `${width}px`, color: 'rgb(0, 0, 0)', ...extraStyle },
          computedValueStyle: { width: 'auto' },
          ownTextLength: text.length,
          text,
        },
      },
    }),
    ...(liveText ? { metadata: { liveText } } : {}),
  };
}

function ageFinding(widthBefore, widthAfter, textBefore, textAfter) {
  return {
    kind: 'style',
    path: AGE_PATH,
    cls: 'age',
    pseudo: null,
    props: [{ prop: 'width', before: `${widthBefore}px`, after: `${widthAfter}px` }],
    contentLengthSignal: textBefore.length === textAfter.length ? undefined : 'changed',
  };
}

// ── declaration ─────────────────────────────────────────────────────────────

test('validateLiveText: true declares advisory live text; false/undefined is absent', () => {
  assert.deepEqual(validateLiveText(true), { freeze: false, selectors: [] });
  assert.equal(validateLiveText(false), undefined);
  assert.equal(validateLiveText(undefined), undefined);
});

test('validateLiveText: freeze + selectors copy; extra keys and hostile values fail closed', () => {
  assert.deepEqual(validateLiveText({ freeze: true, selectors: ['.age', 'time'] }), {
    freeze: true,
    selectors: ['.age', 'time'],
  });
  assert.throws(() => validateLiveText({ freeze: true, reason: 'open 102.1d' }), LiveTextError);
  assert.throws(() => validateLiveText({ selectors: ['div { color: red }'] }), LiveTextError);
  assert.throws(() => validateLiveText('advisory'), LiveTextError);
  try {
    validateLiveText({ freeze: 'yes' });
    assert.fail('expected throw');
  } catch (error) {
    assert.equal(error instanceof LiveTextError, true);
    assert.equal(String(error).includes('yes'), false);
  }
});

test('requireLiveTextCapture: freeze without captureText fails closed', () => {
  assert.throws(
    () => requireLiveTextCapture({ freeze: true, selectors: [] }, false),
    /freeze requires captureText: true/,
  );
  assert.throws(() => requireLiveTextCapture({ freeze: false, selectors: [] }, false), /requires captureText: true/);
  assert.doesNotThrow(() => requireLiveTextCapture({ freeze: true, selectors: [] }, true));
  assert.doesNotThrow(() => requireLiveTextCapture(undefined, false));
});

// ── age / clock detection ───────────────────────────────────────────────────

test('containsAgeClockText recognizes compact ages, verbose ages, and clocks', () => {
  assert.equal(containsAgeClockText('open 102.1d'), true);
  assert.equal(containsAgeClockText('open 103.1d'), true);
  assert.equal(containsAgeClockText('Last seen 2m ago'), true);
  assert.equal(containsAgeClockText('updated 3 minutes ago'), true);
  assert.equal(containsAgeClockText('as of 14:32'), true);
  assert.equal(containsAgeClockText('just now'), true);
  assert.equal(containsAgeClockText('Updated demo copy'), false);
  assert.equal(containsAgeClockText('version 1.2'), false);
});

test('isAgeOnlyDrift: open 102.1d → open 103.1d is age-only; a label rewrite is not', () => {
  assert.equal(isAgeOnlyDrift('open 102.1d', 'open 103.1d'), true);
  assert.equal(isAgeOnlyDrift('Last seen 2m ago', 'Last seen 3m ago'), true);
  assert.equal(isAgeOnlyDrift('as of 14:32', 'as of 15:01'), true);
  assert.equal(isAgeOnlyDrift('open 102.1d', 'open 102.1d'), false);
  assert.equal(isAgeOnlyDrift('faults open 102.1d', 'open 103.1d'), false);
  assert.equal(isAgeOnlyDrift('Original demo copy', 'Updated demo copy'), false);
});

test('isLiveTextChange: declared selector treats any text on that element as live', () => {
  const change = { kind: 'text', path: AGE_PATH, cls: 'age', before: 'n/a', after: 'ready' };
  assert.equal(isLiveTextChange(change, undefined), false);
  assert.equal(isLiveTextChange(change, { freeze: false, selectors: ['.age'] }, 'span'), true);
  assert.equal(isLiveTextChange(change, { freeze: false, selectors: ['.other'] }, 'span'), false);
});

// ── fixture: age drift as content, not a style finding by itself ────────────

test('fixture: age-only text drift is a content change, not a computed-style finding', () => {
  const before = ageMap({ text: 'open 102.1d', width: 96 });
  const after = ageMap({ text: 'open 103.1d', width: 96 });
  assert.equal(diffStyleMaps(before, after).length, 0);
  const content = diffContentMaps(before, after);
  assert.equal(content.length, 1);
  assert.equal(content[0].kind, 'text');
  assert.equal(content[0].before, 'open 102.1d');
  assert.equal(content[0].after, 'open 103.1d');
  assert.equal(isAgeOnlyDrift(content[0].before, content[0].after), true);
});

test('auditLiveTextChanges: undeclared age drift is detected but not a freeze violation', () => {
  const audit = auditLiveTextChanges(
    'dashboard@1280',
    [{ kind: 'text', path: AGE_PATH, cls: 'age', before: 'open 102.1d', after: 'open 103.1d' }],
    undefined,
  );
  assert.deepEqual(audit.livePaths, [AGE_PATH]);
  assert.equal(audit.declared, false);
  assert.equal(audit.freeze, false);
  assert.equal(audit.violations.length, 0);
});

test('auditLiveTextChanges: freeze declared + age drift is a named violation', () => {
  const audit = auditLiveTextChanges(
    'dashboard@1280',
    [{ kind: 'text', path: AGE_PATH, cls: 'age', before: 'open 102.1d', after: 'open 103.1d' }],
    { freeze: true, selectors: [] },
  );
  assert.equal(audit.declared, true);
  assert.equal(audit.freeze, true);
  assert.equal(audit.violations.length, 1);
  assert.equal(audit.violations[0].before, 'open 102.1d');
  assert.match(liveTextFreezeError(audit), /drifted after a freeze was declared/);
  assert.match(liveTextFreezeError(audit), /open 102\.1d/);
});

// ── gate: declared advisory age drift is not STYLE_REVIEW_REQUIRED ──────────

test('declared liveText: age-only geometry is not reviewable style and is not STYLE_REVIEW_REQUIRED', () => {
  const findings = [ageFinding(96, 104, 'open 102.1d', 'open 103.1d')];
  assert.equal(isGeometryOnlyGroup(findings), true);
  const audit = auditLiveTextChanges(
    'dashboard@1280',
    [{ kind: 'text', path: AGE_PATH, cls: 'age', before: 'open 102.1d', after: 'open 103.1d' }],
    { freeze: false, selectors: [] },
  );
  assert.equal(isLiveTextGeometryPath(AGE_PATH, audit.livePaths), true);
  const truth = assessComparisonTruth([{ surface: 'dashboard@1280', findings }], { dom: 0, style: 1, state: 0 }, [], {
    liveText: audit,
  });
  assert.equal(truth.reviewableCounts.style, 0, 'age-only geometry must not count as reviewable style');
  assert.equal(truth.hasReviewableEvidence, false);
  assert.equal(truth.rawOnlyNoReviewable, false, 'declared age residue is not a mysterious raw-only fail');
  assert.equal(truth.liveTextFreezeViolated, false);

  const verdict = classifyStyleProofVerdict(
    {
      sourceBinding: { status: 'bound' },
      coverage: { basis: 'complete' },
      determinism: { status: 'proven' },
      confidence: { counts: { inaccessible: 0 } },
      comparison: { blocksCertification: false },
      reportConsistency: { ok: true, reason: 'aligned' },
      statesUncertified: 0,
      reviewableCounts: truth.reviewableCounts,
      surfaces: [{ surface: 'dashboard@1280', findings }],
    },
    { gateInventoryRemovals: true, baseCaptureFailed: false, changed: truth.hasReviewableEvidence },
  );
  assert.equal(verdict.state, 'NO_REVIEWABLE_STYLE_CHANGES');
});

test('undeclared age-driven geometry stays reviewable — the gate is not weakened', () => {
  const findings = [ageFinding(96, 104, 'open 102.1d', 'open 9.1d')];
  const truth = assessComparisonTruth([{ surface: 'dashboard@1280', findings }], { dom: 0, style: 1, state: 0 });
  assert.equal(truth.reviewableCounts.style, 1);
  assert.equal(truth.hasReviewableEvidence, true);
});

test('declared liveText still certifies a real stylesheet change next to age drift', () => {
  const findings = [
    ageFinding(96, 104, 'open 102.1d', 'open 103.1d'),
    {
      kind: 'style',
      path: 'body > button:nth-child(2)',
      cls: 'cta',
      pseudo: null,
      props: [{ prop: 'color', before: 'rgb(0, 0, 0)', after: 'rgb(255, 0, 0)' }],
    },
  ];
  const audit = auditLiveTextChanges(
    'dashboard@1280',
    [{ kind: 'text', path: AGE_PATH, cls: 'age', before: 'open 102.1d', after: 'open 103.1d' }],
    { freeze: false, selectors: ['.age'] },
  );
  const truth = assessComparisonTruth([{ surface: 'dashboard@1280', findings }], { dom: 0, style: 2, state: 0 }, [], {
    liveText: audit,
  });
  assert.equal(truth.reviewableCounts.style, 1, 'the independent color change remains reviewable');
  assert.equal(truth.hasReviewableEvidence, true);
  const verdict = classifyStyleProofVerdict(
    {
      sourceBinding: { status: 'bound' },
      coverage: { basis: 'complete' },
      determinism: { status: 'proven' },
      confidence: { counts: { inaccessible: 0 } },
      comparison: { blocksCertification: false },
      reportConsistency: { ok: true, reason: 'aligned' },
      statesUncertified: 0,
      reviewableCounts: truth.reviewableCounts,
    },
    { gateInventoryRemovals: true, baseCaptureFailed: false, changed: truth.hasReviewableEvidence },
  );
  assert.equal(verdict.state, 'STYLE_REVIEW_REQUIRED');
});

// ── fail-closed freeze ──────────────────────────────────────────────────────

test('freeze declared + ages still change → CERTIFICATION_FAILED, not style review, not green', () => {
  const findings = [ageFinding(96, 104, 'open 102.1d', 'open 103.1d')];
  const audit = auditLiveTextChanges(
    'dashboard@1280',
    [{ kind: 'text', path: AGE_PATH, cls: 'age', before: 'open 102.1d', after: 'open 103.1d' }],
    { freeze: true, selectors: [] },
  );
  const truth = assessComparisonTruth([{ surface: 'dashboard@1280', findings }], { dom: 0, style: 1, state: 0 }, [], {
    liveText: audit,
  });
  assert.equal(truth.liveTextFreezeViolated, true);
  assert.equal(truth.hasReviewableEvidence, false, 'freeze violation is not a style approval');
  assert.equal(truth.rawOnlyNoReviewable, false);

  const evidence = assessCertificationEvidence({
    sourceBinding: { status: 'bound' },
    coverage: { basis: 'complete' },
    determinism: { status: 'proven' },
    confidence: { counts: { inaccessible: 0 } },
    comparison: { blocksCertification: false },
    reportConsistency: { ok: true, reason: 'aligned' },
    statesUncertified: 0,
    liveTextFreeze: { violated: true },
  });
  assert.equal(evidence.certifies, false);

  const verdict = classifyStyleProofVerdict(
    {
      sourceBinding: { status: 'bound' },
      coverage: { basis: 'complete' },
      determinism: { status: 'proven' },
      confidence: { counts: { inaccessible: 0 } },
      comparison: { blocksCertification: false },
      reportConsistency: { ok: true, reason: 'aligned' },
      statesUncertified: 0,
      reviewableCounts: truth.reviewableCounts,
      liveTextFreeze: { violated: true },
    },
    { gateInventoryRemovals: true, baseCaptureFailed: false, changed: false },
  );
  assert.equal(verdict.state, 'CERTIFICATION_FAILED');
});

// ── report: advisory channel vs freeze banner ───────────────────────────────

test('report: declared age-only drift stays advisory and is not a style section', () => {
  const dirs = tmpDirs();
  const before = ageMap({ text: 'open 102.1d', width: 96, liveText: { freeze: false, selectors: ['.age'] } });
  const after = ageMap({ text: 'open 103.1d', width: 104, liveText: { freeze: false, selectors: ['.age'] } });
  writeCapture(dirs.beforeDir, 'dashboard@1280', before, solidPng(400, 200));
  writeCapture(dirs.afterDir, 'dashboard@1280', after, solidPng(400, 200, [180, 180, 180]));

  const result = generateStyleMapReport({
    beforeDir: dirs.beforeDir,
    afterDir: dirs.afterDir,
    outDir: dirs.outDir,
    includeContent: true,
  });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  assert.equal(result.changedSurfaces, 0, 'age-only drift must not open a style-change section');
  assert.equal(result.contentChanges, 1);
  assert.match(md, /live\/age\/clock/);
  assert.match(md, /open 102\.1d/);
  assert.match(md, /open 103\.1d/);
  assert.doesNotMatch(md, /STYLE_REVIEW_REQUIRED/);
  assert.doesNotMatch(md, /Live\/age freeze violated/);
  rmTmp(dirs.root);
});

test('report: freeze declared and ages still change is a visible fail-closed error', () => {
  const dirs = tmpDirs();
  const before = ageMap({ text: 'open 102.1d', width: 96, liveText: { freeze: true, selectors: [] } });
  const after = ageMap({ text: 'open 103.1d', width: 104, liveText: { freeze: true, selectors: [] } });
  writeCapture(dirs.beforeDir, 'dashboard@1280', before, solidPng(400, 200));
  writeCapture(dirs.afterDir, 'dashboard@1280', after, solidPng(400, 200, [180, 180, 180]));

  const result = generateStyleMapReport({
    beforeDir: dirs.beforeDir,
    afterDir: dirs.afterDir,
    outDir: dirs.outDir,
    includeContent: true,
  });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  const json = JSON.parse(fs.readFileSync(path.join(dirs.outDir, 'report.json'), 'utf8'));
  assert.equal(result.comparison.liveTextFreezeViolated, true);
  assert.equal(result.changedSurfaces, 0, 'freeze violation must not look like a style review');
  assert.match(md, /Live\/age freeze violated/);
  assert.match(md, /CERTIFICATION_FAILED/);
  assert.match(md, /open 102\.1d/);
  assert.equal(json.liveTextFreeze.violated, true);
  assert.doesNotMatch(md, /No reviewable computed-style changes among semantically matched elements\. No advisory/);
  rmTmp(dirs.root);
});
