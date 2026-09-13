/**
 * Form States CSS Fidelity Test — Trust Ladder Rung 1
 *
 * Proves StyleProof captures exact computed-style values for :disabled and
 * :checked form element states. These are HTML attribute states (not CDP-forced
 * pseudo-states like :hover/:focus/:active), so the fixture contains actual
 * disabled/checked elements whose resting styles are captured and validated.
 *
 * The oracle declares EXACT computed-style deltas — the properties that DIFFER
 * between enabled/disabled and unchecked/checked elements. No approximation,
 * no "close enough." Fail-closed: missing expected element = FAIL; wrong
 * value = FAIL; extra elements = OK.
 *
 * @see https://github.com/BenSheridanEdwards/StyleProof/issues/624
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { captureStyleMap } from '../dist/index.js';
import type { StyleMap } from '../src/capture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'known-truth-form-states');
const FIXTURE_HTML = path.join(FIXTURE_DIR, 'index.html');
const EXPECTED_JSON = path.join(FIXTURE_DIR, 'expected.json');

type ExpectedOracle = {
  description: string;
  byTestId: Record<
    string,
    {
      tag: string;
      cls: string;
      expectedStyles: Record<string, string>;
    }
  >;
  /**
   * Documents the exact computed-style deltas between element pairs.
   * This is documentation for reviewers — tests assert byTestId styles directly.
   * The deltas prove the difference between enabled/disabled and checked/unchecked.
   */
  stateDeltas?: {
    disabled?: {
      description: string;
      baseline: string;
      variant: string;
      changedProperties: Record<string, { from: string; to: string }>;
    };
    checked?: {
      description: string;
      baseline: string;
      variant: string;
      changedProperties: Record<string, { from: string; to: string }>;
    };
  };
};

function loadOracle(): ExpectedOracle {
  const content = fs.readFileSync(EXPECTED_JSON, 'utf-8');
  return JSON.parse(content) as ExpectedOracle;
}

function findElementByTestId(
  map: StyleMap,
  testId: string,
): { path: string; entry: StyleMap['elements'][string] } | undefined {
  for (const [elementPath, entry] of Object.entries(map.elements)) {
    const testIdAttr = `testid:${testId}`;
    let hashValue = 2166136261;
    for (let i = 0; i < testIdAttr.length; i++) {
      hashValue ^= testIdAttr.charCodeAt(i);
      hashValue = Math.imul(hashValue, 16777619);
    }
    const expectedHash = (hashValue >>> 0).toString(36);
    if (elementPath.includes(`:sp-key(${expectedHash})`)) {
      return { path: elementPath, entry };
    }
  }
  return undefined;
}

async function captureFixture(page: Page): Promise<StyleMap> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('file://' + FIXTURE_HTML, { waitUntil: 'load' });
  return await captureStyleMap(page, { stabilize: false, captureStates: false });
}

