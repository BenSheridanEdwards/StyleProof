import { test, expect, type Page } from '@playwright/test';
import { captureStyleMap, diffStyleMaps } from '../dist/index.js';
import { assertDeterministicVisualChannels } from '../dist/visual-channels.js';
const unstable = { captureVisualChannels: true, captureStates: false, stabilize: false };
const light =
  '<style>@keyframes pulse{from{margin-left:1cqw}to{margin-left:20cqw}}section{display:flex;width:800px}.p{flex:1;min-width:0;container-type:inline-size}.a{animation:pulse 1s linear 100s infinite paused both}</style>';
const kf = (a: Awaited<ReturnType<typeof captureStyleMap>>, b: typeof a) =>
  diffStyleMaps(a, b)
    .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
    .filter((p) => p.prop.includes('keyframes'));
for (const [name, mode, kind, nested, status] of [
  ['open width', 'open', 'width', false, 'unknown'],
  ['open font', 'open', 'font', false, 'unknown'],
  ['nested open', 'open', 'width', true, 'unknown'],
  ['closed width', 'closed', 'width', false, 'unknown'],
  ['closed static', 'closed', 'static', false, 'unknown'],
  ['static open control', 'open', 'static', false, 'known'],
  ['unreadable open', 'open', 'unreadable', false, 'unknown'],
] as const)
  test(`${name}: shadow liveness is conservative without tainting readable static roots`, async ({ page }) => {
    const maps = [];
    for (const time of [0, 900]) {
      await page.goto('about:blank');
      await page.setContent(light + '<section><div class=p><div class=a>x</div></div><x-host></x-host></section>');
      await page.evaluate(
        ({ time, mode, kind, nested }) => {
          let root = document.querySelector('x-host')!.attachShadow({ mode });
          if (nested) {
            root.innerHTML = '<x-inner></x-inner>';
            root = root.querySelector('x-inner')!.attachShadow({ mode: 'open' });
          }
          const property = kind === 'font' ? 'font-size' : 'width';
          root.innerHTML = `<style>@keyframes drive{from{${property}:100px}to{${property}:500px}}.g{height:10px;${kind === 'static' || kind === 'unreadable' ? 'width:300px' : 'animation:drive 1s linear infinite paused'}}</style><div class=g>t</div>`;
          for (const a of root.getAnimations()) {
            a.pause();
            a.currentTime = time;
          }
          if (kind === 'unreadable')
            root.getAnimations = () => {
              throw new Error('unreadable shadow animation list');
            };
        },
        { time, mode, kind, nested },
      );
      maps.push(await captureStyleMap(page, unstable));
    }
    for (const map of maps)
      expect(Object.values(map.visualChannels!.keyframes).find((k) => k.name === 'pulse')?.status).toBe(status);
    expect(kf(maps[0], maps[1])).toEqual([]);
    expect(() => assertDeterministicVisualChannels(maps[0], maps[1], name)).not.toThrow();
  });
for (const kind of ['width', 'font', 'static', 'set'] as const)
  test(`SVG ${kind}: active SMIL is held, inactive or plain SVG stays known`, async ({ page }) => {
    const maps = [];
    for (const time of [0, 0.9]) {
      await page.goto('about:blank');
      const markup =
        kind === 'font'
          ? '<style>@keyframes pulse{from{stroke-width:.1em}to{stroke-width:.5em}}text{animation:pulse 1s linear 100s infinite paused both}</style><svg width="300" height="100"><g font-size="10"><animate attributeName="font-size" values="10;40" dur="1s" repeatCount="indefinite"/><text x="0" y="50">t</text></g></svg>'
          : light +
            `<section><div class=p><div class=a>x</div></div><svg width="300" height="10">${kind === 'width' ? '<animate attributeName="width" values="100;500" dur="1s" repeatCount="indefinite"/>' : kind === 'set' ? '<set attributeName="width" to="500" begin="indefinite"/>' : ''}</svg></section>`;
      await page.setContent(markup);
      await page.evaluate((t) => {
        const svg = document.querySelector('svg')!;
        svg.pauseAnimations();
        svg.setCurrentTime(t);
      }, time);
      maps.push(await captureStyleMap(page, unstable));
    }
    for (const map of maps)
      expect(Object.values(map.visualChannels!.keyframes).find((k) => k.name === 'pulse')?.status).toBe(
        kind === 'static' || kind === 'set' ? 'known' : 'unknown',
      );
    expect(kf(maps[0], maps[1])).toEqual([]);
    expect(() => assertDeterministicVisualChannels(maps[0], maps[1], kind)).not.toThrow();
  });
async function motionPair(page: Page, channels: boolean) {
  const maps = [];
  for (const [name, duration] of [
    ['spin', '1s'],
    ['wobble', '3s'],
  ]) {
    await page.goto('about:blank');
    await page.setContent(
      `<style>@keyframes ${name}{to{opacity:.5}}.a{animation:${name} ${duration} infinite;transition:color ${duration}}</style><div class=a>x</div>`,
    );
    maps.push(await captureStyleMap(page, { captureVisualChannels: channels, captureStates: false }));
  }
  return maps;
}
for (const failure of ['session', 'protocol'] as const)
  test(`CDP ${failure} failure preserves all existing motion findings`, async ({ page }) => {
    const context = page.context(),
      native = context.newCDPSession.bind(context);
    context.newCDPSession = async (...args) => {
      if (failure === 'session') throw new Error('CDP unavailable');
      const client = await native(...args);
      client.send = async () => {
        throw new Error('protocol unavailable');
      };
      return client;
    };
    try {
      const off = await motionPair(page, false),
        on = await motionPair(page, true);
      const props = (maps: typeof off) =>
        diffStyleMaps(maps[0], maps[1])
          .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
          .map((p) => p.prop)
          .sort();
      expect(props(off)).toEqual(['animation-name', 'transition-duration']);
      expect(props(on)).toEqual(props(off));
      for (const map of on)
        expect(Object.values(map.visualChannels!.keyframes).every((k) => k.status === 'unknown')).toBe(true);
    } finally {
      context.newCDPSession = native;
    }
  });

for (const mode of ['open', 'closed'] as const)
  for (const stabilize of [true, false])
    test(`QA finished light consumer: ${mode} shadow motion holds bodies with stabilize=${stabilize}`, async ({
      page,
    }) => {
      const maps = [];
      for (const time of [100, 900]) {
        await page.goto('about:blank');
        await page.setContent(
          light.replace('pulse 1s linear 100s infinite paused both', 'pulse 1ms forwards') +
            '<section><x-host></x-host><div class=p><div class=a>x</div></div></section>',
        );
        await page.evaluate(
          ({ mode, time }) => {
            for (const a of document.getAnimations()) a.finish();
            const root = document.querySelector('x-host')!.attachShadow({ mode });
            root.innerHTML =
              '<style>@keyframes drive{from{width:100px}to{width:500px}}div{animation:drive 1s linear infinite paused}</style><div>x</div>';
            root.getAnimations()[0].currentTime = time;
          },
          { mode, time },
        );
        maps.push(await captureStyleMap(page, { captureVisualChannels: true, captureStates: false, stabilize }));
      }
      for (const map of maps)
        expect(Object.values(map.visualChannels!.keyframes).find((k) => k.name === 'pulse')?.status).toBe('unknown');
      expect(kf(maps[0], maps[1])).toEqual([]);
      expect(() => assertDeterministicVisualChannels(maps[0], maps[1], 'QA shadow')).not.toThrow();
    });
