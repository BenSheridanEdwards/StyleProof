import { test, expect } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { detectViewportWidths } from '../dist/breakpoints.js';

test('breakpoint detection reads @import, sheet media and adopted sheets', async ({ page }) => {
  const css: Record<string, string> = {
    '/imported.css': '@media (min-width: 900px) { body { color: red } }',
    '/conditional.css': 'body { outline: 1px solid }',
    '/linked.css': 'body { padding: 1px }',
  };
  const site = http.createServer((req, res) => {
    const sheet = css[req.url ?? ''];
    res.setHeader('content-type', sheet !== undefined ? 'text/css' : 'text/html');
    res.end(
      sheet ??
        `<!doctype html><style>@import url(/imported.css); @import url(/conditional.css) (min-width: 650px);</style>
<link rel="stylesheet" href="/linked.css" media="(min-width: 800px)">
<style media="(min-width: 700px)">body { margin: 1px }</style><body>x</body>`,
    );
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  try {
    await page.goto(`http://127.0.0.1:${(site.address() as AddressInfo).port}/`);
    await page.evaluate(() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync('@media (min-width: 1100px) { body { border: 1px solid } }');
      document.adoptedStyleSheets = [sheet];
    });
    expect(await detectViewportWidths(page)).toEqual([360, 650, 700, 800, 900, 1100]);
  } finally {
    site.close();
  }
});

test('breakpoint detection resolves em against 16px whatever the root font size', async ({ page }) => {
  await page.setContent(
    '<style>html { font-size: 10px } @media (min-width: 40em) { body { padding: 1px } }</style><body>x</body>',
  );
  expect(await detectViewportWidths(page)).toEqual([360, 640]);
});

test('breakpoint detection fails loudly on a width condition it cannot resolve', async ({ page }) => {
  await page.setContent('<style>@media (min-width: 9in) { body { color: red } }</style><body>x</body>');
  await expect(detectViewportWidths(page)).rejects.toThrow(/can't detect breakpoints.*min-width: 9in/);
  await page.setContent('<style>@media (400px <= width <= 9in) { body { color: red } }</style><body>x</body>');
  await expect(detectViewportWidths(page)).rejects.toThrow(/can't detect breakpoints/);
});
