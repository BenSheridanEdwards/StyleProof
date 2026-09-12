/**
 * CSS Diff Fidelity Test — Trust Ladder Rung 1
 *
 * Proves the capture→diff pipeline reports EXACT before/after CSS mutations
 * from a known-truth fixture pair — not merely "a change was found."
 *
 * The fixture pair (before.html / after.html) declares exact CSS mutations;
 * the expected-diff.json oracle defines EXACTLY what findings diffStyleMaps must
 * report. No approximation, no "close enough." If the oracle declares
 * background-color changed from rgb(A) to rgb(B), the diff must report those
 * exact values.
 *
 * Fail-closed contract:
 * - Missing expected finding = FAIL
 * - Wrong before/after value = FAIL
 * - Unexpected finding on noChangeExpected element = FAIL
 * - Diff reports change that didn't happen = FAIL
 *
 * @see https://github.com/BenSheridanEdwards/StyleProof/issues/612
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { captureStyleMap, diffStyleMaps } from '../dist/index.js';
import type { StyleMap } from '../src/capture.js';
import type { Finding } from '../src/diff.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'known-truth-css');
const BEFORE_HTML = path.join(FIXTURE_DIR, 'before.html');
const AFTER_HTML = path.join(FIXTURE_DIR, 'after.html');
const EXPECTED_DIFF_JSON = path.join(FIXTURE_DIR, 'expected-diff.json');

type ExpectedFinding = {
  kind: 'style';
  testId: string;
  cls: string;
  pseudo: string | null;
  props: Array<{ prop: string; before: string; after: string }>;
};

type NoChangeExpected = {
  testId: string;
  cls: string;
  comment: string;
};

type DiffOracle = {
  description: string;
  documentedMutations: Record<string, { before: string; after: string; comment: string }>;
  expectedFindings: ExpectedFinding[];
  noChangeExpected: NoChangeExpected[];
};

function loadDiffOracle(): DiffOracle {
  const content = fs.readFileSync(EXPECTED_DIFF_JSON, 'utf-8');
  return JSON.parse(content) as DiffOracle;
}

/**
 * Find element path in map by data-testid using the sp-key hash algorithm.
 */
function findPathByTestId(map: StyleMap, testId: string): string | undefined {
  const testIdAttr = `testid:${testId}`;
  let hashValue = 2166136261;
  for (let i = 0; i < testIdAttr.length; i++) {
    hashValue ^= testIdAttr.charCodeAt(i);
    hashValue = Math.imul(hashValue, 16777619);
  }
  const expectedHash = (hashValue >>> 0).toString(36);
  const keyPattern = `:sp-key(${expectedHash})`;

  for (const elementPath of Object.keys(map.elements)) {
    if (elementPath.includes(keyPattern)) {
      return elementPath;
    }
  }
  return undefined;
}

async function captureFixture(page: Page, htmlPath: string): Promise<StyleMap> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('file://' + htmlPath, { waitUntil: 'load' });
  return await captureStyleMap(page, { stabilize: false, captureStates: false });
}

