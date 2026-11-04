/* eslint-disable no-console -- capture warning assertions spy on the shared warning channel */
import { test, expect, type Page } from '@playwright/test';
import fileSystem from 'node:fs';
import { tmpdir as temporaryDirectory } from 'node:os';
import path from 'node:path';
import { PNG as PortableNetworkGraphic } from 'pngjs';
import {
  captureStyleMap,
  diffStyleMaps,
  loadStyleMap,
  type StyleMap,
  type MediaState,
  defineCrawlCapture,
} from '../dist/index.js';
import { expandSurfaceVariants } from '../dist/runner.js';
import { captureSurface, detectSurfaceWidths } from '../dist/runner/surface-capture.js';
import { resolveSettings } from '../dist/runner/settings.js';

// The same tiny deterministic, inline document strategy as pr-surfacing.e2e.spec.ts.
const documentMarkup = (stylesheet: string, body = '<button class="subject">Example</button>'): string =>
  `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}.subject{display:block;width:140px;height:44px}${stylesheet}</style></head><body>${body}</body></html>`;

async function captureDocument(page: Page, stylesheet: string, body?: string): Promise<StyleMap> {
  await page.setContent(documentMarkup(stylesheet, body));

  return captureStyleMap(page);
}

for (const state of ['hover', 'focus', 'focus-visible', 'active']) {
  test(`CAUGHT :${state} as a named state finding`, async ({ page }) => {
    const base = await captureDocument(page, `.subject:${state}{background-color:rgb(210,30,40)}`);
    const head = await captureDocument(page, '');
    expect(
      diffStyleMaps(base, head).some(
        (finding) => finding.kind === 'state' && finding.state === (state === 'focus-visible' ? 'focus' : state),
      ),
    ).toBe(true);
  });
}

test('CAUGHT ancestor :focus-within through the child focus layer', async ({ page }) => {
  const body = '<section class="container"><button class="subject">Example</button></section>';
  const base = await captureDocument(page, '.container:focus-within{background-color:rgb(210,30,40)}', body);
  const head = await captureDocument(page, '', body);
  expect(
    diffStyleMaps(base, head).some(
      (finding) => finding.kind === 'state' && finding.state === 'focus' && finding.path.includes('section'),
    ),
  ).toBe(true);
});

for (const pseudo of ['before', 'after', 'placeholder', 'marker']) {
  test(`CAUGHT ::${pseudo} as a tagged style finding`, async ({ page }) => {
    const body =
      pseudo === 'placeholder'
        ? '<input class="subject" placeholder="Example">'
        : pseudo === 'marker'
          ? '<ul><li class="subject">Example</li></ul>'
          : undefined;

    const rule = pseudo === 'before' || pseudo === 'after' ? 'content:"";display:block;width:12px;height:12px;' : '';

    const base = await captureDocument(
      page,
      `${pseudo === 'marker' ? '.subject{display:list-item}' : ''}.subject::${pseudo}{${rule}color:rgb(210,30,40);background-color:rgb(210,30,40)}`,
      body,
    );

    const head = await captureDocument(
      page,
      `${pseudo === 'marker' ? '.subject{display:list-item}' : ''}.subject::${pseudo}{${rule}color:rgb(30,40,210);background-color:rgb(30,40,210)}`,
      body,
    );

    expect(
      diffStyleMaps(base, head).some((finding) => finding.kind === 'style' && finding.pseudo === `::${pseudo}`),
    ).toBe(true);
  });
}

for (const [state, body] of [
  ['checked', '<input class="subject" type="checkbox" checked>'],
  ['disabled', '<button class="subject" disabled>Example</button>'],
  ['placeholder-shown', '<input class="subject" placeholder="Example">'],
]) {
  test(`CAUGHT resting :${state} as a style finding`, async ({ page }) => {
    const base = await captureDocument(page, `.subject:${state}{outline:4px solid rgb(210,30,40)}`, body);
    const head = await captureDocument(page, `.subject:${state}{outline:8px solid rgb(30,40,210)}`, body);
    expect(
      diffStyleMaps(base, head).some(
        (finding) =>
          finding.kind === 'style' &&
          finding.pseudo === null &&
          finding.props.some((property) => property.prop === 'outline-width'),
      ),
    ).toBe(true);
  });
}

