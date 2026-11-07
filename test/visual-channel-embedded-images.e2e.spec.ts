import { test, expect, type Page } from '@playwright/test';
import { captureStyleMap } from '../dist/capture.js';
import { diffStyleMaps } from '../dist/diff.js';
import { assertDeterministicVisualChannels } from '../dist/visual-channels.js';
import fs from 'node:fs';
import { generateStyleMapReport } from '../dist/index.js';
import { pairFixture, rmTmp } from './helpers.mjs';

// Fixture blocks isolate helper state; the test bodies and matrices are unchanged.
{
  const changes = (maps: Awaited<ReturnType<typeof captureStyleMap>>[]) =>
    diffStyleMaps(maps[0], maps[1])
      .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
      .filter((p) => p.prop.includes('keyframes'));

  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="10"><animate attributeName="width" values="100;500" dur="2s" repeatCount="indefinite"/></svg>';

  const css =
    '<style>section{display:flex;width:800px}object,embed,img{flex:none}.ct{flex:1;min-width:0;container-type:inline-size}@keyframes pulse{from{margin-left:1cqw}to{margin-left:20cqw}}.a{animation:pulse 1s linear 100s infinite paused both}</style>';

  for (const stabilize of [true, false])
    test(`readable embedded SVG motion is unknown with stabilize=${stabilize}`, async ({ page }) => {
      await page.route('http://fixture.test/**', (route) =>
        route.fulfill({
          contentType: route.request().url().endsWith('.svg') ? 'image/svg+xml' : 'text/html',
          body: route.request().url().endsWith('.svg') ? svg : '<html></html>',
        }),
      );
      const maps = [];
      for (const time of [0.1, 0.9]) {
        await page.goto('http://fixture.test/');
        await page.setContent(
          css +
            '<section><div class=ct><div class=a>x</div></div><object type="image/svg+xml" data="/motion.svg"></object></section>',
        );
        await page.waitForFunction(
          () => !!(document.querySelector('object') as HTMLObjectElement).contentDocument?.documentElement,
        );
        await page.evaluate((t) => {
          const s = (document.querySelector('object') as HTMLObjectElement).contentDocument!
            .documentElement as unknown as SVGSVGElement;
          s.pauseAnimations();
          s.setCurrentTime(t);
        }, time);
        maps.push(await captureStyleMap(page, { captureVisualChannels: true, captureStates: false, stabilize }));
      }
      for (const map of maps)
        expect(Object.values(map.visualChannels!.keyframes).find((k) => k.name === 'pulse')?.status).toBe('unknown');
      expect(changes(maps)).toEqual([]);
      expect(() => assertDeterministicVisualChannels(maps[0], maps[1], 'embedded SVG')).not.toThrow();
    });

  for (const tag of ['object', 'embed', 'img'] as const)
    test(`opaque ${tag} SVG cannot supply a sampled keyframes body`, async ({ page }) => {
      const maps = [];
      for (const delay of [100, 1100]) {
        await page.goto('about:blank');
        const url = 'data:image/svg+xml,' + encodeURIComponent(svg);
        await page.setContent(
          css +
            `<section><div class=ct><div class=a>x</div></div><${tag} ${tag === 'object' ? 'data' : 'src'}="${url}"></${tag}></section>`,
        );
        await page.waitForTimeout(delay);
        maps.push(await captureStyleMap(page, { captureVisualChannels: true, captureStates: false, stabilize: false }));
      }
      for (const map of maps)
        expect(Object.values(map.visualChannels!.keyframes).find((k) => k.name === 'pulse')?.status).toBe('unknown');
      expect(changes(maps)).toEqual([]);
      expect(() => assertDeterministicVisualChannels(maps[0], maps[1], 'opaque SVG')).not.toThrow();
    });

  test('1,000 explicitly sized SVG icons keep document models comparable', async ({ page }) => {
    const maps = [];
    const url = 'data:image/svg+xml,' + encodeURIComponent(svg);
    for (const value of [0.5, 0.6]) {
      await page.goto('about:blank');
      await page.setContent(
        `<style>@keyframes pulse{to{opacity:${value}}}.a{animation:pulse 1s linear 100s infinite paused both}</style><div class=a>x</div>` +
          `<img width="16" height="16" src="${url}">`.repeat(1000),
      );
      maps.push(await captureStyleMap(page, { captureVisualChannels: true, captureStates: false }));
    }
    expect(changes(maps)).toHaveLength(1);
    for (const map of maps)
      expect(Object.values(map.visualChannels!.keyframes).find((k) => k.name === 'pulse')?.status).toBe('known');
  });
}