test.describe('Form States CSS Fidelity: :disabled and :checked', () => {
  test.describe.configure({ mode: 'serial' });

  test('fixture and oracle files exist', () => {
    expect(fs.existsSync(FIXTURE_HTML), `fixture HTML missing: ${FIXTURE_HTML}`).toBe(true);
    expect(fs.existsSync(EXPECTED_JSON), `oracle JSON missing: ${EXPECTED_JSON}`).toBe(true);
  });

  test('oracle is valid JSON with required structure', () => {
    const oracle = loadOracle();
    expect(oracle.byTestId, 'oracle missing byTestId').toBeDefined();
    expect(Object.keys(oracle.byTestId).length, 'oracle byTestId is empty').toBeGreaterThan(0);
    for (const [testId, spec] of Object.entries(oracle.byTestId)) {
      expect(spec.tag, `oracle[${testId}] missing tag`).toBeDefined();
      expect(spec.expectedStyles, `oracle[${testId}] missing expectedStyles`).toBeDefined();
      expect(Object.keys(spec.expectedStyles).length, `oracle[${testId}] expectedStyles is empty`).toBeGreaterThan(0);
    }
  });

  test('oracle has both :disabled and :checked test elements', () => {
    const oracle = loadOracle();
    const testIds = Object.keys(oracle.byTestId);

    const hasDisabled =
      testIds.some((id) => id.includes('disabled')) || testIds.some((id) => id.includes('btn-disabled'));
    const hasChecked = testIds.some((id) => id.includes('checked')) || testIds.some((id) => id.includes('checkbox'));

    expect(hasDisabled, 'oracle missing :disabled test elements').toBe(true);
    expect(hasChecked, 'oracle missing :checked test elements').toBe(true);
  });

  test('capture contains every expected element (fail-closed on missing)', async ({ page }) => {
    const oracle = loadOracle();
    const map = await captureFixture(page);

    for (const testId of Object.keys(oracle.byTestId)) {
      const found = findElementByTestId(map, testId);
      expect(found, `FAIL-CLOSED: expected element data-testid="${testId}" not found in captured map`).toBeDefined();
    }
  });

  test('every expected element has correct tag', async ({ page }) => {
    const oracle = loadOracle();
    const map = await captureFixture(page);

    for (const [testId, spec] of Object.entries(oracle.byTestId)) {
      const found = findElementByTestId(map, testId);
      expect(found, `element data-testid="${testId}" not found`).toBeDefined();
      expect(found!.entry.tag, `element data-testid="${testId}" wrong tag`).toBe(spec.tag);
    }
  });

  test('every expected CSS property matches exactly (fail-closed on wrong value)', async ({ page }) => {
    const oracle = loadOracle();
    const map = await captureFixture(page);

    for (const [testId, spec] of Object.entries(oracle.byTestId)) {
      const found = findElementByTestId(map, testId);
      expect(found, `FAIL-CLOSED: data-testid="${testId}" not found`).toBeDefined();

      for (const [prop, expectedValue] of Object.entries(spec.expectedStyles)) {
        const actualValue = found!.entry.style[prop];
        expect(
          actualValue,
          `data-testid="${testId}" property "${prop}": expected "${expectedValue}" but was ${actualValue === undefined ? 'MISSING' : `"${actualValue}"`}`,
        ).toBe(expectedValue);
      }
    }
  });

  test(':disabled styles differ from enabled baseline (exact delta captured)', async ({ page }) => {
    const oracle = loadOracle();
    const map = await captureFixture(page);

    const enabledBtn = findElementByTestId(map, 'btn-enabled');
    const disabledBtn = findElementByTestId(map, 'btn-disabled');

    expect(enabledBtn, 'FAIL-CLOSED: enabled button baseline not found').toBeDefined();
    expect(disabledBtn, 'FAIL-CLOSED: disabled button not found').toBeDefined();

    const oracleEnabled = oracle.byTestId['btn-enabled'];
    const oracleDisabled = oracle.byTestId['btn-disabled'];

    expect(oracleEnabled, 'oracle missing btn-enabled').toBeDefined();
    expect(oracleDisabled, 'oracle missing btn-disabled').toBeDefined();

    for (const [prop, expectedValue] of Object.entries(oracleEnabled.expectedStyles)) {
      const actualValue = enabledBtn!.entry.style[prop];
      expect(
        actualValue,
        `btn-enabled "${prop}": expected "${expectedValue}" but was ${actualValue === undefined ? 'MISSING' : `"${actualValue}"`}`,
      ).toBe(expectedValue);
    }

    for (const [prop, expectedValue] of Object.entries(oracleDisabled.expectedStyles)) {
      const actualValue = disabledBtn!.entry.style[prop];
      expect(
        actualValue,
        `btn-disabled "${prop}": expected "${expectedValue}" but was ${actualValue === undefined ? 'MISSING' : `"${actualValue}"`}`,
      ).toBe(expectedValue);
    }

    expect(oracleEnabled.expectedStyles['cursor'], 'oracle should declare cursor for enabled button').toBeDefined();
    expect(oracleDisabled.expectedStyles['cursor'], 'oracle should declare cursor for disabled button').toBeDefined();
    expect(oracleEnabled.expectedStyles['cursor'], 'enabled/disabled should have DIFFERENT cursor values').not.toBe(
      oracleDisabled.expectedStyles['cursor'],
    );
  });

  test(':checked styles differ from unchecked baseline (exact delta captured)', async ({ page }) => {
    const oracle = loadOracle();
    const map = await captureFixture(page);

    const uncheckedCb = findElementByTestId(map, 'checkbox-unchecked');
    const checkedCb = findElementByTestId(map, 'checkbox-checked');

    expect(uncheckedCb, 'FAIL-CLOSED: unchecked checkbox baseline not found').toBeDefined();
    expect(checkedCb, 'FAIL-CLOSED: checked checkbox not found').toBeDefined();

    const oracleUnchecked = oracle.byTestId['checkbox-unchecked'];
    const oracleChecked = oracle.byTestId['checkbox-checked'];

    expect(oracleUnchecked, 'oracle missing checkbox-unchecked').toBeDefined();
    expect(oracleChecked, 'oracle missing checkbox-checked').toBeDefined();

    for (const [prop, expectedValue] of Object.entries(oracleUnchecked.expectedStyles)) {
      const actualValue = uncheckedCb!.entry.style[prop];
      expect(
        actualValue,
        `checkbox-unchecked "${prop}": expected "${expectedValue}" but was ${actualValue === undefined ? 'MISSING' : `"${actualValue}"`}`,
      ).toBe(expectedValue);
    }

    for (const [prop, expectedValue] of Object.entries(oracleChecked.expectedStyles)) {
      const actualValue = checkedCb!.entry.style[prop];
      expect(
        actualValue,
        `checkbox-checked "${prop}": expected "${expectedValue}" but was ${actualValue === undefined ? 'MISSING' : `"${actualValue}"`}`,
      ).toBe(expectedValue);
    }

    expect(
      oracleUnchecked.expectedStyles['accent-color'],
      'oracle should declare accent-color for unchecked checkbox',
    ).toBeDefined();
    expect(
      oracleChecked.expectedStyles['accent-color'],
      'oracle should declare accent-color for checked checkbox',
    ).toBeDefined();
    expect(
      oracleUnchecked.expectedStyles['accent-color'],
      'unchecked/checked should have DIFFERENT accent-color values',
    ).not.toBe(oracleChecked.expectedStyles['accent-color']);
  });

  test(':disabled input styles differ from enabled baseline (exact delta captured)', async ({ page }) => {
    const oracle = loadOracle();
    const map = await captureFixture(page);

    const enabledInput = findElementByTestId(map, 'input-enabled');
    const disabledInput = findElementByTestId(map, 'input-disabled');

    expect(enabledInput, 'FAIL-CLOSED: enabled input baseline not found').toBeDefined();
    expect(disabledInput, 'FAIL-CLOSED: disabled input not found').toBeDefined();

    const oracleEnabled = oracle.byTestId['input-enabled'];
    const oracleDisabled = oracle.byTestId['input-disabled'];

    expect(oracleEnabled, 'oracle missing input-enabled').toBeDefined();
    expect(oracleDisabled, 'oracle missing input-disabled').toBeDefined();

    for (const [prop, expectedValue] of Object.entries(oracleEnabled.expectedStyles)) {
      const actualValue = enabledInput!.entry.style[prop];
      expect(
        actualValue,
        `input-enabled "${prop}": expected "${expectedValue}" but was ${actualValue === undefined ? 'MISSING' : `"${actualValue}"`}`,
      ).toBe(expectedValue);
    }

    for (const [prop, expectedValue] of Object.entries(oracleDisabled.expectedStyles)) {
      const actualValue = disabledInput!.entry.style[prop];
      expect(
        actualValue,
        `input-disabled "${prop}": expected "${expectedValue}" but was ${actualValue === undefined ? 'MISSING' : `"${actualValue}"`}`,
      ).toBe(expectedValue);
    }

    expect(
      oracleEnabled.expectedStyles['border-top-color'],
      'oracle should declare border-top-color for enabled input',
    ).toBeDefined();
    expect(
      oracleDisabled.expectedStyles['border-top-color'],
      'oracle should declare border-top-color for disabled input',
    ).toBeDefined();
    expect(
      oracleEnabled.expectedStyles['border-top-color'],
      'enabled/disabled input should have DIFFERENT border-top-color values',
    ).not.toBe(oracleDisabled.expectedStyles['border-top-color']);
  });

  test('extra captured elements do not cause failure (fail-open on extras)', async ({ page }) => {
    const oracle = loadOracle();
    const map = await captureFixture(page);
    const oracleTestIds = new Set(Object.keys(oracle.byTestId));
    const capturedPaths = Object.keys(map.elements);
    expect(
      capturedPaths.length,
      'capture should contain more elements than just the oracle-specified ones',
    ).toBeGreaterThan(oracleTestIds.size);
  });
});
