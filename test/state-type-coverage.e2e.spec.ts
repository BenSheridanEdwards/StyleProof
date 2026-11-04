/* eslint-disable no-console -- capture warning assertions spy on the shared warning channel */
import { test, expect, type Page } from '@playwright/test';
import fileSystem from 'node:fs';
import path from 'node:path';
import { captureStyleMap, diffStyleMaps, loadStyleMap, type StyleMap, type MediaState } from '../dist/index.js';
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
    const captureUndeclared = async (thickness: number): Promise<StyleMap> => {
      await page.setContent(
        documentMarkup(
          `@media(prefers-color-scheme:dark){.subject{border:${thickness}px solid}}` +
            '@media print{.subject{padding:8px}}@media(forced-colors:active){.subject{margin:8px}}@media(prefers-contrast:more){.subject{gap:8px}}',
        ),
      );

      return captureStyleMap(page, { mediaWarningScope: scope });
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

test('a shared crawl page resets media before its next base navigation', async ({ page }) => {
  const directory = test.info().outputPath('reset');
  const settings = resolveSettings({ dir: directory, freezeClock: false, selfCheck: false, screenshots: false });

  const captures = expandSurfaceVariants({
    key: 'home',
    mediaStates: [{ key: 'print', media: 'print', colorScheme: 'dark', forcedColors: 'active' }],
    go: async (capturePage) => {
      await capturePage.setContent(documentMarkup(''));
    },
  });

  await captureSurface(page, captures[1], 1280, settings, { index: 1, total: 2 });
  await captureSurface(page, captures[0], 1280, settings, { index: 2, total: 2 });
  expect(
    await page.evaluate(() => [
      matchMedia('print').matches,
      matchMedia('(prefers-color-scheme:dark)').matches,
      matchMedia('(forced-colors:active)').matches,
      matchMedia('(prefers-reduced-motion:reduce)').matches,
    ]),
  ).toEqual([false, false, false, true]);
});
