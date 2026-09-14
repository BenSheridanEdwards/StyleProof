/**
 * Color-Scheme CSS Fidelity Test — Trust Ladder Rung 1 (Issue #626)
 *
 * Proves StyleProof captures exact computed-style values under
 * `prefers-color-scheme: light` and `prefers-color-scheme: dark`.
 * Theme tokens can drift while a light-only fixture stays green; this
 * suite forces each scheme through Playwright `page.emulateMedia({ colorScheme })`
 * — the same media-emulation seam capture already uses for reduced-motion —
 * and asserts the scheme-keyed expected.json oracle.
 *
 * The same testid MUST have DIFFERENT expected values under light vs dark.
 * Fail-closed: wrong scheme values = FAIL; missing scheme coverage = FAIL;
 * leaked cross-scheme values = FAIL. HTML comments are documentation only;
 * tests never parse them as truth.
 *
 * @see https://github.com/BenSheridanEdwards/StyleProof/issues/626
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { captureStyleMap } from '../dist/index.js';
import type { StyleMap } from '../src/capture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'known-truth-css-color-scheme');
const FIXTURE_HTML = path.join(FIXTURE_DIR, 'index.html');
const EXPECTED_JSON = path.join(FIXTURE_DIR, 'expected.json');

const REQUIRED_SCHEMES = ['light', 'dark'] as const;
type ColorScheme = (typeof REQUIRED_SCHEMES)[number];

/**
 * Oracle structure: scheme-keyed expected values.
 * Each scheme defines expected styles for the same testids, but values MUST
 * differ across schemes (the point of prefers-color-scheme fidelity).
 */
type ExpectedOracleColorScheme = {
  description: string;
  schemes: ColorScheme[];
  byScheme: Record<
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
      customProperties?: Record<string, string>;
    }
  >;
};

function loadOracle(): ExpectedOracleColorScheme {
  const content = fs.readFileSync(EXPECTED_JSON, 'utf-8');
  return JSON.parse(content) as ExpectedOracleColorScheme;
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

/**
 * Force color-scheme via the product media-emulation seam, then capture.
 * Capture itself calls emulateMedia({ reducedMotion: 'reduce' }); Playwright
 * merges unspecified features, so the scheme set here persists.
 */
async function captureFixtureAtScheme(page: Page, scheme: ColorScheme): Promise<StyleMap> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto('file://' + FIXTURE_HTML, { waitUntil: 'load' });
  return await captureStyleMap(page, { stabilize: false, captureStates: false });
}

function findDifferingProp(oracle: ExpectedOracleColorScheme): {
  testId: string;
  prop: string;
  light: string;
  dark: string;
} {
  const lightSpecs = oracle.byScheme.light.byTestId;
  const darkSpecs = oracle.byScheme.dark.byTestId;
  for (const testId of Object.keys(lightSpecs)) {
    const lightStyles = lightSpecs[testId].expectedStyles;
    const darkStyles = darkSpecs[testId]?.expectedStyles;
    if (!darkStyles) continue;
    for (const prop of Object.keys(lightStyles)) {
      if (darkStyles[prop] !== undefined && darkStyles[prop] !== lightStyles[prop]) {
        return { testId, prop, light: lightStyles[prop], dark: darkStyles[prop] };
      }
    }
  }
  throw new Error('FAIL-CLOSED: oracle has no testid with differing light vs dark values');
}

