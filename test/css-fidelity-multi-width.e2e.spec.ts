/**
 * Multi-Width CSS Fidelity Test — Trust Ladder Rung 1 (Issue #622)
 *
 * Proves StyleProof captures exact computed-style values at MULTIPLE viewport widths,
 * verifying media-query/breakpoint CSS matches oracle at each configured width.
 * The same testid can have DIFFERENT expected values at different widths — this is
 * the core product value: breakpoint-aware certification.
 *
 * The expected.json oracle is keyed by width, with each width defining its own
 * expected computed styles. Fail-closed: wrong width values = FAIL; missing width
 * coverage = FAIL; leaked cross-width values = FAIL.
 *
 * @see https://github.com/BenSheridanEdwards/StyleProof/issues/622
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { captureStyleMap } from '../dist/index.js';
import type { StyleMap } from '../src/capture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'known-truth-css-multi-width');
const FIXTURE_HTML = path.join(FIXTURE_DIR, 'index.html');
const EXPECTED_JSON = path.join(FIXTURE_DIR, 'expected.json');

/**
 * Oracle structure: width-keyed expected values.
 * Each width defines expected styles for the same testids, but values can DIFFER
 * across widths (the point of media-query fidelity testing).
 */
type ExpectedOracleMultiWidth = {
  description: string;
  widths: number[];
  byWidth: Record<
    string,
    {
      byTestId: Record<
        string,
        {
          tag: string;
          cls: string;
          expectedStyles: Record<string, string>;
        }
      >;
    }
  >;
};

