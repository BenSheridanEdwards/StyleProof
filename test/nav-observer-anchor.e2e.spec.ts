import { test, expect } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { dedupIdentity, selectCrawlLinks, selectObservedNavs } from '../dist/crawl.js';
import { NAV_OBSERVER_FN, NAV_OBSERVER_SNIPPET } from '../dist/runner/browser.js';

async function serve(html: string): Promise<{ origin: string; close: () => void }> {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

test('the nav observer ignores an in-page anchor but still reports a hash-router route', async ({ page }) => {
  const site = await serve(
    `<!doctype html><nav><a href="/docs">Docs</a></nav><a id="skip" href="#intro">Jump</a>` +
      `<a id="route" href="#/settings">Settings</a><h2 id="intro">Intro</h2>`,
  );
  try {
    const observed: string[] = [];
    await page.exposeFunction(NAV_OBSERVER_FN, (href: string) => observed.push(href));
    await page.addInitScript(NAV_OBSERVER_SNIPPET);
    await page.goto(`${site.origin}/docs`);
    const hrefs = await page.$$eval('a[href]', (els) => els.map((e) => e.getAttribute('href') ?? ''));
    const links = selectCrawlLinks(hrefs, { base: page.url(), includeSelf: true });
    await page.click('#skip');
    await page.waitForTimeout(200);
    const fresh = selectObservedNavs(observed, {
      base: page.url(),
      seen: new Set(links.map((l) => dedupIdentity(l.url))),
      usedKeys: new Set(links.map((l) => l.key)),
    });
    expect(fresh).toEqual([]);
    await page.click('#route');
    await page.waitForTimeout(200);
    expect(observed.some((href) => href.endsWith('/docs#/settings'))).toBe(true);
  } finally {
    site.close();
  }
});
