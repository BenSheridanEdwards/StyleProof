import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { captureStyleMap, loadStyleMap } from '../dist/index.js';
import { parseCaptureUrlArgs, runCaptureUrl } from '../dist/capture-url.js';

// A page whose style CSP disallows 'unsafe-inline' must still capture, with StyleProof's
// motion freeze and hover sink in effect (#977). Every page links an external sheet and
// carries its own inline style, which the captureStyleMap tests check stayed blocked.
test.describe.configure({ mode: 'parallel' });

const FREEZE_CSS = '*,*::before,*::after{animation:none!important;transition:none!important}';
const CSS = `body{margin:0} .x{display:block;color:rgb(0,0,255)} .x:hover{color:rgb(255,0,0)}
  .btn{transition:color 240ms ease;color:rgb(0,0,0)}`;

function doc(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/s.css">
    <style>.probe{color:rgb(1,2,3)}</style></head><body>${body}</body></html>`;
}

async function serve(csp: string, html: string): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const css = req.url === '/s.css';
    res.writeHead(200, { 'content-type': css ? 'text/css' : 'text/html', 'content-security-policy': csp });
    res.end(css ? CSS : html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, close: () => server.close() };
}

/** The page's own inline <style> stayed blocked, so the CSP under test was enforced. */
async function expectInlineStylesBlocked(page: Page): Promise<void> {
  const probe = await page.evaluate(() => getComputedStyle(document.querySelector('.probe')!).color);
  expect(probe, 'the CSP blocks the page’s own inline <style>').not.toBe('rgb(1, 2, 3)');
}

/** Freeze sheets left on the page: inline <style> tags or adopted constructed sheets. */
function freezeSheetsLeft(page: Page): Promise<number> {
  return page.evaluate((css) => {
    const rules = (sheet: CSSStyleSheet) => Array.from(sheet.cssRules, (rule) => rule.cssText).join('');
    const frozen = (sheet: CSSStyleSheet) => rules(sheet).includes('animation: none !important');
    const tags = Array.from(document.querySelectorAll('style')).filter((s) => s.textContent === css);
    return tags.length + document.adoptedStyleSheets.filter(frozen).length;
  }, FREEZE_CSS);
}

test("styleproof-capture writes a map for a page whose CSP is default-src 'self'", async () => {
  const site = await serve("default-src 'self'", doc('<main><h1>Hello</h1></main>'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-csp-'));
  try {
    const opts = parseCaptureUrlArgs([site.url, '--widths', '800', '--out', out]);
    const results = await runCaptureUrl(opts, () => chromium.launch());
    expect(results.map((r) => r.width)).toEqual([800]);
    const map = loadStyleMap(results[0].map);
    expect(Object.values(map.elements).some((e) => e.tag === 'h1')).toBe(true);
    expect(fs.existsSync(results[0].screenshot!)).toBe(true);
  } finally {
    site.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("captureStyleMap freezes motion and leaves no sheet behind under default-src 'self'", async ({ page }) => {
  const site = await serve("default-src 'self'", doc('<button class="btn probe">go</button>'));
  try {
    await page.goto(site.url);
    await expectInlineStylesBlocked(page);
    // Record, every frame, whether the declared 240ms transition was ever frozen to 0s.
    await page.evaluate(() => {
      const btn = document.querySelector('.btn')!;
      const watch = () => {
        if (getComputedStyle(btn).transitionDuration === '0s') document.body.dataset.frozen = 'yes';
        requestAnimationFrame(watch);
      };
      watch();
    });
    const map = await captureStyleMap(page);
    expect(await page.evaluate(() => document.body.dataset.frozen), 'the freeze applied during the capture').toBe(
      'yes',
    );
    const btn = Object.values(map.elements).find((e) => e.cls === 'btn probe');
    expect(btn?.style['transition-duration'], 'the motion read sees the declared transition').toBe('0.24s');
    expect(await freezeSheetsLeft(page), 'no freeze sheet survives the capture').toBe(0);
    await captureStyleMap(page);
    expect(await freezeSheetsLeft(page), 'recapturing in place piles up no freeze sheets').toBe(0);
  } finally {
    site.close();
  }
});

test("the hover sink stays fixed at (0,0) under style-src-attr 'none'", async ({ page }) => {
  const csp = "style-src 'self' 'unsafe-inline'; style-src-attr 'none'";
  const site = await serve(csp, doc('<a class="x" href="#">top-left link</a><p style="color:rgb(1,2,3)">x</p>'));
  try {
    await page.goto(site.url);
    const attr = await page.evaluate(() => getComputedStyle(document.querySelector('p')!).color);
    expect(attr, 'the CSP blocks the page’s own style attribute').not.toBe('rgb(1, 2, 3)');
    const map = await captureStyleMap(page);
    const sink = await page.evaluate(
      () => getComputedStyle(document.querySelector('[data-styleproof-hover-sink]')!).position,
    );
    expect(sink).toBe('fixed');
    const link = Object.values(map.elements).find((e) => e.cls === 'x');
    expect(link?.style.color, 'real :hover does not leak into the resting map').toBe('rgb(0, 0, 255)');
  } finally {
    site.close();
  }
});