test('CAUGHT width-specific @media through breakpoint detection', async ({ page }) => {
  const stylesheet = '@media(min-width:900px){.subject{background-color:rgb(210,30,40)}}';

  const surface = expandSurfaceVariants({
    key: 'responsive',
    go: async (capturePage) => {
      await capturePage.setContent(documentMarkup(stylesheet));
    },
  })[0];

  const settings = resolveSettings({ dir: test.info().outputPath('widths'), freezeClock: false, selfCheck: false });
  const widths = await detectSurfaceWidths(page, surface, settings);
  expect(widths).toEqual([360, 900]);
  const findings = [];

  for (const width of widths) {
    await page.setViewportSize({ width, height: 800 });
    const base = await captureDocument(page, stylesheet);
    const head = await captureDocument(page, '');
    findings.push({ width, changes: diffStyleMaps(base, head) });
  }

  expect(findings.find((capture) => capture.width === 360)?.changes).toEqual([]);
  expect(findings.find((capture) => capture.width === 900)?.changes.some((finding) => finding.kind === 'style')).toBe(
    true,
  );
});

test('CAUGHT content inside an inner overflow:auto scroller below the fold', async ({ page }) => {
  const body =
    '<section style="height:80px;overflow:auto"><div style="height:1000px"></div><button class="subject">Example</button></section>';

  const base = await captureDocument(page, '.subject{background-color:rgb(210,30,40)}', body);
  const head = await captureDocument(page, '.subject{background-color:rgb(30,40,210)}', body);
  expect(diffStyleMaps(base, head).some((finding) => finding.kind === 'style' && finding.path.includes('button'))).toBe(
    true,
  );
});

const mediaDeclarations: Array<{ declaration: MediaState; condition: string }> = [
  { declaration: { key: 'dark', colorScheme: 'dark' }, condition: '(prefers-color-scheme: dark)' },
  { declaration: { key: 'print', media: 'print' }, condition: 'print' },
  { declaration: { key: 'contrast', forcedColors: 'active' }, condition: '(forced-colors: active)' },
];

