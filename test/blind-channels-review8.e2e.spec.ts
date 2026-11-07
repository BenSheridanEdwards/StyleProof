import { test, expect } from '@playwright/test';
import { captureStyleMap, diffStyleMaps } from '../dist/index.js';
import { assertDeterministicVisualChannels } from '../dist/visual-channels.js';
const changes = (maps: Awaited<ReturnType<typeof captureStyleMap>>[]) =>
  diffStyleMaps(maps[0], maps[1])
    .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
    .filter((p) => p.prop.includes('keyframes'));
for (const kind of ['closed', 'declarative closed', 'finished closed'] as const)
  test(`static ${kind} sibling keeps a real document body change detectable`, async ({ page }) => {
    const maps = [];
    for (const value of [0.5, 0.6]) {
      await page.goto('about:blank');
      await page.setContent(
        `<style>@keyframes pulse{to{opacity:${value}}}.a{animation:pulse 1s linear 100s infinite paused both}</style><div class=a>x</div>${kind === 'declarative closed' ? '<x-host><template shadowrootmode="closed"><span>static</span></template></x-host>' : '<x-host></x-host>'}`,
      );
      if (kind === 'declarative closed') expect(await page.locator('x-host').innerHTML()).toBe('');
      else
        await page.locator('x-host').evaluate((host, finished) => {
          const root = host.attachShadow({ mode: 'closed' });
          root.innerHTML = finished
            ? '<style>@keyframes drive{to{opacity:.5}}span{animation:drive 1ms forwards}</style><span>x</span>'
            : '<span>static</span>';
          for (const a of root.getAnimations()) a.finish();
        }, kind === 'finished closed');
      maps.push(await captureStyleMap(page, { captureVisualChannels: true, captureStates: false }));
    }
    for (const map of maps)
      expect(Object.values(map.visualChannels!.keyframes).find((k) => k.name === 'pulse')?.status).toBe('known');
    expect(changes(maps)).toHaveLength(1);
  });
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
