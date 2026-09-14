/**
 * Flex/Grid CSS Fidelity Test — Trust Ladder Rung 1
 *
 * Proves StyleProof captures exact computed-style values for flex and grid
 * layout contracts (display, flex-direction, gap, grid-template-columns).
 * Color/padding oracles can stay green while a layout-contract regression
 * ships; this fixture asserts those layout properties as known-truth.
 *
 * The oracle declares EXACT computed-style values — the properties that
 * DIFFER from browser UA defaults. No approximation, no "close enough."
 * Fail-closed: missing expected element = FAIL; wrong value = FAIL;
 * extra elements = OK.
 *
 * @see https://github.com/BenSheridanEdwards/StyleProof/issues/627
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { captureStyleMap } from '../dist/index.js';
import type { StyleMap } from '../src/capture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'known-truth-flex-grid');
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

function gapKeys(styles: Record<string, string>): string[] {
  return Object.keys(styles).filter((key) => key === 'gap' || key === 'row-gap' || key === 'column-gap');
}

test.describe('Flex/Grid CSS Fidelity: known-truth-flex-grid fixture', () => {
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

  test('oracle has both flex and grid testIds', () => {
    const oracle = loadOracle();
    const testIds = Object.keys(oracle.byTestId);

    const flexTestId = testIds.find((id) => id.includes('flex'));
    const gridTestId = testIds.find((id) => id.includes('grid'));

    expect(flexTestId, 'oracle missing flex testId').toBeDefined();
    expect(gridTestId, 'oracle missing grid testId').toBeDefined();

    const flexStyles = oracle.byTestId[flexTestId!].expectedStyles;
    const gridStyles = oracle.byTestId[gridTestId!].expectedStyles;

    expect(flexStyles['display'], `oracle[${flexTestId}] missing display`).toBeDefined();
    expect(flexStyles['flex-direction'], `oracle[${flexTestId}] missing flex-direction`).toBeDefined();
    expect(gapKeys(flexStyles).length, `oracle[${flexTestId}] missing gap (or row-gap/column-gap)`).toBeGreaterThan(0);

    expect(gridStyles['display'], `oracle[${gridTestId}] missing display`).toBeDefined();
    expect(gridStyles['grid-template-columns'], `oracle[${gridTestId}] missing grid-template-columns`).toBeDefined();
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

  test('flex display differs from grid display', async ({ page }) => {
    const oracle = loadOracle();
    const map = await captureFixture(page);

    const flexTestId = Object.keys(oracle.byTestId).find((id) => id.includes('flex'));
    const gridTestId = Object.keys(oracle.byTestId).find((id) => id.includes('grid'));

    expect(flexTestId, 'oracle missing flex testId').toBeDefined();
    expect(gridTestId, 'oracle missing grid testId').toBeDefined();

    const flexEl = findElementByTestId(map, flexTestId!);
    const gridEl = findElementByTestId(map, gridTestId!);

    expect(flexEl, `FAIL-CLOSED: flex element data-testid="${flexTestId}" not found`).toBeDefined();
    expect(gridEl, `FAIL-CLOSED: grid element data-testid="${gridTestId}" not found`).toBeDefined();

    const oracleFlexDisplay = oracle.byTestId[flexTestId!].expectedStyles['display'];
    const oracleGridDisplay = oracle.byTestId[gridTestId!].expectedStyles['display'];

    expect(oracleFlexDisplay, 'oracle should declare display for flex container').toBeDefined();
    expect(oracleGridDisplay, 'oracle should declare display for grid container').toBeDefined();
    expect(oracleFlexDisplay, 'flex/grid should have DIFFERENT display values').not.toBe(oracleGridDisplay);

    expect(flexEl!.entry.style['display'], `flex container display should match oracle`).toBe(oracleFlexDisplay);
    expect(gridEl!.entry.style['display'], `grid container display should match oracle`).toBe(oracleGridDisplay);
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