function loadOracle(): ExpectedOracleMultiWidth {
  const content = fs.readFileSync(EXPECTED_JSON, 'utf-8');
  return JSON.parse(content) as ExpectedOracleMultiWidth;
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

async function captureFixtureAtWidth(page: Page, width: number): Promise<StyleMap> {
  await page.setViewportSize({ width, height: 800 });
  await page.goto('file://' + FIXTURE_HTML, { waitUntil: 'load' });
  return await captureStyleMap(page, { stabilize: false, captureStates: false });
}

test.describe('CSS Fidelity: multi-width / media-query known-truth', () => {
  test.describe.configure({ mode: 'serial' });

  test('fixture and oracle files exist', () => {
    expect(fs.existsSync(FIXTURE_HTML), `fixture HTML missing: ${FIXTURE_HTML}`).toBe(true);
    expect(fs.existsSync(EXPECTED_JSON), `oracle JSON missing: ${EXPECTED_JSON}`).toBe(true);
  });

  test('oracle is valid JSON with required multi-width structure', () => {
    const oracle = loadOracle();
    expect(oracle.widths, 'oracle missing widths array').toBeDefined();
    expect(oracle.widths.length, 'oracle must have at least 2 widths').toBeGreaterThanOrEqual(2);
    expect(oracle.byWidth, 'oracle missing byWidth').toBeDefined();

    for (const width of oracle.widths) {
      const widthKey = String(width);
      expect(oracle.byWidth[widthKey], `oracle missing byWidth[${width}]`).toBeDefined();
      expect(oracle.byWidth[widthKey].byTestId, `oracle missing byWidth[${width}].byTestId`).toBeDefined();
      expect(
        Object.keys(oracle.byWidth[widthKey].byTestId).length,
        `oracle byWidth[${width}].byTestId is empty`,
      ).toBeGreaterThan(0);
    }
  });

  test('oracle has at least one testid with DIFFERING values across widths (the point of this test)', () => {
    const oracle = loadOracle();
    const widths = oracle.widths.map(String);
    expect(widths.length, 'need at least 2 widths to diff').toBeGreaterThanOrEqual(2);

    const firstWidthSpecs = oracle.byWidth[widths[0]].byTestId;
    let foundDiffering = false;

    for (const testId of Object.keys(firstWidthSpecs)) {
      const firstStyles = firstWidthSpecs[testId].expectedStyles;
      for (let i = 1; i < widths.length; i++) {
        const otherSpecs = oracle.byWidth[widths[i]]?.byTestId?.[testId];
        if (!otherSpecs) continue;
        const otherStyles = otherSpecs.expectedStyles;
        for (const prop of Object.keys(firstStyles)) {
          if (otherStyles[prop] !== undefined && otherStyles[prop] !== firstStyles[prop]) {
            foundDiffering = true;
            break;
          }
        }
        if (foundDiffering) break;
      }
      if (foundDiffering) break;
    }

    expect(
      foundDiffering,
      'oracle MUST have at least one testid with differing expected values across widths (per issue #622 acceptance)',
    ).toBe(true);
  });

  test('capture contains every expected element at each width (fail-closed on missing)', async ({ page }) => {
    const oracle = loadOracle();

    for (const width of oracle.widths) {
      const map = await captureFixtureAtWidth(page, width);
      const widthSpec = oracle.byWidth[String(width)];

      for (const testId of Object.keys(widthSpec.byTestId)) {
        const found = findElementByTestId(map, testId);
        expect(
          found,
          `FAIL-CLOSED: expected element data-testid="${testId}" not found in captured map at width ${width}`,
        ).toBeDefined();
      }
    }
  });

  test('every expected element has correct tag at each width', async ({ page }) => {
    const oracle = loadOracle();

    for (const width of oracle.widths) {
      const map = await captureFixtureAtWidth(page, width);
      const widthSpec = oracle.byWidth[String(width)];

      for (const [testId, spec] of Object.entries(widthSpec.byTestId)) {
        const found = findElementByTestId(map, testId);
        expect(found, `element data-testid="${testId}" not found at width ${width}`).toBeDefined();
        expect(found!.entry.tag, `element data-testid="${testId}" wrong tag at width ${width}`).toBe(spec.tag);
      }
    }
  });

  test('every expected CSS property matches exactly per width (fail-closed on wrong value or cross-width leak)', async ({
    page,
  }) => {
    const oracle = loadOracle();

    for (const width of oracle.widths) {
      const map = await captureFixtureAtWidth(page, width);
      const widthSpec = oracle.byWidth[String(width)];

      for (const [testId, spec] of Object.entries(widthSpec.byTestId)) {
        const found = findElementByTestId(map, testId);
        expect(found, `FAIL-CLOSED: data-testid="${testId}" not found at width ${width}`).toBeDefined();

        for (const [prop, expectedValue] of Object.entries(spec.expectedStyles)) {
          const actualValue = found!.entry.style[prop];
          expect(
            actualValue,
            `data-testid="${testId}" property "${prop}" at width ${width}: expected "${expectedValue}" but was ${actualValue === undefined ? 'MISSING' : `"${actualValue}"`}`,
          ).toBe(expectedValue);
        }
      }
    }
  });

  test('fail-closed: capturing at wrong width yields different values (proves media queries work)', async ({
    page,
  }) => {
    const oracle = loadOracle();
    const widths = oracle.widths;
    expect(widths.length, 'need at least 2 widths').toBeGreaterThanOrEqual(2);

    const firstWidth = widths[0];
    const secondWidth = widths[1];
    const firstSpec = oracle.byWidth[String(firstWidth)];
    const secondSpec = oracle.byWidth[String(secondWidth)];

    let foundDifferingProp: { testId: string; prop: string; first: string; second: string } | undefined;
    for (const testId of Object.keys(firstSpec.byTestId)) {
      const firstStyles = firstSpec.byTestId[testId].expectedStyles;
      const secondStyles =
        secondSpec.byWidth?.[testId]?.expectedStyles ?? secondSpec.byTestId?.[testId]?.expectedStyles;
      if (!secondStyles) continue;
      for (const prop of Object.keys(firstStyles)) {
        if (secondStyles[prop] !== undefined && secondStyles[prop] !== firstStyles[prop]) {
          foundDifferingProp = { testId, prop, first: firstStyles[prop], second: secondStyles[prop] };
          break;
        }
      }
      if (foundDifferingProp) break;
    }
    expect(foundDifferingProp, 'test requires a differing property across widths').toBeDefined();

    const mapAtFirst = await captureFixtureAtWidth(page, firstWidth);
    const mapAtSecond = await captureFixtureAtWidth(page, secondWidth);

    const foundFirst = findElementByTestId(mapAtFirst, foundDifferingProp!.testId);
    const foundSecond = findElementByTestId(mapAtSecond, foundDifferingProp!.testId);

    expect(foundFirst, 'element not found at first width').toBeDefined();
    expect(foundSecond, 'element not found at second width').toBeDefined();

    const actualFirst = foundFirst!.entry.style[foundDifferingProp!.prop];
    const actualSecond = foundSecond!.entry.style[foundDifferingProp!.prop];

    expect(
      actualFirst,
      `at width ${firstWidth}, property "${foundDifferingProp!.prop}" should be "${foundDifferingProp!.first}"`,
    ).toBe(foundDifferingProp!.first);
    expect(
      actualSecond,
      `at width ${secondWidth}, property "${foundDifferingProp!.prop}" should be "${foundDifferingProp!.second}"`,
    ).toBe(foundDifferingProp!.second);
    expect(
      actualFirst,
      `media query verification: values at different widths must DIFFER to prove breakpoint capture works`,
    ).not.toBe(actualSecond);
  });

  test('incomplete width coverage fails closed (oracle defines widths that must all be tested)', () => {
    const oracle = loadOracle();
    const testedWidths = oracle.widths;

    expect(
      testedWidths.length,
      'FAIL-CLOSED: oracle must define at least 2 widths for multi-width fidelity test',
    ).toBeGreaterThanOrEqual(2);

    for (const width of testedWidths) {
      expect(
        oracle.byWidth[String(width)],
        `FAIL-CLOSED: oracle defines width ${width} but byWidth[${width}] is missing`,
      ).toBeDefined();
    }
  });
});
