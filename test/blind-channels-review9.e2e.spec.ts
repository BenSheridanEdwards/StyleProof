import { test, expect } from '@playwright/test';
import { captureStyleMap, diffStyleMaps } from '../dist/index.js';
import { assertDeterministicVisualChannels } from '../dist/visual-channels.js';
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
test('text and inert list churn during every forced proof stays deterministic and detects 20/20 hover edits', async ({
  page,
}) => {
  const context = page.context(),
    native = context.newCDPSession.bind(context);
  let n = 0;
  context.newCDPSession = async (...args) => {
    const client = await native(...args),
      send = client.send.bind(client);
    client.send = async (method, params) => {
      if (
        method === 'Runtime.evaluate' &&
        (params as { expression?: string })?.expression?.includes('window.__spChannelRequests()')
      )
        await page.evaluate((n) => {
          const clock = document.querySelector('#clock')!;
          clock.textContent = String(n);
          const i = document.createElement('i');
          clock.append(i);
          i.remove();
        }, ++n);
      return send(method, params);
    };
    return client;
  };
  const maps = [];
  try {
    for (const opacity of ['.5', '.5', '.6']) {
      await page.goto('about:blank');
      await page.setContent(
        `<style>#clock{position:absolute;width:100px;height:20px}button:hover{animation:hk 1s linear 100s paused both}@keyframes hk{to{opacity:${opacity}}}</style><div id=clock>0</div>` +
          '<button>x</button>'.repeat(20),
      );
      maps.push(await captureStyleMap(page, { captureVisualChannels: true, captureText: false }));
    }
    expect(() => assertDeterministicVisualChannels(maps[0], maps[1], 'churn')).not.toThrow();
    expect(changes([maps[1], maps[2]])).toHaveLength(20);
    expect(Object.values(maps[2].visualChannels!.keyframes).every((k) => k.status === 'known')).toBe(true);
  } finally {
    context.newCDPSession = native;
  }
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

for (const stabilize of [false, true])
  test(`a new inert subtree subscribes before it gains a closed-root child; stabilize=${stabilize}`, async ({
    page,
  }) => {
    const context = page.context(),
      native = context.newCDPSession.bind(context);
    let inserted = false;
    context.newCDPSession = async (...args) => {
      const client = await native(...args),
        send = client.send.bind(client);
      client.send = async (method, params) => {
        if (
          !inserted &&
          method === 'Runtime.evaluate' &&
          (params as { expression?: string })?.expression?.includes('window.__spChannelRequests()')
        ) {
          inserted = true;
          await page.evaluate(() => document.querySelector('#target')!.append(document.createElement('i')));
          await send('Runtime.evaluate', { expression: '0' });
          await page.evaluate(() => {
            const host = document.createElement('x-late');
            const root = host.attachShadow({ mode: 'closed' });
            root.innerHTML =
              '<style>@keyframes drive{to{width:500px}}div{animation:drive 1s linear infinite paused}</style><div>x</div>';
            document.querySelector('i')!.append(host);
            root.getAnimations()[0].currentTime = 500;
          });
          await send('Runtime.evaluate', { expression: '0' });
        }
        return send(method, params);
      };
      return client;
    };
    try {
      await page.setContent(
        '<style>@keyframes k{to{opacity:.5}}.k{animation:k 1s linear 100s paused both}</style><div class=k>x</div><main id=target></main>',
      );
      const map = await captureStyleMap(page, { captureVisualChannels: true, captureStates: false, stabilize });
      expect(inserted).toBe(true);
      expect(Object.values(map.visualChannels!.keyframes).find((k) => k.name === 'k')?.status).toBe('unknown');
    } finally {
      context.newCDPSession = native;
    }
  });
