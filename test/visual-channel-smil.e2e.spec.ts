import { test, expect } from '@playwright/test';
import { captureStyleMap } from '../dist/capture.js';
import { diffStyleMaps } from '../dist/diff.js';
import { assertDeterministicVisualChannels } from '../dist/visual-channels.js';

// Fixture blocks isolate helper state; the test bodies and matrices are unchanged.
{
  const unstable = { captureVisualChannels: true, captureStates: false, stabilize: false };

  const light =
    '<style>@keyframes pulse{from{margin-left:1cqw}to{margin-left:20cqw}}section{display:flex;width:800px}.p{flex:1;min-width:0;container-type:inline-size}.a{animation:pulse 1s linear 100s infinite paused both}</style>';

  const kf = (a: Awaited<ReturnType<typeof captureStyleMap>>, b: typeof a) =>
    diffStyleMaps(a, b)
      .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
      .filter((p) => p.prop.includes('keyframes'));

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
}

{
  const kf = (maps: Awaited<ReturnType<typeof captureStyleMap>>[]) =>
    diffStyleMaps(maps[0], maps[1])
      .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
      .filter((p) => p.prop.includes('keyframes'));

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
}
