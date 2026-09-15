import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureStyleMap } from '../dist/index.js';
import type { StyleMap } from '../src/capture.js';

const schemes = ['light', 'dark'] as const;
type Scheme = (typeof schemes)[number];
type ExpectedOracle = {
  description: string;
  byScheme: Record<Scheme, Record<string, string>>;
};

const fixtureDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'known-truth-color-scheme',
);
const fixtureHtml = path.join(fixtureDirectory, 'index.html');
const expectedJson = path.join(fixtureDirectory, 'expected.json');

function loadOracle(): ExpectedOracle {
  return JSON.parse(fs.readFileSync(expectedJson, 'utf8')) as ExpectedOracle;
}

function schemeCard(map: StyleMap): StyleMap['elements'][string] {
  const cards = Object.values(map.elements).filter((entry) => entry.cls === 'scheme-card');
  expect(cards, 'FAIL-CLOSED: capture must contain exactly one scheme-card').toHaveLength(1);
  return cards[0]!;
}

test('oracle declares distinct light and dark contracts (#626)', () => {
  const oracle = loadOracle();
  expect(oracle.byScheme.light).not.toEqual(oracle.byScheme.dark);
});

for (const scheme of schemes) {
  test(`captures exact ${scheme} prefers-color-scheme values (#626)`, async ({ page }) => {
    const oracle = loadOracle();
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('file://' + fixtureHtml, { waitUntil: 'load' });
    const card = schemeCard(await captureStyleMap(page, { stabilize: false, captureStates: false }));

    for (const [property, expectedValue] of Object.entries(oracle.byScheme[scheme])) {
      expect(card.style[property], `${scheme} ${property} must match the frozen oracle`).toBe(expectedValue);
    }
  });
}
