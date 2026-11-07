import { test, expect } from '@playwright/test';
import { captureStyleMap, diffStyleMaps } from '../dist/index.js';
import { assertDeterministicVisualChannels } from '../dist/visual-channels.js';

for (const mode of ['open', 'closed'] as const)
  test(`100ms ${mode} web-component row replacement stays deterministic and detects 20 hover edits`, async ({
    page,
  }) => {
    const maps = [];
    for (const opacity of ['.5', '.5', '.6']) {
      await page.goto('about:blank');
      await page.setContent(
        `<style>@keyframes k{to{opacity:${opacity}}}@keyframes hk{to{opacity:${opacity}}}.k{animation:k 1s linear 100s infinite paused both}button:hover{animation:hk 1s linear 100s infinite paused both}#clock{position:absolute;right:0;top:0}</style><div id=clock></div><div class=k>k</div>${'<button>x</button>'.repeat(20)}`,
      );
      await page.evaluate((mode) => {
        const name = `x-row-${mode}`;
        if (!customElements.get(name))
          customElements.define(
            name,
            class extends HTMLElement {
              constructor() {
                super();
                this.attachShadow({ mode }).innerHTML = '<b>row</b>';
              }
            },
          );
        const clock = document.querySelector('#clock')!;
        clock.replaceChildren(document.createElement(name));
        setInterval(() => clock.replaceChildren(document.createElement(name)), 100);
      }, mode);
      maps.push(await captureStyleMap(page, { captureVisualChannels: true }));
    }
    expect(() => assertDeterministicVisualChannels(maps[0], maps[1], 'component rows')).not.toThrow();
    expect(
      diffStyleMaps(maps[0], maps[1])
        .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
        .filter((p) => p.prop.includes('keyframes')),
    ).toHaveLength(0);
    const edits = diffStyleMaps(maps[1], maps[2]).flatMap((f) => (f.kind === 'dom' ? [] : f.props));
    expect(edits.filter((p) => p.prop === 'animation keyframes (hk)')).toHaveLength(20);
    expect(edits.filter((p) => p.prop === 'animation keyframes (k)')).toHaveLength(1);
  });

test('one failed resting boundary proof keeps all later state evidence unknown', async ({ page }) => {
  const context = page.context(),
    native = context.newCDPSession.bind(context);
  let failed = false;
  context.newCDPSession = async (...args) => {
    const client = await native(...args),
      send = client.send.bind(client);
    client.send = async (method, params) => {
      if (!failed && method === 'DOM.getDocument' && (params as { depth?: number })?.depth === -1) {
        failed = true;
        throw new Error('deliberate one-read boundary failure');
      }
      return send(method, params);
    };
    return client;
  };
  try {
    await page.setContent(
      '<style>@keyframes k{to{opacity:.5}}.k{animation:k 1s linear 100s paused both}button:hover{animation:k 1s linear 100s paused both}</style><div class=k>x</div><button>x</button>',
    );
    const map = await captureStyleMap(page, { captureVisualChannels: true });
    expect(failed).toBe(true);
    expect(Object.values(map.visualChannels!.keyframes).every((model) => model.status === 'unknown')).toBe(true);
  } finally {
    context.newCDPSession = native;
  }
});

test('a static closed root with an unsized known raster preserves a real body edit', async ({ page }) => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  await page.route('http://media.test/**', (route) =>
    route.fulfill({
      contentType: route.request().url().endsWith('.png') ? 'image/png' : 'text/html',
      body: route.request().url().endsWith('.png') ? png : '<html></html>',
    }),
  );
  const maps = [];
  for (const opacity of ['.5', '.6']) {
    await page.goto('http://media.test/');
    await page.setContent(
      `<style>@keyframes k{to{opacity:${opacity}}}.k{animation:k 1s linear 100s paused both}</style><div class=k>x</div><x-icon></x-icon>`,
    );
    await page.evaluate(() => {
      document.querySelector('x-icon')!.attachShadow({ mode: 'closed' }).innerHTML = '<img src="/pixel.png">';
    });
    await page.waitForLoadState('networkidle');
    maps.push(await captureStyleMap(page, { captureVisualChannels: true, captureStates: false }));
  }
  expect(Object.values(maps[0].visualChannels!.keyframes).every((m) => m.status === 'known')).toBe(true);
  expect(
    diffStyleMaps(maps[0], maps[1])
      .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
      .filter((p) => p.prop.includes('keyframes')),
  ).toHaveLength(1);
});