{
  const raster = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  const changes = (maps: Awaited<ReturnType<typeof captureStyleMap>>[]) =>
    diffStyleMaps(maps[0], maps[1])
      .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
      .filter((p) => p.prop.includes('keyframes'));

  for (const attrs of [
    '',
    'style="width:100%"',
    'width=120',
    'loading=lazy style="margin-top:3000px"',
    'width=120 height=80',
  ])
    test(`default raster image retains known models and detects edits: ${attrs || 'unsized'}`, async ({ page }) => {
      await page.route('http://media.test/**', (route) =>
        route.fulfill({
          contentType: route.request().url().endsWith('.png') ? 'image/png' : 'text/html',
          body: route.request().url().endsWith('.png') ? Buffer.from(raster, 'base64') : '<html></html>',
        }),
      );
      const maps = [];
      for (const opacity of ['.5', '.6']) {
        await page.goto('http://media.test/');
        await page.setContent(
          `<style>@keyframes k{to{opacity:${opacity}}}.k{animation:k 1s linear 100s paused both}</style><div class=k>x</div><div style="width:300px"><img src=/photo.png ${attrs}></div>`,
        );
        if (!attrs.includes('lazy')) await page.locator('img').evaluate((img) => (img as HTMLImageElement).decode());
        maps.push(await captureStyleMap(page, { captureVisualChannels: true, captureStates: false }));
      }
      for (const map of maps)
        expect(Object.values(map.visualChannels!.keyframes).find((k) => k.name === 'k')?.status).toBe('known');
      expect(changes(maps)).toHaveLength(1);
    });

  for (const kind of ['content', 'input', 'poster'])
    test(`unstabilized SVG ${kind} source holds models`, async ({ page }) => {
      await page.route('http://media.test/**', (route) =>
        route.fulfill({
          contentType: route.request().url().endsWith('.svg') ? 'image/svg+xml' : 'text/html',
          body: route.request().url().endsWith('.svg')
            ? '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="10"><animate attributeName="width" values="100;500" dur="2s" repeatCount="indefinite"/></svg>'
            : '<html></html>',
        }),
      );
      await page.goto('http://media.test/');
      await page.setContent(
        `<style>@keyframes k{to{opacity:.5}}.k{animation:k 1s linear 100s paused both}.m::before{content:url(/input.svg)}</style><div class=k>x</div>${kind === 'content' ? '<span class=m></span>' : kind === 'input' ? '<input type=image src=/input.svg>' : '<video poster=/input.svg></video>'}`,
      );
      await page.waitForLoadState('networkidle');
      const map = await captureStyleMap(page, { captureVisualChannels: true, captureStates: false, stabilize: false });
      expect(Object.values(map.visualChannels!.keyframes).find((k) => k.name === 'k')?.status).toBe('unknown');
    });
}

