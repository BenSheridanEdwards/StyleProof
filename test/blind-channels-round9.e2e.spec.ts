import { test, expect } from '@playwright/test';
import { captureStyleMap, diffStyleMaps } from '../dist/index.js';
import { assertDeterministicVisualChannels } from '../dist/visual-channels.js';

for (const mode of ['open', 'closed'] as const)
  for (const stabilize of [false, true])
    test(`${mode} root finishing during freeze retains entry motion only without stabilization=${stabilize}`, async ({
      page,
    }) => {
      const maps = [];
      for (const time of [100, 900]) {
        await page.goto('about:blank');
        await page.setContent(
          '<style>@keyframes pulse{from{margin-left:10px}to{margin-left:20px}}.a{animation:pulse 1s linear 100s paused both}</style><div class=a>x</div><x-drive></x-drive>',
        );
        const driver = await page.evaluateHandle(
          ({ mode, time }) => {
            const root = document.querySelector('x-drive')!.attachShadow({ mode });
            root.innerHTML =
              '<style>@keyframes d{from{width:100px}to{width:500px}}div{animation:d 1s linear paused both}</style><div>x</div>';
            const driver = root.getAnimations()[0];
            driver.currentTime = time;
            return driver;
          },
          { mode, time },
        );
        let finish: Promise<unknown> | undefined;
        maps.push(
          await captureStyleMap(page, {
            captureVisualChannels: true,
            captureStates: false,
            stabilize,
            onPhase(phase) {
              if (phase === 'settle')
                finish = driver.evaluate((a) => {
                  a.finish();
                  return a.playState;
                });
            },
          }),
        );
        expect(await finish).toBe('finished');
        await driver.dispose();
      }
      for (const map of maps)
        expect(Object.values(map.visualChannels!.keyframes).find((k) => k.name === 'pulse')?.status).toBe(
          stabilize ? 'known' : 'unknown',
        );
      expect(
        diffStyleMaps(maps[0], maps[1])
          .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
          .filter((p) => p.prop.includes('keyframes')),
      ).toEqual([]);
      expect(() => assertDeterministicVisualChannels(maps[0], maps[1], 'entry motion')).not.toThrow();
    });

for (const entry of ['static', 'finished'] as const)
  test(`closed root ${entry} at entry keeps unstabilized models known and detects edits`, async ({ page }) => {
    const maps = [];
    for (const endpoint of [20, 30]) {
      await page.goto('about:blank');
      await page.setContent(
        `<style>@keyframes pulse{from{margin-left:10px}to{margin-left:${endpoint}px}}.a{animation:pulse 1s linear 100s paused both}</style><div class=a>x</div><x-drive></x-drive>`,
      );
      await page.evaluate((entry) => {
        const root = document.querySelector('x-drive')!.attachShadow({ mode: 'closed' });
        root.innerHTML =
          entry === 'static'
            ? '<div>x</div>'
            : '<style>@keyframes d{to{width:500px}}div{animation:d 1s paused both}</style><div>x</div>';
        for (const animation of root.getAnimations()) animation.finish();
      }, entry);
      maps.push(await captureStyleMap(page, { captureVisualChannels: true, captureStates: false, stabilize: false }));
    }
    for (const map of maps)
      expect(Object.values(map.visualChannels!.keyframes).find((k) => k.name === 'pulse')?.status).toBe('known');
    expect(
      diffStyleMaps(maps[0], maps[1])
        .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
        .filter((p) => p.prop.includes('keyframes')),
    ).toHaveLength(1);
  });