for (const { declaration, condition } of mediaDeclarations) {
  test(`CAUGHT ${declaration.key} media rule with declaration; identical pages have zero findings`, async ({
    page,
  }) => {
    const directory = test.info().outputPath('captures');

    const captureMediaDocument = async (label: string, thickness: number): Promise<StyleMap> => {
      const settings = resolveSettings({
        dir: path.join(directory, label),
        freezeClock: false,
        selfCheck: true,
        captureScriptReach: declaration.media === 'print',
        mediaStates: [declaration],
      });

      const stylesheet = `@media ${condition}{.subject{border:${thickness}px solid}}`;

      const surface = expandSurfaceVariants({
        key: 'home',
        mediaStates: [declaration],
        go: async (capturePage) => {
          // Navigation-time script proves emulation was active before the document loaded.
          await capturePage.goto(
            `data:text/html,${encodeURIComponent(
              documentMarkup(stylesheet) +
                `<script>document.documentElement.dataset.mediaMatched=String(matchMedia(${JSON.stringify(condition)}).matches)</script>`,
            )}`,
          );
          expect(await capturePage.locator('html').getAttribute('data-media-matched')).toBe('true');
        },
      }).find((capture) => capture.key === `home-${declaration.key}`)!;

      const widths = await detectSurfaceWidths(page, surface, settings);
      expect(widths).toEqual([1280]);
      await captureSurface(page, surface, widths[0], settings, { index: 1, total: 1 });
      expect(await page.evaluate((query) => matchMedia(query).matches, condition)).toBe(true);
      expect(fileSystem.existsSync(path.join(settings.outDir, `home-${declaration.key}@1280.png`))).toBe(true);

      return loadStyleMap(path.join(settings.outDir, `home-${declaration.key}@1280.json.gz`));
    };

    const base = await captureMediaDocument('base', 2);
    const head = await captureMediaDocument('head', 7);
    const identical = await captureMediaDocument('identical', 7);
    expect(base.metadata?.mediaState).toEqual(declaration);
    expect(head.metadata?.variantKey).toBe(declaration.key);
    expect(
      diffStyleMaps(base, head).some(
        (finding) =>
          finding.kind === 'style' &&
          finding.pseudo === null &&
          finding.props.some((property) => property.prop === 'border-top-width'),
      ),
    ).toBe(true);
    expect(diffStyleMaps(head, identical)).toEqual([]);

    const screenshotPixel = (label: string): number[] => {
      const picture = PortableNetworkGraphic.sync.read(
        fileSystem.readFileSync(path.join(directory, label, `home-${declaration.key}@1280.png`)),
      );

      // This point is inside the 2px border and on the 7px border, away from rounded corners.
      const offset = (4 * picture.width + 20) * 4;

      return Array.from(picture.data.subarray(offset, offset + 4));
    };

    expect(screenshotPixel('head'), 'the media-only border change must reach the screenshot').not.toEqual(
      screenshotPixel('base'),
    );
    await test.info().attach(`${declaration.key} base`, {
      path: path.join(directory, 'base', `home-${declaration.key}@1280.png`),
      contentType: 'image/png',
    });
    await test.info().attach(`${declaration.key} head`, {
      path: path.join(directory, 'head', `home-${declaration.key}@1280.png`),
      contentType: 'image/png',
    });
  });
}

test('dark-only change is NOT CAUGHT without mediaStates; warning fires once and names detected features', async ({
  page,
}) => {
  const warnings: string[] = [];
  const originalWarning = console.warn;
  console.warn = (message: string) => warnings.push(message);
  const scope = test.info().outputPath('undeclared');

  try {
    await captureDocument(page, '@media(prefers-color-scheme:dark){.subject{border:2px solid}}');
    expect(warnings).toEqual([]);
    const captureUndeclared = async (thickness: number): Promise<StyleMap> => {
      await page.setContent(
        documentMarkup(
          `@media(prefers-color-scheme:dark){.subject{border:${thickness}px solid}}` +
            '@media print{.subject{padding:8px}}@media(forced-colors:active){.subject{margin:8px}}@media(prefers-contrast:more){.subject{gap:8px}}',
        ),
      );

      const settings = resolveSettings({ dir: scope, freezeClock: false, selfCheck: false, screenshots: false });
      await captureSurface(page, { key: 'home', go: async () => {} }, 1280, settings, { index: 1, total: 1 });
      return loadStyleMap(path.join(scope, 'home@1280.json.gz'));
    };

    const base = await captureUndeclared(2);
    const head = await captureUndeclared(7);
    expect(diffStyleMaps(base, head)).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/prefers-color-scheme, print, forced-colors, prefers-contrast.*mediaStates/);
  } finally {
    console.warn = originalWarning;
  }
});

test('a print copy preserves a dark browser context and restores it before the next base navigation', async ({
  browser,
}) => {
  const context = await browser.newContext({ colorScheme: 'dark' });
  const page = await context.newPage();
  try {
    const directory = test.info().outputPath('reset');
    const settings = resolveSettings({ dir: directory, freezeClock: false, selfCheck: false, screenshots: false });

    const captures = expandSurfaceVariants({
      key: 'home',
      mediaStates: [{ key: 'print', media: 'print' }],
      go: async (capturePage) => {
        await capturePage.setContent(documentMarkup(''));
      },
    });

    await captureSurface(page, captures[1], 1280, settings, { index: 1, total: 2 });
    expect(
      await page.evaluate(() => [matchMedia('print').matches, matchMedia('(prefers-color-scheme:dark)').matches]),
    ).toEqual([true, true]);
    await captureSurface(page, captures[0], 1280, settings, { index: 2, total: 2 });
    expect(
      await page.evaluate(() => [
        matchMedia('print').matches,
        matchMedia('(prefers-color-scheme:dark)').matches,
        matchMedia('(forced-colors:active)').matches,
        matchMedia('(prefers-reduced-motion:reduce)').matches,
      ]),
    ).toEqual([false, true, false, true]);
  } finally {
    await context.close();
  }
});

