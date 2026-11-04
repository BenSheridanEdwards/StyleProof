import { test, expect } from '@playwright/test';
import { renderReportHtml } from '../dist/report/html.js';
import { assessReachMaps, reachSectionLines } from '../dist/report/reach.js';
import { makeMap } from './helpers.mjs';
import type { Locator } from '@playwright/test';

// Main's native table display and margins; the remaining page/cell styles are unchanged.
async function mainTableBounds(table: Locator) {
  await table.evaluate((element) => {
    element.classList.remove('table-scroll');
    element.style.margin = '8px 0 16px';
  });
  return table.boundingBox();
}

const capture = (hash: string) => ({
  ...makeMap(),
  reach: {
    version: 2 as const,
    scope: 'compared' as const,
    sheets: ['/styles.css'],
    rules: [{ key: '.modal-open .overlay', hash, sheet: 0 }],
  },
});
const reach = assessReachMaps([capture('before')], [capture('after')], 'warn');
if (!reach) throw new Error('fixture must emit reach findings');
const longValue = 'https://example.com/assets/' + 'long-selector'.repeat(25) + '.css';
const markdown = [
  '## Report tables',
  '| Property | Before | After |',
  '| --- | --- | --- |',
  '| `color` | `red` | `blue` |',
  '',
  '| State | Property | Before → After |',
  '| --- | --- | --- |',
  '| `:hover` | `color` | `red` → `blue` |',
  '',
  ...reachSectionLines(reach),
  '',
  '| Property | Value |',
  '| --- | --- |',
  `| \`background-image\` | \`${longValue}\` |`,
].join('\n');

test('wide report tables scroll by keyboard inside a 390px page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.setContent(renderReportHtml(markdown));
  // Assert the original bug first, rather than failing only on missing new markup.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  const tables = page.getByRole('table');
  await expect(tables).toHaveCount(4);
  for (const table of await tables.all()) {
    expect(await table.evaluate((element) => element.getBoundingClientRect().right)).toBeLessThanOrEqual(374);
  }
  const reachTable = page.getByRole('table', { name: 'Rule, Change, Gated by, Source, Why', exact: true });
  expect(await reachTable.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(0);
  await page.keyboard.press('Tab');
  await expect(reachTable).toBeFocused();
  await reachTable.press('ArrowRight');
  await expect.poll(() => reachTable.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollX)).toBe(0);
  await expect(page.getByText(longValue, { exact: true })).toHaveText(longValue);
  expect(
    await page.getByText(longValue, { exact: true }).evaluate((element) => element.getClientRects().length),
  ).toBeGreaterThan(1);
});

for (const width of [768, 1440]) {
  test(`fitting tables keep their native layout at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(renderReportHtml(reachSectionLines(reach).join('\n')));
    const table = page.getByRole('table');
    const bounds = await table.boundingBox();
    expect(await table.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
    expect(await mainTableBounds(table)).toEqual(bounds);
  });
}

const spacedValues = [
  {
    property: 'box-shadow',
    value: Array.from({ length: 12 }, (_, index) => `${index}px 2px 4px rgba(0, 0, 0, 0.2)`).join(', '),
  },
  { property: 'font-family', value: Array.from({ length: 16 }, (_, index) => `"Example Family ${index}"`).join(', ') },
];

for (const width of [768, 1440]) {
  for (const { property, value } of spacedValues) {
    test(`spaced ${property} values retain main's wrapping at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.setContent(
        renderReportHtml(
          `| Property | Before | After |\n| --- | --- | --- |\n| \`${property}\` | \`${value}\` | \`${value}\` |`,
        ),
      );
      const table = page.getByRole('table');
      const bounds = await table.boundingBox();
      const overflow = await table.evaluate((element) => element.scrollWidth - element.clientWidth);
      const native = await mainTableBounds(table);
      expect(overflow).toBe(0);
      expect(bounds).toEqual(native);
    });
  }
}

test('a short escaped selector keeps main’s inline height at 1440px', async ({ page }) => {
  const selector = 'a>b>c>d>e>f>g>h>i>j>k>l>m>n>o';
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setContent(
    renderReportHtml(
      `| Property | Before | After |\n| --- | --- | --- |\n| selector | \`${selector}\` | \`${selector}\` |`,
    ),
  );
  const table = page.getByRole('table');
  const bounds = await table.boundingBox();
  expect(await mainTableBounds(table)).toEqual(bounds);
});

test('fitting tables are skipped by Tab while an overflowing table receives native focus', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setContent(renderReportHtml(markdown + '\n\n[After tables](#after)'));
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'After tables' })).toBeFocused();
  await page.setViewportSize({ width: 390, height: 900 });
  await page.setContent(renderReportHtml(markdown + '\n\n[After tables](#after)'));
  await page.keyboard.press('Tab');
  await expect(page.getByRole('table', { name: 'Rule, Change, Gated by, Source, Why' })).toBeFocused();
});

test('code-like text inside link and image attributes stays intact', async ({ page }) => {
  const value = 'a'.repeat(70);
  await page.setContent(
    renderReportHtml(
      `| Property | Value |\n| --- | --- |\n| link | [x](\`${value}\`) |\n| image | ![\`${value}\`](crops/a.png) |`,
    ),
  );
  const link = page.getByRole('link', { name: 'x' });
  await expect(link).toHaveAttribute('href', `<code>${value}</code>`);
  expect(await link.evaluate((element) => element.attributes.length)).toBe(1);
  await expect(page.locator('img')).toHaveAttribute('alt', `<code>${value}</code>`);
});
