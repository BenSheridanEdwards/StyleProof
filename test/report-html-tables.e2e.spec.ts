import { test, expect } from '@playwright/test';
import { renderReportHtml } from '../dist/report/html.js';
import { assessReachMaps, reachSectionLines } from '../dist/report/reach.js';
import { makeMap } from './helpers.mjs';

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
  await expect(tables.nth(0)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(tables.nth(1)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(reachTable).toBeFocused();
  await reachTable.press('ArrowRight');
  await expect.poll(() => reachTable.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollX)).toBe(0);
  await expect(page.getByText(longValue, { exact: true })).toHaveText(longValue);
  expect(await page.locator('.long-code').evaluate((element) => element.getBoundingClientRect().width)).toBeLessThan(
    350,
  );
  const shortValue = page.locator('td code').filter({ hasText: /^\.modal-open \.overlay$/ });
  expect(await shortValue.evaluate((element) => element.getClientRects().length)).toBe(1);
});

for (const width of [768, 1440]) {
  test(`fitting tables keep their native layout at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(renderReportHtml(reachSectionLines(reach).join('\n')));
    const table = page.getByRole('table');
    const bounds = await table.boundingBox();
    expect(await table.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
    // Restore the original native table display and margins for comparison.
    await table.evaluate((element) => {
      element.classList.remove('table-scroll');
      element.style.margin = '8px 0 16px';
    });
    expect(await table.boundingBox()).toEqual(bounds);
  });
}
