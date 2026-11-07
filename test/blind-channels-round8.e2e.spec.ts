import { test, expect } from '@playwright/test';
import { captureStyleMap, diffStyleMaps } from '../dist/index.js';
import { assertDeterministicVisualChannels } from '../dist/visual-channels.js';
import { assertBrowserLinearScaling } from './browser-linearity-helper.mjs';
const kf = (maps: Awaited<ReturnType<typeof captureStyleMap>>[]) =>
  diffStyleMaps(maps[0], maps[1])
    .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
    .filter((p) => p.prop.includes('keyframes'));
for (const mode of ['closed', 'open'] as const)
  for (const stabilize of [true, false])
    test(`late ${mode} shadow root is revalidated for forced states; stabilize=${stabilize}`, async ({ page }) => {
      const maps = [];
      for (const time of [100, 900]) {
        await page.goto('about:blank');
        await page.setContent(
          `<style>body{margin:0}section{display:flex;width:800px}x-drive{display:block;flex:none}.ct{flex:1;min-width:0;container-type:inline-size}@keyframes pulse{from{margin-left:1cqw}to{margin-left:20cqw}}button:hover .a{animation:pulse 1s linear 100s infinite paused both}</style><section><x-drive></x-drive><div class=ct><button><span class=a>x</span></button></div></section>`,
        );
        await page.evaluate(
          ({ mode, time }) => {
            new MutationObserver(() => {
              if (
                !document.querySelector('[data-styleproof-state-id]') ||
                document.querySelector('x-drive')!.hasAttribute('attached')
              )
                return;
              const host = document.querySelector('x-drive')!;
              host.setAttribute('attached', '');
              const root = host.attachShadow({ mode });
              root.innerHTML =
                '<style>@keyframes drive{from{width:100px}to{width:500px}}div{animation:drive 1s linear infinite paused}</style><div>x</div>';
              root.getAnimations()[0].currentTime = time;
            }).observe(document.documentElement, {
              subtree: true,
              attributes: true,
              attributeFilter: ['data-styleproof-state-id'],
            });
          },
          { mode, time },
        );
        maps.push(await captureStyleMap(page, { captureVisualChannels: true, stabilize }));
      }
      for (const map of maps)
        expect(
          Object.values(map.visualChannels!.keyframes)
            .filter((k) => k.name === 'pulse')
            .map((k) => k.status),
        ).toEqual(['unknown']);
      expect(kf(maps)).toEqual([]);
      expect(() => assertDeterministicVisualChannels(maps[0], maps[1], 'late root')).not.toThrow();
    });
for (const stabilize of [true, false])
  for (const [name, attrs, time, status] of [
    ['finished freeze', 'dur=".02s" fill="freeze"', 2, 'known'],
    ['never started', 'dur="1s" begin="indefinite"', 2, 'known'],
    ['active paused timeline', 'dur="1s"', 0.5, 'unknown'],
    ['indefinite repeats', 'dur="1s" repeatCount="indefinite"', 3, 'unknown'],
    ['finished repeat count', 'dur="1s" repeatCount="2" fill="freeze"', 3, 'known'],
    ['finished repeat duration', 'dur="1s" repeatDur="2s" fill="freeze"', 3, 'known'],
    ['finished explicit end', 'dur="1s" repeatCount="indefinite" end="2s" fill="freeze"', 3, 'known'],
  ] as const)
    test(`SMIL ${name}: ${status} evidence retains real CSS body edits; stabilize=${stabilize}`, async ({ page }) => {
      const maps = [];
      for (const value of [2, 3]) {
        await page.goto('about:blank');
        await page.setContent(
          `<style>@keyframes pulse{from{margin-left:1em}to{margin-left:${value}em}}.a{font-size:16px;animation:pulse ${stabilize ? '1s infinite' : '1ms forwards'}}</style><div class=a>x</div><svg width="10" height="10"><animate attributeName="width" from="10" to="20" ${attrs}/></svg>`,
        );
        await page.evaluate((t) => {
          const svg = document.querySelector('svg')!;
          svg.pauseAnimations();
          svg.setCurrentTime(t);
        }, time);
        if (!stabilize)
          await page.evaluate(() => {
            for (const a of document.getAnimations()) a.finish();
          });
        maps.push(await captureStyleMap(page, { captureVisualChannels: true, captureStates: false, stabilize }));
      }
      for (const map of maps)
        expect(Object.values(map.visualChannels!.keyframes).find((k) => k.name === 'pulse')?.status).toBe(status);
      expect(kf(maps)).toHaveLength(status === 'known' ? 1 : 0);
    });
for (const mode of ['open', 'closed'] as const)
  test(`complete capture scales with ${mode} author hosts using warmed minimum CPU samples`, async ({ page }, info) => {
    const client = await page.context().newCDPSession(page);
    try {
      await assertBrowserLinearScaling(
        {
          diagnostic: (message: string) => {
            info.annotations.push({ type: 'cpu', description: message });
          },
        },
        {
          client,
          name: 'complete visual-channel capture with shadow hosts',
          n: 50,
          prepare: async (n: number) => {
            await page.goto('about:blank');
            await page.setContent(
              '<style>@keyframes pulse{to{opacity:.5}}button:hover span{animation:pulse 1s infinite}</style><button><span>x</span></button><main></main>',
            );
            await page.evaluate(
              ({ n, mode }) => {
                for (let i = 0; i < n; i++) {
                  const host = document.createElement('x-host');
                  host.attachShadow({ mode }).innerHTML = '<span>x</span>';
                  document.querySelector('main')!.append(host);
                }
              },
              { n, mode },
            );
          },
          run: () => captureStyleMap(page, { captureVisualChannels: true }),
          check: (map: Awaited<ReturnType<typeof captureStyleMap>>) =>
            expect(
              Object.values(map.visualChannels!.keyframes).some((k) => k.name === 'pulse' && k.status === 'known'),
            ).toBe(true),
        },
      );
    } finally {
      await client.detach();
    }
  });