test('an explicit variant receives its media copy before setup and keeps its variant state', async ({ page }) => {
  const directory = test.info().outputPath('variant');
  const settings = resolveSettings({ dir: directory, freezeClock: false, selfCheck: false, screenshots: false });
  const capture = expandSurfaceVariants({
    key: 'home',
    mediaStates: [{ key: 'dark', colorScheme: 'dark' }],
    go: async (capturePage) => {
      await capturePage.setContent(documentMarkup('@media(prefers-color-scheme:dark){.subject{border:7px solid}}'));
    },
    variants: [
      {
        key: 'open',
        setup: async (capturePage) => {
          expect(await capturePage.evaluate(() => matchMedia('(prefers-color-scheme:dark)').matches)).toBe(true);
        },
        go: async (capturePage) => {
          await capturePage.locator('button').evaluate((element) => element.setAttribute('data-open', 'true'));
        },
      },
    ],
  }).find((surface) => surface.key === 'home-open-dark')!;
  await captureSurface(page, capture, 1280, settings, { index: 1, total: 1 });
  const map = loadStyleMap(path.join(directory, 'home-open-dark@1280.json.gz'));
  expect(map.metadata?.variantKey).toBe('open-dark');
  expect(map.metadata?.mediaState).toEqual({ key: 'dark', colorScheme: 'dark' });
  expect(await page.locator('button').getAttribute('data-open')).toBe('true');
  expect(await page.locator('button').evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe('7px');
});

const crawlDirectory = fileSystem.mkdtempSync(path.join(temporaryDirectory(), 'styleproof-media-crawl-'));
test.describe.serial('declared crawl media', () => {
  test.use({ colorScheme: 'dark', baseURL: 'http://media-crawl.test' });
  test.beforeEach(async ({ page }) => {
    await page.route('http://media-crawl.test/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: documentMarkup(
          '@media print{.subject{border:7px solid}}@media(prefers-color-scheme:dark){.subject{padding:9px}}',
          '<nav><a href="/alpha">Example</a></nav><button class="subject">Example</button>',
        ),
      }),
    );
  });
  defineCrawlCapture({
    from: 'http://media-crawl.test/',
    match: '/alpha',
    dir: crawlDirectory,
    widths: [800],
    mediaStates: [{ key: 'print', media: 'print' }],
    screenshots: false,
    selfCheck: false,
    freezeClock: false,
    observeNavigation: false,
  });
  test('crawl emits base and print maps with dark context styles', () => {
    const base = loadStyleMap(path.join(crawlDirectory, 'alpha@800.json.gz'));
    const print = loadStyleMap(path.join(crawlDirectory, 'alpha-print@800.json.gz'));
    expect(print.metadata?.mediaState).toEqual({ key: 'print', media: 'print' });
    expect(
      diffStyleMaps(base, print).some(
        (finding) => finding.kind === 'style' && finding.props.some((property) => property.prop === 'border-top-width'),
      ),
    ).toBe(true);
    for (const map of [base, print]) {
      const button = Object.entries(map.elements).find(([elementPath]) => elementPath.includes('button'))?.[1];
      expect(button?.style['padding-top']).toBe('9px');
    }
  });
});
test.afterAll(() => fileSystem.rmSync(crawlDirectory, { recursive: true, force: true }));
