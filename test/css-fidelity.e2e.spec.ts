/**
 * CSS Fidelity Test — Trust Ladder Rung 1
 *
 * Proves StyleProof captures exact computed-style values from a controlled fixture.
 * The fixture declares a known CSS contract; the expected.json oracle defines
 * EXACTLY what computed-style values must be reproduced. No normalization, no
 * approximation, no "close enough." If the fixture declares rgb(X,Y,Z), capture
 * must contain that exact string.
 *
 * Fail-closed: missing expected element = FAIL; wrong value = FAIL; extra elements = OK.
 *
 * Extends to forced pseudo-states (:hover, :focus, :active) via captureStates: true.
 * State fidelity proves the captured state values exactly match what the CSS declares.
 *
 * @see https://github.com/BenSheridanEdwards/StyleProof/issues/611
 * @see https://github.com/BenSheridanEdwards/StyleProof/issues/615
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { captureStyleMap } from '../dist/index.js';
import type { StyleMap } from '../src/capture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'known-truth-css');
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
      expectedStates?: {
        hover?: Record<string, string>;
        focus?: Record<string, string>;
        active?: Record<string, string>;
      };
    }
  >;
  customProperties: Record<string, string>;
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

test.describe('CSS Fidelity: known-truth-css fixture', () => {
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

  test('custom properties (CSS variables) captured with exact values', async ({ page }) => {
    const oracle = loadOracle();
    const map = await captureFixture(page);

    if (!oracle.customProperties || Object.keys(oracle.customProperties).length === 0) {
      return;
    }

    expect(map.tokens, 'capture missing tokens (custom properties)').toBeDefined();

    for (const [varName, expectedValue] of Object.entries(oracle.customProperties)) {
      if (!varName.startsWith('--')) continue;
      const actualValue = map.tokens?.[varName];
      expect(
        actualValue,
        `custom property "${varName}": expected "${expectedValue}" but was ${actualValue === undefined ? 'NOT CAPTURED' : `"${actualValue}"`}`,
      ).toBe(expectedValue);
    }
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

/**
 * Capture with forced pseudo-states enabled.
 */
async function captureFixtureWithStates(page: Page): Promise<StyleMap> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('file://' + FIXTURE_HTML, { waitUntil: 'load' });
  return await captureStyleMap(page, { stabilize: false, captureStates: true });
}

/**
 * Forced-State CSS Fidelity — Trust Ladder Rung 1
 *
 * Extends resting-style fidelity to forced pseudo-states (:hover, :focus, :active).
 * Proves the captured state values exactly match what the CSS declares.
 *
 * @see https://github.com/BenSheridanEdwards/StyleProof/issues/615
 */
test.describe('CSS Fidelity: forced-state exactness', () => {
  test.describe.configure({ mode: 'serial' });

  test('oracle has expectedStates for at least one interactive element', () => {
    const oracle = loadOracle();
    const hasStates = Object.values(oracle.byTestId).some((spec) => spec.expectedStates);
    expect(hasStates, 'oracle missing expectedStates section for forced-state tests').toBe(true);
  });

  test('forced-state capture completes without statesSkipped flag', async ({ page }) => {
    const map = await captureFixtureWithStates(page);
    expect(map.statesSkipped, 'forced-state capture was incomplete').toBeFalsy();
  });

  test('every expected :hover property matches exactly (fail-closed on wrong value)', async ({ page }) => {
    const oracle = loadOracle();
    const map = await captureFixtureWithStates(page);

    for (const [testId, spec] of Object.entries(oracle.byTestId)) {
      if (!spec.expectedStates?.hover) continue;

      const found = findElementByTestId(map, testId);
      expect(found, `FAIL-CLOSED: data-testid="${testId}" not found`).toBeDefined();

      const hoverStates = map.states[found!.path]?.hover;
      expect(hoverStates, `FAIL-CLOSED: data-testid="${testId}" has no :hover state captured`).toBeDefined();

      const selfHover = hoverStates?.[found!.path];
      expect(selfHover, `FAIL-CLOSED: data-testid="${testId}" :hover self-effect not captured`).toBeDefined();

      for (const [prop, expectedValue] of Object.entries(spec.expectedStates.hover)) {
        const actualValue = selfHover?.[prop];
        expect(
          actualValue,
          `data-testid="${testId}" :hover "${prop}": expected "${expectedValue}" but was ${actualValue === undefined ? 'MISSING' : `"${actualValue}"`}`,
        ).toBe(expectedValue);
      }
    }
  });

  test('every expected :focus property matches exactly (fail-closed on wrong value)', async ({ page }) => {
    const oracle = loadOracle();
    const map = await captureFixtureWithStates(page);

    for (const [testId, spec] of Object.entries(oracle.byTestId)) {
      if (!spec.expectedStates?.focus) continue;

      const found = findElementByTestId(map, testId);
      expect(found, `FAIL-CLOSED: data-testid="${testId}" not found`).toBeDefined();

      const focusStates = map.states[found!.path]?.focus;
      expect(focusStates, `FAIL-CLOSED: data-testid="${testId}" has no :focus state captured`).toBeDefined();

      const selfFocus = focusStates?.[found!.path];
      expect(selfFocus, `FAIL-CLOSED: data-testid="${testId}" :focus self-effect not captured`).toBeDefined();

      for (const [prop, expectedValue] of Object.entries(spec.expectedStates.focus)) {
        const actualValue = selfFocus?.[prop];
        expect(
          actualValue,
          `data-testid="${testId}" :focus "${prop}": expected "${expectedValue}" but was ${actualValue === undefined ? 'MISSING' : `"${actualValue}"`}`,
        ).toBe(expectedValue);
      }
    }
  });

  test('every expected :active property matches exactly (fail-closed on wrong value)', async ({ page }) => {
    const oracle = loadOracle();
    const map = await captureFixtureWithStates(page);

    for (const [testId, spec] of Object.entries(oracle.byTestId)) {
      if (!spec.expectedStates?.active) continue;

      const found = findElementByTestId(map, testId);
      expect(found, `FAIL-CLOSED: data-testid="${testId}" not found`).toBeDefined();

      const activeStates = map.states[found!.path]?.active;
      expect(activeStates, `FAIL-CLOSED: data-testid="${testId}" has no :active state captured`).toBeDefined();

      const selfActive = activeStates?.[found!.path];
      expect(selfActive, `FAIL-CLOSED: data-testid="${testId}" :active self-effect not captured`).toBeDefined();

      for (const [prop, expectedValue] of Object.entries(spec.expectedStates.active)) {
        const actualValue = selfActive?.[prop];
        expect(
          actualValue,
          `data-testid="${testId}" :active "${prop}": expected "${expectedValue}" but was ${actualValue === undefined ? 'MISSING' : `"${actualValue}"`}`,
        ).toBe(expectedValue);
      }
    }
  });

  test('extra captured state effects do not cause failure (fail-open on extras)', async ({ page }) => {
    const map = await captureFixtureWithStates(page);
    expect(Object.keys(map.states).length, 'forced-state layer should capture interactive elements').toBeGreaterThan(0);
  });
});
