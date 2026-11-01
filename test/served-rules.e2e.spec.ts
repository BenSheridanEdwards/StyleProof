import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  captureStyleMap,
  diffStyleMaps,
  trackServedRules,
  type ServedRule,
  type ServedRuleTracker,
  type StyleMap,
} from '../dist/index.js';
import { loadStyleMap } from '../dist/capture.js';
import { captureSurface } from '../dist/runner/surface-capture.js';
import { resolveSettings } from '../dist/runner/settings.js';
import { servedRulesOf } from '../dist/capture/reach.js';

test('Chromium oracle agrees with accepted reader declaration boundaries', async ({ page }) => {
  // Expose the existing reader only in this test module; production exports stay unchanged.
  const source = fs
    .readFileSync(new URL('../dist/capture/reach.js', import.meta.url), 'utf8')
    .replace(
      "'../pseudo-references.js'",
      JSON.stringify(new URL('../dist/pseudo-references.js', import.meta.url).href),
    );
  const reader = await import(
    `data:text/javascript;base64,${Buffer.from(source + '\nexport { leafRules, declarations };').toString('base64')}`
  );
  for (const css of [
    '.t{--x:";{}";font-family:"Other";animation-name:k}',
    '.t{/* ;{} */--x:rgb(1,2,3);font-family:Other}',
    String.raw`.t{--x:a\;b;background:url(a\));font-family:Other}`,
    String.raw`.t{background:url(a\ b.png);font-family:Other}`,
    '.t{background:url("a;{}.png");font-family:Other}',
    '.t{background:url(a.png)}.u{animation-name:k;--y:"x"}',
  ]) {
    servedRulesOf(css, []);
    const extracted: [string, string][][] = reader
      .leafRules(css)
      .map((leaf: { body: string }) => reader.declarations(leaf.body));
    const result = await page.evaluate(
      ({ css, extracted }) => {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        const flatten = (rules: CSSRule[]): CSSStyleRule[] =>
          rules.flatMap((rule) =>
            rule instanceof CSSStyleRule
              ? [rule]
              : 'cssRules' in rule
                ? flatten(Array.from((rule as CSSGroupingRule).cssRules))
                : [],
          );
        const selected = (style: CSSStyleDeclaration) =>
          Array.from(style)
            .filter((name) => name.startsWith('--') || name === 'font-family' || name === 'animation-name')
            .sort()
            .map((name) => [name, style.getPropertyValue(name)]);
        return {
          actual: flatten(Array.from(sheet.cssRules)).map((rule) => selected(rule.style)),
          expected: extracted.map((values) => {
            const style = document.createElement('span').style;
            for (const [name, value] of values) style.setProperty(name, value);
            return selected(style);
          }),
        };
      },
      { css, extracted },
    );
    expect(result.actual, css).toEqual(result.expected);
  }
});

