import { test, expect } from '@playwright/test';
import { renderReportHtml } from '../dist/report/html.js';
import { assessReachMaps, reachSectionLines } from '../dist/report/reach.js';
import { makeMap } from './helpers.mjs';

const capture = (hash: string) => ({
  ...makeMap(),
  reach: {
    version: 2 as const,
    scope: 'compared' as const,
    sheets: ['/assets/application-stylesheet-with-a-long-name.css'],
    rules: [{ key: '.panel-with-a-long-unmatched-selector', hash, sheet: 0 }],
  },
});
const reach = assessReachMaps([capture('before')], [capture('after')], 'warn')!;
const markdown = [
  ...reachSectionLines(reach),
  '',
  '| Property | Before | After |',
  '| --- | --- | --- |',
  `| font-family | serif | \`${'LongFontFamily'.repeat(20)}\` |`,
].join('\n');

for (const width of [390, 768, 1440]) {
  test(`reach tables fit the report at ${width}px and preserve table semantics`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(renderReportHtml(markdown));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const wide = page.locator('table').first();
    await expect(wide.getByRole('columnheader')).toHaveCount(5);
    await expect(wide.getByRole('cell')).toHaveCount(5);
    const cell = wide.locator('td').first();
    expect(await cell.evaluate((element) => getComputedStyle(element).display)).toBe(
      width === 390 ? 'block' : 'table-cell',
    );
    expect(await cell.evaluate((element) => getComputedStyle(element, '::before').content)).toBe(
      width === 390 ? '"Rule"' : 'none',
    );
    expect(
      await page
        .locator('table')
        .last()
        .locator('td')
        .first()
        .evaluate((element) => getComputedStyle(element).display),
    ).toBe('table-cell');
  });
}

test('wide tables respond to the main column width inside a desktop viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setContent(renderReportHtml(markdown));
  await page.locator('main').evaluate((element) => {
    element.style.maxWidth = '350px';
  });
  expect(
    await page
      .locator('td')
      .first()
      .evaluate((element) => getComputedStyle(element).display),
  ).toBe('block');
});