{
  // Canonical/source comparisons use settling; unstabilized relative models have document-wide limits.
  const options = { captureVisualChannels: true, captureStates: false };

  async function capture(page: Page, html: string) {
    await page.setContent(html);
    return captureStyleMap(page, options);
  }

  const changes = (a: Awaited<ReturnType<typeof capture>>, b: Awaited<ReturnType<typeof capture>>) =>
    diffStyleMaps(a, b).flatMap((finding) => (finding.kind === 'dom' ? [] : finding.props));

  function report(before: Awaited<ReturnType<typeof capture>>, after: Awaited<ReturnType<typeof capture>>) {
    const fixture = pairFixture({ surface: 'home@800', before, after });
    try {
      return fs.readFileSync(generateStyleMapReport(fixture).reportMdPath, 'utf8');
    } finally {
      rmTmp(fixture.root);
    }
  }

  const image = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>';

  async function imageRoutes(page: Page) {
    await page.route('http://**/*', (route) => route.fulfill({ contentType: 'image/svg+xml', body: image }));
  }

  const sourceOf = (map: Awaited<ReturnType<typeof capture>>) =>
    Object.values(map.elements).find((element) => element.tag === 'img')!.style['img currentSrc'];

  test('identical blob images are stable skipped evidence without exposing per-run URLs', async ({ page }) => {
    const html = `<img width="10" height="10"><script>document.querySelector('img').src=URL.createObjectURL(new Blob([${JSON.stringify(image)}],{type:'image/svg+xml'}))</script>`;
    const before = await capture(page, html);
    const after = await capture(page, html);
    expect(sourceOf(before)).toBe('(blob URL; not compared)');
    expect(sourceOf(after)).toBe('(blob URL; not compared)');
    expect(changes(before, after)).toEqual([]);
    expect(() => assertDeterministicVisualChannels(before, after, 'home')).not.toThrow();
    expect(JSON.stringify(before)).not.toMatch(/blob:/);
    expect(report(before, after)).toContain('not compared (blob URL)');
  });

  test('loaded image to complete no-source is compared; unloaded lazy image remains skipped', async ({ page }) => {
    await imageRoutes(page);
    const before = await capture(page, '<img width="10" height="10" src="http://assets.test/a.svg">');
    const after = await capture(page, '<img width="10" height="10">');
    expect(await page.locator('img').evaluate((element) => element.complete)).toBe(true);
    expect(sourceOf(after)).toBe('(no source)');
    expect(changes(before, after)).toContainEqual({
      prop: 'img currentSrc',
      before: 'http://assets.test/a.svg',
      after: '(no source)',
    });
    expect(report(before, after)).not.toContain('unloaded image');
    const lazy = await capture(
      page,
      '<img loading="lazy" style="position:absolute;top:99999px" width="10" height="10" src="http://assets.test/lazy.svg">',
    );
    expect(sourceOf(lazy)).toBe('');
    expect(changes(before, lazy).map((property) => property.prop)).not.toContain('img currentSrc');
    expect(report(before, lazy)).toContain('not compared (unloaded image)');
  });

  test('a complete image with no selected source stays compared when srcset has no valid candidate', async ({
    page,
  }) => {
    await imageRoutes(page);
    const before = await capture(page, '<img width="10" height="10" src="http://assets.test/a.svg">');
    const after = await capture(page, '<img width="10" height="10" srcset=",">');
    expect(
      await page.locator('img').evaluate((element) => ({ complete: element.complete, source: element.currentSrc })),
    ).toEqual({ complete: true, source: '' });
    expect(sourceOf(after)).toBe('(no source)');
    expect(changes(before, after).map((property) => property.prop)).toContain('img currentSrc');
    expect(report(before, after)).not.toContain('unloaded image');
  });
}

{
  // Canonical/source comparisons use settling; unstabilized relative models have document-wide limits.
  const options = { captureVisualChannels: true, captureStates: false };

  async function capture(page: Page, html: string, settings = options) {
    await page.setContent(html);
    return captureStyleMap(page, settings);
  }

  const props = (before: Awaited<ReturnType<typeof capture>>, after: Awaited<ReturnType<typeof capture>>) =>
    diffStyleMaps(before, after).flatMap((finding) => (finding.kind === 'dom' ? [] : finding.props));

  test('img swaps, data hashes, picture/srcset and empty lazy currentSrc are captured', async ({ page }) => {
    const image = (color: string) =>
      `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="${color}"/></svg>`)}`;
    const markup = (color: string) =>
      `<!doctype html><picture><source srcset="${image(color)}"><img class="target" width="10" height="10"></picture><img class="lazy" loading="lazy" style="position:absolute;top:99999px" src="http://lazy.test/lazy.png">`;
    await page.route('**/lazy.png', (route) => route.abort());
    const before = await capture(page, markup('blue'));
    const after = await capture(page, markup('red'));
    expect(props(before, after).map((p) => p.prop)).toContain('img currentSrc');
    const img = Object.values(after.elements).find((entry) => entry.cls === 'target')!;
    expect(img.style['img currentSrc']).toMatch(/^data:sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(after)).not.toContain('data:image/svg+xml');
    expect(Object.values(after.elements).find((entry) => entry.cls === 'lazy')!.style['img currentSrc']).toBe('');
    expect(await page.locator('img.lazy').evaluate((element) => element.complete)).toBe(false);
  });
}