for (const ambiguous of [false, true]) {
  test(`cross-origin URL sheet without CORS, ambiguous=${ambiguous}`, async ({ page }) => {
    const server = http.createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/css');
      response.end(
        '@font-face{font-family:Other;src:url(x.woff2)}' +
          (ambiguous
            ? '.t{background:url(a(b);font-family:Other;c:x)}'
            : '.t{font-family:Other;background:url(a.png)}'),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const servedRules = await trackServedRules(page);
      await page.setContent(
        `<link rel="stylesheet" href="http://127.0.0.1:${(server.address() as AddressInfo).port}/app.css"><p class="t">x</p>`,
      );
      await page.waitForFunction(() => document.styleSheets.length > 0);
      expect(
        await page.evaluate(() => {
          try {
            return document.styleSheets[0].cssRules.length < 0;
          } catch {
            return true;
          }
        }),
      ).toBe(true);
      const capture = captureStyleMap(page, { captureReach: true, servedRules });
      if (ambiguous) await expect(capture).rejects.toThrow(/reach is unknown/);
      else expect((await capture).reach?.rules.some((entry) => entry.refs?.includes('Other'))).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
}

for (const css of [
  '.t{background:url(a(b);font-family:Other;c:x)}',
  '.t{background:url(/*);font-family:Other;c:*/)}',
  '.t{--f:Other;background:url(a(b);font-family:var(--f);c:x)}',
]) {
  test(`ambiguous URL cannot hide a rendered font: ${css}`, async ({ page }) => {
    const servedRules = await trackServedRules(page);
    await page.setContent(`<style>@font-face{font-family:Other;src:url(x.woff2)}${css}</style><p class="t">x</p>`);
    expect(await page.locator('.t').evaluate((node) => getComputedStyle(node).fontFamily)).toContain('Other');
    await expect(captureStyleMap(page, { captureReach: true, servedRules })).rejects.toThrow(/reach is unknown/);
  });
}

for (const css of [
  '.a{background:url(/*)}.t{font-family:Other;c:*/)}',
  String.raw`.t{background:u\72l(a(b);font-family:Other;c:x)}`,
  ...['@media all', '@layer test', '@supports (display:block)', '@container (width > 0px)'].map(
    (group) => `${group}{.t{background:url(a(b);font-family:Other;c:x)}}`,
  ),
  '@keyframes k{from{background:url(a(b);font-family:Other;c:x)}}',
  '.t{background:url(a(b);&{font-family:Other}c:x)}',
  '@font-face{src:url(a(b);font-family:X;c:x)}',
]) {
  test(`ambiguous URL rejects throughout a stylesheet: ${css}`, async ({ page }) => {
    const servedRules = await trackServedRules(page);
    await page.setContent(`<style>@font-face{font-family:Other;src:url(x.woff2)}${css}</style><p class="t">x</p>`);
    await expect(captureStyleMap(page, { captureReach: true, servedRules })).rejects.toThrow(/reach is unknown/);
  });
}

for (const scope of ['document', 'shadow-constructed', 'shadow-open', 'shadow-closed']) {
  for (const ambiguous of [false, true]) {
    test(`URL guard covers ${scope}, ambiguous=${ambiguous}`, async ({ page }) => {
      const servedRules = await trackServedRules(page);
      await page.setContent('<div id="host"></div>');
      await page.evaluate(
        ({ scope, ambiguous }) => {
          const css =
            '@font-face{font-family:Other;src:url(x.woff2)}' +
            (ambiguous
              ? '.t{background:url(a(b);font-family:Other;c:x)}'
              : '.t{font-family:Other;background:url(x.png)}');
          const root =
            scope === 'document'
              ? document
              : document.querySelector('#host')!.attachShadow({ mode: scope === 'shadow-closed' ? 'closed' : 'open' });
          if (scope === 'document' || scope === 'shadow-constructed') {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(css);
            root.adoptedStyleSheets = [sheet];
          } else {
            const style = document.createElement('style');
            style.textContent = css;
            root.appendChild(style);
          }
          const element = document.createElement('p');
          element.className = 't';
          element.textContent = 'x';
          (root === document ? document.body : root).appendChild(element);
        },
        { scope, ambiguous },
      );
      const capture = captureStyleMap(page, { captureReach: true, servedRules });
      if (ambiguous) await expect(capture).rejects.toThrow(/reach is unknown/);
      else expect((await capture).reach?.rules.some((entry) => entry.refs?.includes('Other'))).toBe(true);
    });
  }
}

// Change Reach ledger (#991): with `captureReach`, a capture records every served CSS
// rule and whether it matched an element while the map was read, through Chromium's
// rule usage tracking. Off by default, and it never changes what the diff compares.
// Like trackInflightRequests, the tracker is armed before navigation to record linked
// stylesheets as they load, without relying on Chromium's inspector re-fetches.

test('browser-owned details sheets do not make reach ambiguous', async ({ page }) => {
  const servedRules = await trackServedRules(page);
  await page.setContent(
    '<style>.a{color:rgb(1,2,3)}</style><p class="a">x</p><details><summary>s</summary>y</details><details open><summary>t</summary>z</details>',
  );
  const map = await captureStyleMap(page, { captureReach: true, servedRules });
  expect(map.reach?.sheets).toEqual(['inline']);
  expect(map.reach?.rules.some((r) => r.key.startsWith(':host'))).toBe(false);
  expect(rule(map, '.a').used).toBe(true);
});

const PAGE = `<!doctype html><html><head>
  <link rel="stylesheet" href="/assets/app.css?v=3">
  <style>
    .inline-used { color: rgb(1, 2, 3); }
    .inline-unused { color: rgb(4, 5, 6); }
  </style>
</head><body>
  <main>
    <a class="link" href="#docs">Docs</a>
    <span class="badge">ok</span>
    <p class="inline-used">inline</p>
  </main>
  <script>
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('.constructed-used { color: rgb(7, 8, 9); } .constructed-unused { color: rgb(9, 8, 7); }');
    document.adoptedStyleSheets = [sheet];
    const p = document.createElement('p');
    p.className = 'constructed-used';
    p.textContent = 'constructed';
    document.querySelector('main').append(p);
  </script>
</body></html>`;

const APP_CSS = `
:root { --warn: rgb(245, 158, 11); }
.link { color: rgb(37, 99, 235); }
.link:hover { color: rgb(124, 58, 237); }
.badge { color: var(--warn); animation: pulse 2s paused; }
.panel--fault .indicator { color: rgb(245, 158, 11); }
@media (min-width: 1440px) { .badge { padding: 20px; } }
@media (prefers-color-scheme: dark) { .badge { background: rgb(17, 24, 39); } }
@keyframes pulse { to { opacity: 0.5; } }`;

async function serve(html = PAGE) {
  let sheetPending = false;
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (
      req.method === 'GET' &&
      pathname === '/' &&
      req.headers['sec-fetch-mode'] === 'navigate' &&
      req.headers['sec-fetch-dest'] === 'document'
    ) {
      sheetPending = true;
    }
    const css = pathname === '/assets/app.css';
    // Only the page's load gets the sheet: inspector re-fetches must fail, so a
    // tracker armed after navigation cannot recover text it failed to record.
    const sheetAvailable = css && sheetPending;
    if (css) sheetPending = false;
    res.writeHead(css && !sheetAvailable ? 404 : 200, {
      'content-type': css ? 'text/css' : 'text/html',
      'cache-control': 'no-store',
    });
    res.end(css ? (sheetAvailable ? APP_CSS : '') : html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

let site: Awaited<ReturnType<typeof serve>>;

test.beforeEach(async () => {
  site = await serve();
});

test.afterEach(() => {
  site.close();
});

async function open(page: Page, url: string): Promise<ServedRuleTracker> {
  await page.setViewportSize({ width: 900, height: 700 });
  const servedRules = await trackServedRules(page);
  await page.goto(url, { waitUntil: 'load' });
  return servedRules;
}

const rule = (map: StyleMap, key: string): ServedRule => {
  const found = map.reach?.rules.find((r) => r.key === key);
  expect(found, `ledger has ${key}`).toBeTruthy();
  return found as ServedRule;
};

test('captureReach records which served rules matched, forced states included', async ({ page }) => {
  const servedRules = await open(page, site.url);
  const map = await captureStyleMap(page, { stabilize: false, captureReach: true, servedRules });
  expect(map.reach?.scope).toBe('compared');

  // Matched at rest, matched only under the forced :hover, and never matched.
  expect(rule(map, '.link').used).toBe(true);
  expect(rule(map, '.link:hover').used).toBe(true);
  expect(rule(map, '.panel--fault .indicator').used).toBeUndefined();
  // A media query the capture's viewport and colour scheme never satisfy.
  expect(rule(map, '@media (min-width: 1440px) > .badge').used).toBeUndefined();
  expect(rule(map, '@media (prefers-color-scheme: dark) > .badge').used).toBeUndefined();
  // Rule usage never reports @keyframes; the referencing rule carries its name instead.
  expect(rule(map, '@keyframes pulse').used).toBeUndefined();
  expect(rule(map, '.badge').refs).toContain('pulse');
  expect(rule(map, '.badge').uses).toEqual(['--warn']);
  expect(Object.keys(rule(map, ':root').vars ?? {})).toEqual(['--warn']);

  // Inline <style> and a constructed stylesheet both enter the ledger.
  expect(rule(map, '.inline-used').used).toBe(true);
  expect(rule(map, '.inline-unused').used).toBeUndefined();
  expect(rule(map, '.constructed-used').used).toBe(true);
  expect(rule(map, '.constructed-unused').used).toBeUndefined();

  // Sheet labels drop the origin and query; StyleProof's own freeze sheet stays out.
  const sheets = map.reach?.sheets ?? [];
  expect(sheets).toEqual(expect.arrayContaining(['/assets/app.css', 'inline', 'constructed']));
  expect(map.reach?.rules.some((r) => r.key.startsWith('*,*::before'))).toBe(false);
  expect(map.reach?.unreadable).toBeUndefined();
});

test('browser-owned shadow roots keep document-adopted constructed sheets in compared scope', async ({ page }) => {
  site.close();
  site = await serve(PAGE.replace('<main>', '<main><input aria-label="search">'));
  const servedRules = await open(page, site.url);
  const map = await captureStyleMap(page, { stabilize: false, captureReach: true, servedRules });
  expect(map.reach?.scope).toBe('compared');
  expect(rule(map, '.constructed-used').used).toBe(true);
});

test('the ledger is stable across captures and never changes the diff', async ({ page }) => {
  const servedRules = await open(page, site.url);
  const first = await captureStyleMap(page, { stabilize: false, captureReach: true, servedRules });
  await page.reload({ waitUntil: 'load' });
  const again = await captureStyleMap(page, { stabilize: false, captureReach: true, servedRules });
  expect(again.reach).toEqual(first.reach);

  await page.reload({ waitUntil: 'load' });
  const plain = await captureStyleMap(page, { stabilize: false });
  expect(plain.reach).toBeUndefined();
  expect(diffStyleMaps(plain, first)).toEqual([]);
  expect(diffStyleMaps(first, plain)).toEqual([]);
});

test('a tracker armed after load counts linked stylesheets unreadable instead of dropping them', async ({ page }) => {
  const early = await open(page, site.url);
  await early.dispose();
  await page.reload({ waitUntil: 'load' });
  // Reload consumes the sheet; the fixture rejects every inspector re-fetch.
  // No caller-armed tracker: captureReach arms one now, after app.css has loaded.
  const map = await captureStyleMap(page, { stabilize: false, captureReach: true });
  expect(map.reach?.unreadable).toBe(1);
  expect(map.reach?.sheets).not.toContain('/assets/app.css');
  expect(rule(map, '.inline-used').used).toBe(true);
  expect(rule(map, '.constructed-used').used).toBe(true);
});

test('defineStyleMapCapture surfaces arm the tracker before go(), so the linked stylesheet is read', async ({
  page,
}) => {
  const servedRules = await open(page, site.url); // this test's own tracker is not used
  await servedRules.dispose();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-served-rules-'));
  try {
    const outDir = path.join(root, 'out');
    // selfCheck re-runs go() and captures again on the same tracker.
    const settings = resolveSettings({
      dir: outDir,
      captureReach: true,
      selfCheck: true,
      screenshots: false,
      freezeClock: false,
    });
    const surface = { key: 'home', go: (p: Page) => p.goto(site.url, { waitUntil: 'load' }) };
    await captureSurface(page, surface, 900, settings, { index: 1, total: 1 });
    const map = loadStyleMap(path.join(outDir, 'home@900.json.gz'));
    expect(map.reach?.unreadable).toBeUndefined();
    expect(map.reach?.sheets).toContain('/assets/app.css');
    expect(rule(map, '.link:hover').used).toBe(true);
    expect(rule(map, '.panel--fault .indicator').used).toBeUndefined();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('captureReach stays off unless asked for', async ({ page }) => {
  await open(page, site.url);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-served-rules-off-'));
  try {
    const outDir = path.join(root, 'out');
    const settings = resolveSettings({ dir: outDir, selfCheck: false, screenshots: false, freezeClock: false });
    expect(settings.captureReach).toBe(false);
    const surface = { key: 'home', go: (p: Page) => p.goto(site.url, { waitUntil: 'load' }) };
    await captureSurface(page, surface, 900, settings, { index: 1, total: 1 });
    expect(loadStyleMap(path.join(outDir, 'home@900.json.gz')).reach).toBeUndefined();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('linked custom-property fonts resolve candidate families', async ({ page }) => {
  await page.route('**/font-vars.css', (route) =>
    route.fulfill({
      contentType: 'text/css',
      body: ':root{--brand:"Brand Sans",serif}body{font-family:var(--brand)}.b{font:700 15px var(--brand)}@font-face{font-family:"Brand Sans";src:local(Arial)}',
    }),
  );
  await page.route('**/font-vars.html', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<link rel="stylesheet" href="/font-vars.css"><p class="b">text</p>',
    }),
  );
  const servedRules = await open(page, new URL('/font-vars.html', site.url).href);
  const map = await captureStyleMap(page, { captureReach: true, servedRules });
  for (const key of ['body', '.b']) expect(rule(map, key).refs).toContain('Brand Sans');
});

test('CSS and JS registration initial values resolve font families', async ({ page }) => {
  const servedRules = await trackServedRules(page);
  await page.setContent(
    '<style>@PROPERTY --f { syntax:"*"; inherits:true; initial-value:"Brand Sans"; } p { font-family:var(--f); } .j { font-family:var(--js); }</style><p>text</p><p class="j">text</p>',
  );
  await page.evaluate(() =>
    CSS.registerProperty({ name: '--js', syntax: '*', inherits: true, initialValue: '"JS Face"' }),
  );
  const map = await captureStyleMap(page, { captureReach: true, servedRules });
  expect(rule(map, 'p').refs).toContain('Brand Sans');
  expect(rule(map, '.j').refs).toContain('JS Face');
});

test('pin Chromium parsed inline shorthand and decoded custom names', async ({ page }) => {
  await page.setContent('<p id="p"></p>');
  const parsed = await page.evaluate(() => {
    const style = document.querySelector<HTMLElement>('#p')!.style;
    style.cssText = String.raw`font:700 15px var(--f);\2d\2d brand:Other;--plain:Brand`;
    return {
      names: Array.from(style),
      family: style.getPropertyValue('font-family'),
      font: style.getPropertyValue('font'),
    };
  });
  expect(parsed.family).toBe('');
  expect(parsed.font).toContain('var(--f)');
  expect(parsed.names).toContain('font-family');
  expect(parsed.names).toContain('--brand');
  expect(parsed.names).toContain('--plain');
});

const INLINE_FONT_SHEET = ':root{--brand:Brand}.t{font-family:var(--brand)}';
const INLINE_CASES: [string, boolean, string?][] = [
  [String.raw`font-family:v\61r(--f)`, true],
  [String.raw`\2d\2d brand:Other`, true, INLINE_FONT_SHEET],
  ['color:red\\', false],
  ['color:red\\\n', false],
  [String.raw`color:red\3b --brand:Other`, false, INLINE_FONT_SHEET],
  [String.raw`color:red\2f *hidden*/`, false],
  [String.raw`color:red\2f *hidden*/;font-family:var(--f)`, true],
  ["a:'x\n;b:'/*';" + String.raw`\2d\2d brand:Other;c:*/`, true, INLINE_FONT_SHEET],
  ["--f:Brand;a:'x\n;b:'/*';font-family:" + String.raw`v\61r(--f);c:*/`, true],
  [String.raw`font-family:'O\'Reilly'`, false],
  [String.raw`font-family:Microsoft\ YaHei`, false],
  [String.raw`width:10px\9`, false],
  [String.raw`font-family:'O\'Reilly';font-family:var(--f)`, true],
  [String.raw`font-family:Microsoft\ YaHei;font-family:var(--f)`, true],
  [String.raw`width:10px\9;font-family:var(--f)`, true],
  [String.raw`background:url(/*);\2d\2d brand:Other;c:*/)`, true, INLINE_FONT_SHEET],
  [String.raw`--f:Brand;background:url(/*);font-family:v\61r(--f);c:*/)`, true],
  ['--f:Brand;background:url(/*);font-family:var(--f);c:*/)', true],
  [String.raw`--f:Brand;background:u\72l(/*);font-family:v\61r(--f);c:*/)`, true],
  ['--f:Brand;background:url( /* );font-family:var(--f);c:*/)', true],
  [String.raw`background:url(a');x:'/*';\2d\2d brand:Other;c:*/'`, true, INLINE_FONT_SHEET],
  [String.raw`font-family:'\5FAE\8F6F\96C5\9ED1'`, false],
  ['background:url(a.png)', false],
  ['color:red;;', false],
  [';color:red', false],
  ['--f:Brand;background:url(a(b);font-family:var(--f);c:x)', true],
  ['--f:Brand;background:url(a b(c);font-family:var(--f);c:x)', true],
  [String.raw`--f:Brand;background:u\72 l(a(b);font-family:var(--f);c:x)`, true],
  ['background:url( "x.png")', false],
  [String.raw`background:url(a\ b.png)`, false],
  ['background:url(a.png);content:"it\'s url(x"', false],
  ['font:700 15px var(--f)', true],
  ['-webkit-animation-name:var(--a)', true],
];
for (const [style, rejects, css = '.t{color:red}'] of INLINE_CASES) {
  test(`Chromium parsed inline ${rejects ? 'rejects reader' : 'captures'} ${JSON.stringify(style)}`, async ({
    page,
  }) => {
    const servedRules = await trackServedRules(page);
    await page.setContent(`<style>${css}</style><p class="t">text</p>`);
    await page.locator('p').evaluate((element, value) => element.setAttribute('style', value), style);
    const capture = captureStyleMap(page, { captureReach: true, servedRules });
    if (rejects) await expect(capture).rejects.toThrow(/reach is unknown/);
    else await capture;
  });
}
test('parsed inline reader inside a closed shadow root fails closed', async ({ page }) => {
  const servedRules = await trackServedRules(page);
  await page.setContent('<div id="host"></div>');
  await page.evaluate(() => {
    document.querySelector('#host')!.attachShadow({ mode: 'closed' }).innerHTML =
      '<p style="font-family:var(--f)">text</p>';
  });
  await expect(captureStyleMap(page, { captureReach: true, servedRules })).rejects.toThrow(/reach is unknown/);
});
test('parsed SVG inline reader fails closed', async ({ page }) => {
  const servedRules = await trackServedRules(page);
  await page.setContent('<svg><text style="font-family:var(--f)">text</text></svg>');
  await expect(captureStyleMap(page, { captureReach: true, servedRules })).rejects.toThrow(/reach is unknown/);
});
test('parsed inline closure names in a same-origin iframe fail closed', async ({ page }) => {
  const servedRules = await trackServedRules(page);
  await page.setContent(`<style>${INLINE_FONT_SHEET}</style><p class="t">text</p><iframe></iframe>`);
  await page.evaluate(() => {
    document.querySelector('iframe')!.contentDocument!.body.innerHTML = '<p style="--brand:Other">text</p>';
  });
  await expect(captureStyleMap(page, { captureReach: true, servedRules })).rejects.toThrow(/reach is unknown/);
});
