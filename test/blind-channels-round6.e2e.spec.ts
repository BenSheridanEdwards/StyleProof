import { test, expect } from '@playwright/test';
import { captureStyleMap, diffStyleMaps } from '../dist/index.js';
import { assertDeterministicVisualChannels } from '../dist/visual-channels.js';
const cases = [
  [
    'self-em',
    '@keyframes pulse{from{font-size:10px;margin-left:2em}to{font-size:30px;margin-left:2em}}.a{animation:pulse 1s linear infinite paused}',
    '<div class=a>x</div>',
  ],
  [
    'self-currentcolor',
    '@keyframes pulse{from{color:red;border-color:currentColor}to{color:blue;border-color:currentColor}}.a{animation:pulse 1s linear infinite paused}',
    '<div class=a>x</div>',
  ],
  [
    'sibling-cqw',
    'section{display:flex;width:800px}.p{flex:1;min-width:0;container-type:inline-size}.s{flex:none;animation:drive 1s linear infinite paused}@keyframes drive{from{width:100px}to{width:500px}}@keyframes pulse{from{margin-left:1cqw}to{margin-left:20cqw}}.a{animation:pulse 1s linear infinite paused}',
    '<section><div class=s>s</div><div class=p><div class=a>x</div></div></section>',
  ],
] as const;
for (const [name, css, body] of cases)
  test(`${name} has no progress-dependent known body`, async ({ page }) => {
    const maps = [];
    for (const time of [0, 900]) {
      await page.goto('about:blank');
      await page.setContent(`<style>${css}</style>${body}`);
      await page.evaluate((time) => {
        for (const a of document.getAnimations()) {
          a.pause();
          a.currentTime = time;
        }
      }, time);
      maps.push(await captureStyleMap(page, { captureVisualChannels: true, captureStates: false, stabilize: false }));
    }
    for (const map of maps)
      expect(Object.values(map.visualChannels!.keyframes).find((k) => k.name === 'pulse')?.status).toBe('unknown');
    expect(() => assertDeterministicVisualChannels(maps[0], maps[1], name)).not.toThrow();
    expect(
      diffStyleMaps(maps[0], maps[1])
        .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
        .filter((p) => p.prop.includes('keyframes')),
    ).toEqual([]);
  });
for (const stabilize of [true, false])
  test(`nothing in progress: em, currentColor and var stay known with stabilize=${stabilize}`, async ({ page }) => {
    for (const body of [
      (v: number) => `from{margin-left:1em}to{margin-left:${v}em}`,
      (v: number) =>
        `from{border-color:currentColor;border-width:1px}to{border-color:currentColor;border-width:${v}px}`,
      (v: number) => `from{margin-left:var(--distance)}to{margin-left:calc(var(--distance)*${v})}`,
    ]) {
      const maps = [];
      for (const version of [2, 3]) {
        await page.goto('about:blank');
        await page.setContent(
          `<style>:root{--distance:12px}.a{font-size:16px;color:blue;animation:pulse 1ms forwards}@keyframes pulse{${body(version)}}</style><div class=a>x</div>`,
        );
        await page.evaluate(() => {
          for (const a of document.getAnimations()) a.finish();
        });
        expect(
          await page.evaluate(() => document.getAnimations().some((a) => ['running', 'paused'].includes(a.playState))),
        ).toBe(false);
        const map = await captureStyleMap(page, { captureVisualChannels: true, captureStates: false, stabilize });
        expect(Object.values(map.visualChannels!.keyframes).find((k) => k.name === 'pulse')?.status).toBe('known');
        maps.push(map);
      }
      expect(
        diffStyleMaps(maps[0], maps[1])
          .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
          .some((p) => p.prop === 'animation keyframes (pulse)'),
      ).toBe(true);
    }
  });

test('unstabilized live motion holds even absolute and implicit-colour bodies unknown', async ({ page }) => {
  await page.setContent(
    '<style>@keyframes pixels{from{margin-left:0px}to{margin-left:20px}}@keyframes colour{to{text-shadow:0 0 3px}}.a{animation:pixels 1s infinite paused}.b{animation:colour 1s infinite paused}</style><div class=a>x</div><div class=b>y</div>',
  );
  const map = await captureStyleMap(page, { captureVisualChannels: true, captureStates: false, stabilize: false });
  expect(Object.values(map.visualChannels!.keyframes).map((k) => k.status)).toEqual(['unknown', 'unknown']);
});
test('finished entrance wrapper preserves all four Tailwind body changes in default mode', async ({ page }) => {
  const maps = [];
  for (const v of [360, 350]) {
    await page.goto('about:blank');
    await page.setContent(
      `<style>@keyframes spin{to{transform:rotate(${v}deg)}}@keyframes ping{75%,100%{transform:scale(${v / 180});opacity:0}}@keyframes pulse{50%{opacity:${v / 720}}}@keyframes bounce{0%,100%{transform:translateY(-${v / 15}%);animation-timing-function:cubic-bezier(.8,0,1,1)}50%{transform:none;animation-timing-function:cubic-bezier(0,0,.2,1)}}@keyframes enter{from{opacity:0}to{opacity:1}}.page{animation:enter .1s both}.spin{animation:spin 1s linear infinite}.ping{animation:ping 1s infinite}.pulse{animation:pulse 2s infinite}.bounce{animation:bounce 1s infinite}</style><div class=page><div class=spin>s</div><div class=ping>p</div><div class=pulse>u</div><div class=bounce>b</div></div>`,
    );
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => document.querySelector('.page')!.getAnimations()[0].playState)).toBe('finished');
    maps.push(await captureStyleMap(page, { captureVisualChannels: true, captureStates: false }));
  }
  for (const map of maps)
    expect(Object.values(map.visualChannels!.keyframes).every((k) => k.status === 'known')).toBe(true);
  const changes = diffStyleMaps(maps[0], maps[1])
    .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
    .filter((p) => p.prop.includes('keyframes') && !p.prop.includes('enter'));
  expect(changes).toHaveLength(4);
});

test('a genuinely surviving inline-important CSS effect stays unknown in default mode', async ({ page }) => {
  const maps = [];
  for (const time of [0, 900]) {
    await page.goto('about:blank');
    await page.setContent(
      '<style>@keyframes pulse{from{font-size:10px;margin-left:2em}to{font-size:30px;margin-left:2em}}</style><div style="animation:pulse 1s linear infinite paused!important">x</div>',
    );
    await page.evaluate((time) => {
      for (const a of document.getAnimations()) a.currentTime = time;
    }, time);
    maps.push(await captureStyleMap(page, { captureVisualChannels: true, captureStates: false }));
  }
  for (const map of maps)
    expect(Object.values(map.visualChannels!.keyframes).every((k) => k.status === 'unknown')).toBe(true);
  expect(() => assertDeterministicVisualChannels(maps[0], maps[1], 'surviving CSS')).not.toThrow();
});
