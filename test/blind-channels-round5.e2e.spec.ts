import { test, expect } from '@playwright/test';
import { captureStyleMap, diffStyleMaps } from '../dist/index.js';
import { assertDeterministicVisualChannels } from '../dist/visual-channels.js';
const options = { captureVisualChannels: true, captureStates: false, stabilize: false };
const cases = [
  [
    'em-parent',
    '@keyframes drive{from{font-size:10px}to{font-size:30px}}@keyframes pulse{to{margin-left:2em}}.p{animation:drive 1s linear infinite paused}.a{animation:pulse 1s linear infinite paused}',
    false,
  ],
  [
    'em-self',
    '@keyframes drive{from{font-size:10px}to{font-size:30px}}@keyframes pulse{to{margin-left:2em}}.a{animation:drive 1s linear infinite paused,pulse 1s linear infinite paused}',
    false,
  ],
  [
    'currentColor-parent',
    '@keyframes drive{from{color:red}to{color:blue}}@keyframes pulse{to{outline:2px solid currentColor}}.p{animation:drive 1s linear infinite paused}.a{animation:pulse 1s linear infinite paused}',
    false,
  ],
  [
    'color-explicit',
    '@keyframes drive{from{color:red}to{color:blue}}@keyframes pulse{from{border-color:currentColor}to{border-color:currentColor}}.a{animation:drive 1s linear infinite paused,pulse 1s linear infinite paused}',
    false,
  ],
  [
    'paused-transition',
    '@keyframes pulse{to{margin-left:2em}}.p{font-size:10px;transition:font-size 1s linear}.p.on{font-size:30px}.a{animation:pulse 1s linear infinite paused}',
    true,
  ],
] as const;
for (const [label, css, transition] of cases)
  test(`${label} holds sampled context unknown`, async ({ page }) => {
    const maps = [];
    for (const time of [100, 900]) {
      await page.goto('about:blank');
      await page.setContent(`<style>${css}</style><div class=p><div class=a>x</div></div>`);
      await page.evaluate(
        ({ time, transition }) => {
          const p = document.querySelector('.p')!;
          if (transition) {
            void getComputedStyle(p).fontSize;
            p.classList.add('on');
            void getComputedStyle(p).fontSize;
            if (!document.getAnimations().some((a) => a instanceof CSSTransition))
              throw new Error('fixture must create a live font-size transition');
          }
          for (const a of document.getAnimations()) {
            a.pause();
            a.currentTime = time;
          }
        },
        { time, transition },
      );
      maps.push(await captureStyleMap(page, options));
    }
    for (const map of maps)
      expect(Object.values(map.visualChannels!.keyframes).find((k) => k.name === 'pulse')?.status).toBe('unknown');
    expect(() => assertDeterministicVisualChannels(maps[0], maps[1], label)).not.toThrow();
    expect(
      diffStyleMaps(maps[0], maps[1])
        .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
        .filter((p) => p.prop === 'animation keyframes (pulse)'),
    ).toEqual([]);
  });
for (const pseudo of ['before', 'after', 'marker'])
  for (const important of [false, true])
    test(`${pseudo} custom-property input is unknown (important=${important})`, async ({ page }) => {
      const maps = [];
      for (const time of [0, 900]) {
        const rule = `.a::${pseudo}{content:'x';animation:custom 1s linear infinite paused,pulse 1s linear infinite paused${important ? '!important' : ''}}`;
        await page.setContent(
          `<style>@property --x{syntax:'<length>';inherits:true;initial-value:0px}@keyframes custom{from{--x:10px}to{--x:20px}}@keyframes pulse{to{margin-left:var(--x)}}${important ? '@layer locked{' + rule + '}' : rule}</style><ul><li class=a>x</li></ul>`,
        );
        await page.evaluate((time) => {
          for (const a of document.getAnimations()) {
            a.pause();
            a.currentTime = time;
          }
        }, time);
        maps.push(await captureStyleMap(page, options));
      }
      for (const map of maps)
        expect(Object.values(map.visualChannels!.keyframes).find((k) => k.name === 'pulse')?.status).toBe('unknown');
      expect(() => assertDeterministicVisualChannels(maps[0], maps[1], pseudo)).not.toThrow();
    });
for (const stabilize of [false, true])
  for (const property of ['color', 'font-size'])
    test(`running ${property} transition is clean with stabilize=${stabilize}`, async ({ page }) => {
      const maps = [];
      for (const delay of [100, 900]) {
        const style =
          property === 'color'
            ? '@keyframes pulse{to{outline:2px solid currentColor}}.p{color:red;transition:color 3s linear}.p.dark{color:blue}'
            : '@keyframes pulse{to{margin-left:2em}}.p{font-size:10px;transition:font-size 3s linear}.p.dark{font-size:30px}';
        await page.goto('about:blank');
        await page.setContent(
          `<style>${style}.a{animation:pulse 1s linear infinite}</style><div class=p><div class=a>x</div></div>`,
        );
        await page.evaluate((property) => {
          const p = document.querySelector('.p')!;
          void getComputedStyle(p).getPropertyValue(property);
          p.classList.add('dark');
          void getComputedStyle(p).getPropertyValue(property);
          if (!document.getAnimations().some((a) => a instanceof CSSTransition))
            throw new Error('fixture must create a live transition');
        }, property);
        await page.waitForTimeout(delay);
        maps.push(await captureStyleMap(page, { ...options, stabilize }));
      }
      expect(
        diffStyleMaps(maps[0], maps[1])
          .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
          .filter((p) => p.prop === 'animation keyframes (pulse)'),
      ).toEqual([]);
      expect(() => assertDeterministicVisualChannels(maps[0], maps[1], 'theme')).not.toThrow();
      if (!stabilize)
        for (const map of maps)
          expect(Object.values(map.visualChannels!.keyframes).find((k) => k.name === 'pulse')?.status).toBe('unknown');
    });
test('stabilized relative and fixed explicit bodies remain compared', async ({ page }) => {
  for (const [a, b] of [
    ['2em', '3em'],
    ['20px', '30px'],
  ]) {
    const maps = [];
    for (const value of [a, b]) {
      await page.setContent(
        `<style>@keyframes pulse{from{margin-left:0px}to{margin-left:${value}}}.a{animation:pulse 1s infinite paused}</style><div class=a>x</div>`,
      );
      maps.push(await captureStyleMap(page, { ...options, stabilize: true }));
    }
    expect(
      diffStyleMaps(maps[0], maps[1])
        .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
        .some((p) => p.prop === 'animation keyframes (pulse)'),
    ).toBe(true);
  }
});
