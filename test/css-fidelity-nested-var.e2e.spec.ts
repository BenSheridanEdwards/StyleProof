/**
 * Nested CSS var() Resolution Fidelity Test — Trust Ladder Rung 1 (Issue #625)
 *
 * Proves StyleProof correctly resolves nested CSS var() chains through multiple
 * levels of indirection (token → component → leaf). The browser computes var()
 * chains at paint time; StyleProof must capture the RESOLVED computed value,
 * not the var() expression.
 *
 * Nesting levels tested:
 * - Level 0: Direct token usage (var(--token) → value)
 * - Level 1: Component semantic (var(--component) → var(--token) → value)
 * - Level 2: Nested deep (var(--nested) → var(--component) → var(--token) → value)
 * - Level 3: Leaf (var(--leaf) → var(--nested) → var(--component) → var(--token) → value)
 *
 * Fail-closed: unresolved var() = FAIL; wrong cascade = FAIL; missing element = FAIL.
 *
 * @see https://github.com/BenSheridanEdwards/StyleProof/issues/625
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { captureStyleMap } from '../dist/index.js';
import type { StyleMap } from '../src/capture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'known-truth-css-nested-var');
const FIXTURE_HTML = path.join(FIXTURE_DIR, 'index.html');
const EXPECTED_JSON = path.join(FIXTURE_DIR, 'expected.json');

/**
 * Oracle structure for nested var() resolution test.
 * Each testid specifies its nesting depth and the expected RESOLVED computed values.
 */
type ExpectedOracleNestedVar = {
  description: string;
  byTestId: Record<
    string,
    {
      tag: string;
      cls: string;
      nestingDepth: number;
      doc: string;
      expectedStyles: Record<string, string>;
    }
  >;
  customProperties: Record<string, string>;
};

function loadOracle(): ExpectedOracleNestedVar {
  const content = fs.readFileSync(EXPECTED_JSON, 'utf-8');
  return JSON.parse(content) as ExpectedOracleNestedVar;
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

test.describe('CSS Fidelity: nested var() resolution known-truth', () => {
  test.describe.configure({ mode: 'serial' });

  test('fixture and oracle files exist', () => {
    expect(fs.existsSync(FIXTURE_HTML), `fixture HTML missing: ${FIXTURE_HTML}`).toBe(true);
    expect(fs.existsSync(EXPECTED_JSON), `oracle JSON missing: ${EXPECTED_JSON}`).toBe(true);
  });

  test('oracle is valid JSON with required nested-var structure', () => {
    const oracle = loadOracle();
    expect(oracle.byTestId, 'oracle missing byTestId').toBeDefined();
    expect(Object.keys(oracle.byTestId).length, 'oracle byTestId is empty').toBeGreaterThan(0);

    for (const [testId, spec] of Object.entries(oracle.byTestId)) {
      expect(spec.tag, `oracle[${testId}] missing tag`).toBeDefined();
      expect(typeof spec.nestingDepth, `oracle[${testId}] missing nestingDepth`).toBe('number');
      expect(spec.expectedStyles, `oracle[${testId}] missing expectedStyles`).toBeDefined();
      expect(Object.keys(spec.expectedStyles).length, `oracle[${testId}] expectedStyles is empty`).toBeGreaterThan(0);
    }
  });

  test('oracle has elements at multiple nesting depths (≥2 levels required per issue #625)', () => {
    const oracle = loadOracle();
    const depths = new Set<number>();

    for (const spec of Object.values(oracle.byTestId)) {
      depths.add(spec.nestingDepth);
    }

    expect(
      depths.size,
      'oracle MUST have elements at ≥2 different nesting depths (per issue #625 acceptance)',
    ).toBeGreaterThanOrEqual(2);

    const maxDepth = Math.max(...depths);
    expect(
      maxDepth,
      'oracle MUST have at least one element at nesting depth ≥2 (multi-level chain)',
    ).toBeGreaterThanOrEqual(2);
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

  test('every expected CSS property resolves to exact computed value (fail-closed on wrong/unresolved)', async ({
    page,
  }) => {
    const oracle = loadOracle();
    const map = await captureFixture(page);

    for (const [testId, spec] of Object.entries(oracle.byTestId)) {
      const found = findElementByTestId(map, testId);
      expect(found, `FAIL-CLOSED: data-testid="${testId}" not found`).toBeDefined();

      for (const [prop, expectedValue] of Object.entries(spec.expectedStyles)) {
        const actualValue = found!.entry.style[prop];
        expect(
          actualValue,
          `data-testid="${testId}" (nesting depth ${spec.nestingDepth}) property "${prop}": expected resolved value "${expectedValue}" but was ${actualValue === undefined ? 'MISSING' : `"${actualValue}"`}`,
        ).toBe(expectedValue);
      }
    }
  });

  test('nesting depth 0 (direct token) resolves correctly', async ({ page }) => {
    const oracle = loadOracle();
    const map = await captureFixture(page);

    const depth0Entries = Object.entries(oracle.byTestId).filter(([, spec]) => spec.nestingDepth === 0);
    expect(depth0Entries.length, 'oracle must have at least one depth-0 element').toBeGreaterThan(0);

    for (const [testId, spec] of depth0Entries) {
      const found = findElementByTestId(map, testId);
      expect(found, `FAIL-CLOSED: depth-0 element data-testid="${testId}" not found`).toBeDefined();

      for (const [prop, expectedValue] of Object.entries(spec.expectedStyles)) {
        const actualValue = found!.entry.style[prop];
        expect(
          actualValue,
          `depth-0 "${testId}" "${prop}": expected "${expectedValue}" but was ${actualValue === undefined ? 'MISSING' : `"${actualValue}"`}`,
        ).toBe(expectedValue);
      }
    }
  });

  test('nesting depth ≥2 (multi-level chain) resolves correctly through full cascade', async ({ page }) => {
    const oracle = loadOracle();
    const map = await captureFixture(page);

    const deepEntries = Object.entries(oracle.byTestId).filter(([, spec]) => spec.nestingDepth >= 2);
    expect(deepEntries.length, 'oracle must have at least one element with nesting depth ≥2').toBeGreaterThan(0);

    for (const [testId, spec] of deepEntries) {
      const found = findElementByTestId(map, testId);
      expect(found, `FAIL-CLOSED: depth-${spec.nestingDepth} element data-testid="${testId}" not found`).toBeDefined();

      for (const [prop, expectedValue] of Object.entries(spec.expectedStyles)) {
        const actualValue = found!.entry.style[prop];
        expect(
          actualValue,
          `depth-${spec.nestingDepth} "${testId}" "${prop}": expected resolved value "${expectedValue}" through full cascade, but was ${actualValue === undefined ? 'MISSING (unresolved?)' : `"${actualValue}"`}`,
        ).toBe(expectedValue);
      }
    }
  });

  test('custom properties (design tokens) captured with exact values', async ({ page }) => {
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

  test('fail-closed: unresolved var() would show as literal string (this must not happen)', async ({ page }) => {
    const oracle = loadOracle();
    const map = await captureFixture(page);

    for (const [testId, spec] of Object.entries(oracle.byTestId)) {
      const found = findElementByTestId(map, testId);
      if (!found) continue;

      for (const prop of Object.keys(spec.expectedStyles)) {
        const actualValue = found.entry.style[prop];
        if (actualValue === undefined) continue;

        expect(
          actualValue.includes('var('),
          `FAIL-CLOSED: data-testid="${testId}" property "${prop}" contains unresolved var() — capture MUST resolve to computed value, got "${actualValue}"`,
        ).toBe(false);
      }
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