test.describe('CSS Fidelity: prefers-color-scheme light/dark known-truth', () => {
  test.describe.configure({ mode: 'serial' });

  test('fixture and oracle files exist', () => {
    expect(fs.existsSync(FIXTURE_HTML), `fixture HTML missing: ${FIXTURE_HTML}`).toBe(true);
    expect(fs.existsSync(EXPECTED_JSON), `oracle JSON missing: ${EXPECTED_JSON}`).toBe(true);
  });

  test('oracle is valid JSON with required light+dark scheme structure', () => {
    const oracle = loadOracle();
    expect(oracle.schemes, 'oracle missing schemes array').toBeDefined();
    expect(oracle.schemes.length, 'oracle must have at least light and dark').toBeGreaterThanOrEqual(2);
    expect(oracle.byScheme, 'oracle missing byScheme').toBeDefined();

    for (const scheme of REQUIRED_SCHEMES) {
      expect(oracle.schemes.includes(scheme), `FAIL-CLOSED: oracle.schemes missing "${scheme}"`).toBe(true);
      expect(oracle.byScheme[scheme], `FAIL-CLOSED: oracle missing byScheme[${scheme}]`).toBeDefined();
      expect(oracle.byScheme[scheme].byTestId, `oracle missing byScheme[${scheme}].byTestId`).toBeDefined();
      expect(
        Object.keys(oracle.byScheme[scheme].byTestId).length,
        `oracle byScheme[${scheme}].byTestId is empty`,
      ).toBeGreaterThan(0);
    }
  });

  test('oracle has at least one testid with DIFFERING values across schemes (the point of this test)', () => {
    const oracle = loadOracle();
    const differing = findDifferingProp(oracle);
    expect(differing.light, 'light and dark oracle values must differ').not.toBe(differing.dark);
  });

  test('capture contains every expected element at each scheme (fail-closed on missing)', async ({ page }) => {
    const oracle = loadOracle();

    for (const scheme of oracle.schemes) {
      const map = await captureFixtureAtScheme(page, scheme);
      const schemeSpec = oracle.byScheme[scheme];

      for (const testId of Object.keys(schemeSpec.byTestId)) {
        const found = findElementByTestId(map, testId);
        expect(
          found,
          `FAIL-CLOSED: expected element data-testid="${testId}" not found in captured map under ${scheme}`,
        ).toBeDefined();
      }
    }
  });

  test('every expected element has correct tag at each scheme', async ({ page }) => {
    const oracle = loadOracle();

    for (const scheme of oracle.schemes) {
      const map = await captureFixtureAtScheme(page, scheme);
      const schemeSpec = oracle.byScheme[scheme];

      for (const [testId, spec] of Object.entries(schemeSpec.byTestId)) {
        const found = findElementByTestId(map, testId);
        expect(found, `element data-testid="${testId}" not found under ${scheme}`).toBeDefined();
        expect(found!.entry.tag, `element data-testid="${testId}" wrong tag under ${scheme}`).toBe(spec.tag);
      }
    }
  });

  test('every expected CSS property matches exactly per scheme (fail-closed on wrong value or cross-scheme leak)', async ({
    page,
  }) => {
    const oracle = loadOracle();

    for (const scheme of oracle.schemes) {
      const map = await captureFixtureAtScheme(page, scheme);
      const schemeSpec = oracle.byScheme[scheme];

      for (const [testId, spec] of Object.entries(schemeSpec.byTestId)) {
        const found = findElementByTestId(map, testId);
        expect(found, `FAIL-CLOSED: data-testid="${testId}" not found under ${scheme}`).toBeDefined();

        for (const [prop, expectedValue] of Object.entries(spec.expectedStyles)) {
          const actualValue = found!.entry.style[prop];
          expect(
            actualValue,
            `data-testid="${testId}" property "${prop}" under ${scheme}: expected "${expectedValue}" but was ${actualValue === undefined ? 'MISSING' : `"${actualValue}"`}`,
          ).toBe(expectedValue);
        }
      }

      if (schemeSpec.customProperties) {
        expect(map.tokens, `capture missing tokens (custom properties) under ${scheme}`).toBeDefined();
        for (const [varName, expectedValue] of Object.entries(schemeSpec.customProperties)) {
          if (!varName.startsWith('--')) continue;
          const actualValue = map.tokens?.[varName];
          expect(
            actualValue,
            `custom property "${varName}" under ${scheme}: expected "${expectedValue}" but was ${actualValue === undefined ? 'NOT CAPTURED' : `"${actualValue}"`}`,
          ).toBe(expectedValue);
        }
      }
    }
  });

  test('fail-closed: capturing under the wrong scheme yields different values (proves media queries work)', async ({
    page,
  }) => {
    const oracle = loadOracle();
    const differing = findDifferingProp(oracle);

    const mapLight = await captureFixtureAtScheme(page, 'light');
    const mapDark = await captureFixtureAtScheme(page, 'dark');

    const foundLight = findElementByTestId(mapLight, differing.testId);
    const foundDark = findElementByTestId(mapDark, differing.testId);

    expect(foundLight, 'element not found under light').toBeDefined();
    expect(foundDark, 'element not found under dark').toBeDefined();

    const actualLight = foundLight!.entry.style[differing.prop];
    const actualDark = foundDark!.entry.style[differing.prop];

    expect(actualLight, `under light, property "${differing.prop}" should be "${differing.light}"`).toBe(
      differing.light,
    );
    expect(actualDark, `under dark, property "${differing.prop}" should be "${differing.dark}"`).toBe(differing.dark);
    expect(
      actualLight,
      'prefers-color-scheme verification: values under light and dark must DIFFER to prove scheme capture works',
    ).not.toBe(actualDark);

    // Default Playwright color-scheme is light. A capture that never forces dark
    // must not satisfy the dark oracle — otherwise the suite could soft-green.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('file://' + FIXTURE_HTML, { waitUntil: 'load' });
    const mapDefault = await captureStyleMap(page, { stabilize: false, captureStates: false });
    const foundDefault = findElementByTestId(mapDefault, differing.testId);
    expect(foundDefault, 'element not found under default/light capture').toBeDefined();
    expect(
      foundDefault!.entry.style[differing.prop],
      `FAIL-CLOSED: default/light capture must NOT equal the dark oracle for "${differing.prop}"`,
    ).not.toBe(differing.dark);
  });

  test('incomplete scheme coverage fails closed (oracle defines schemes that must all be tested)', () => {
    const oracle = loadOracle();
    const testedSchemes = oracle.schemes;

    expect(
      testedSchemes.length,
      'FAIL-CLOSED: oracle must define at least light and dark for color-scheme fidelity',
    ).toBeGreaterThanOrEqual(2);

    for (const required of REQUIRED_SCHEMES) {
      expect(testedSchemes.includes(required), `FAIL-CLOSED: oracle.schemes missing required "${required}"`).toBe(true);
      expect(
        oracle.byScheme[required],
        `FAIL-CLOSED: oracle defines scheme ${required} but byScheme[${required}] is missing`,
      ).toBeDefined();
    }
  });
});
