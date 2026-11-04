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
  '| font-family | serif | `sans-serif` |',
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
      width === 390 ? '"Rule" / ""' : 'none',
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

// The unchanged table, code and text-column CSS from main before responsive cards.
const mainTableCss = `
  body { margin: 0; color: #1f2328; background: #fff;
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { max-width: 960px; margin: 0 auto; padding: 24px 16px 64px; }
  table { border-collapse: collapse; margin: 8px 0 16px; }
  th, td { border: 1px solid #d1d9e0; padding: 6px 12px; text-align: left; }
  th { background: #f6f8fa; }
  code { background: #eff1f3; padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }
`;
const reviewRow = [
  '| Rule | Change | Gated by | Source | Why |',
  '| --- | --- | --- | --- | --- |',
  '| `.checkout-summary__line-item--discounted` | changed | `@media (min-width: 1200px)` | `/assets/application-stylesheet.css` | The selector never matched a captured element in any compared state; add a surface or state that exercises the changed rule. |',
].join('\n');

for (const width of [768, 1440]) {
  test(`fitting Reach table and column geometry matches main CSS at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const html = renderReportHtml(reviewRow);
    const geometry = () =>
      page.locator('table').evaluate((table) =>
        [table, ...table.querySelectorAll('th, td')].map((element) => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height };
        }),
      );
    await page.setContent(html.replace(/<style>[\s\S]*?<\/style>/, `<style>${mainTableCss}</style>`));
    const expected = await geometry();
    await page.setContent(html);
    expect(await geometry()).toEqual(expected);
  });
}

test('mobile card labels are visual only in the accessibility tree', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.setContent(
    renderReportHtml(
      [
        '| Rule | Change | Source | Why |',
        '| --- | --- | --- | --- |',
        '| .panel | changed | app.css | Never matched |',
      ].join('\n'),
    ),
  );
  expect(await page.getByRole('table').ariaSnapshot()).toBe(`- table:
  - rowgroup:
    - row "Rule Change Source Why":
      - columnheader "Rule"
      - columnheader "Change"
      - columnheader "Source"
      - columnheader "Why"
  - rowgroup:
    - row ".panel changed app.css Never matched":
      - cell ".panel"
      - cell "changed"
      - cell "app.css"
      - cell "Never matched"`);
});

test('a header-only wide table remains visibly readable at 390px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.setContent(renderReportHtml('| Rule | Change | Source | Why |\n| --- | --- | --- | --- |'));
  await expect(page.getByRole('columnheader')).toHaveCount(4);
  const header = await page.locator('thead').boundingBox();
  expect(header!.height).toBeGreaterThan(20);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('a long value in an ordinary three-column table fits at 390px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.setContent(
    renderReportHtml(
      [
        '| Property | Before | After |',
        '| --- | --- | --- |',
        `| font-family | serif | \`${'LongFontFamily'.repeat(20)}\` |`,
      ].join('\n'),
    ),
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  expect(
    await page
      .locator('td')
      .first()
      .evaluate((cell) => getComputedStyle(cell).display),
  ).toBe('table-cell');
});