test.describe('CSS Diff Fidelity: known-truth-css before→after', () => {
  test.describe.configure({ mode: 'serial' });

  test('fixture and oracle files exist', () => {
    expect(fs.existsSync(BEFORE_HTML), `before fixture missing: ${BEFORE_HTML}`).toBe(true);
    expect(fs.existsSync(AFTER_HTML), `after fixture missing: ${AFTER_HTML}`).toBe(true);
    expect(fs.existsSync(EXPECTED_DIFF_JSON), `diff oracle missing: ${EXPECTED_DIFF_JSON}`).toBe(true);
  });

  test('diff oracle is valid JSON with required structure', () => {
    const oracle = loadDiffOracle();
    expect(oracle.expectedFindings, 'oracle missing expectedFindings').toBeDefined();
    expect(oracle.noChangeExpected, 'oracle missing noChangeExpected').toBeDefined();
    expect(oracle.expectedFindings.length, 'oracle expectedFindings is empty').toBeGreaterThan(0);
    expect(oracle.noChangeExpected.length, 'oracle noChangeExpected is empty').toBeGreaterThan(0);
  });

  test('live capture→diff reports exact before/after mutations (fail-closed on wrong value)', async ({ page }) => {
    const oracle = loadDiffOracle();

    const beforeMap = await captureFixture(page, BEFORE_HTML);
    const afterMap = await captureFixture(page, AFTER_HTML);

    const findings = diffStyleMaps(beforeMap, afterMap);

    for (const expected of oracle.expectedFindings) {
      const beforePath = findPathByTestId(beforeMap, expected.testId);
      const afterPath = findPathByTestId(afterMap, expected.testId);

      expect(
        beforePath,
        `FAIL-CLOSED: expected element data-testid="${expected.testId}" not found in before capture`,
      ).toBeDefined();
      expect(
        afterPath,
        `FAIL-CLOSED: expected element data-testid="${expected.testId}" not found in after capture`,
      ).toBeDefined();

      const actual = findings.find(
        (f): f is Finding & { kind: 'style' } =>
          f.kind === 'style' && f.path === afterPath && f.pseudo === expected.pseudo,
      );

      expect(
        actual,
        `FAIL-CLOSED: missing expected finding for data-testid="${expected.testId}" (path: ${afterPath})`,
      ).toBeDefined();

      expect(actual!.cls, `class mismatch for data-testid="${expected.testId}"`).toBe(expected.cls);

      for (const expectedProp of expected.props) {
        const actualProp = actual!.props.find((p) => p.prop === expectedProp.prop);
        expect(
          actualProp,
          `FAIL-CLOSED: data-testid="${expected.testId}" missing prop "${expectedProp.prop}"`,
        ).toBeDefined();
        expect(
          actualProp!.before,
          `FAIL-CLOSED: data-testid="${expected.testId}" prop "${expectedProp.prop}" wrong before value: expected "${expectedProp.before}" but was "${actualProp!.before}"`,
        ).toBe(expectedProp.before);
        expect(
          actualProp!.after,
          `FAIL-CLOSED: data-testid="${expected.testId}" prop "${expectedProp.prop}" wrong after value: expected "${expectedProp.after}" but was "${actualProp!.after}"`,
        ).toBe(expectedProp.after);
      }
    }
  });

  test('no unexpected findings on noChangeExpected elements (fail-closed on false positive)', async ({ page }) => {
    const oracle = loadDiffOracle();

    const beforeMap = await captureFixture(page, BEFORE_HTML);
    const afterMap = await captureFixture(page, AFTER_HTML);

    const findings = diffStyleMaps(beforeMap, afterMap);

    for (const noChange of oracle.noChangeExpected) {
      const afterPath = findPathByTestId(afterMap, noChange.testId);
      expect(
        afterPath,
        `noChangeExpected element data-testid="${noChange.testId}" not found in after capture`,
      ).toBeDefined();

      const unexpected = findings.find((f) => f.kind === 'style' && f.path === afterPath);

      expect(
        unexpected,
        `FAIL-CLOSED: unexpected finding (false positive) on noChangeExpected element data-testid="${noChange.testId}" (${noChange.cls}): ${JSON.stringify(unexpected)}`,
      ).toBeUndefined();
    }
  });

  test('no false positives: every finding is in expectedFindings (fail-closed)', async ({ page }) => {
    const oracle = loadDiffOracle();

    const beforeMap = await captureFixture(page, BEFORE_HTML);
    const afterMap = await captureFixture(page, AFTER_HTML);

    const findings = diffStyleMaps(beforeMap, afterMap);
    const styleFindings = findings.filter((f): f is Finding & { kind: 'style' } => f.kind === 'style');

    for (const actual of styleFindings) {
      let foundTestId: string | undefined;
      for (const expected of oracle.expectedFindings) {
        const expectedPath = findPathByTestId(afterMap, expected.testId);
        if (actual.path === expectedPath && actual.pseudo === expected.pseudo) {
          foundTestId = expected.testId;
          break;
        }
      }

      expect(
        foundTestId,
        `FAIL-CLOSED: unexpected finding (false positive) not in oracle: path="${actual.path}", props=${JSON.stringify(actual.props)}`,
      ).toBeDefined();
    }
  });

  test('finding count matches oracle exactly', async ({ page }) => {
    const oracle = loadDiffOracle();

    const beforeMap = await captureFixture(page, BEFORE_HTML);
    const afterMap = await captureFixture(page, AFTER_HTML);

    const findings = diffStyleMaps(beforeMap, afterMap);
    const styleFindings = findings.filter((f) => f.kind === 'style');

    expect(
      styleFindings.length,
      `FAIL-CLOSED: expected ${oracle.expectedFindings.length} finding(s), got ${styleFindings.length}`,
    ).toBe(oracle.expectedFindings.length);
  });
});
