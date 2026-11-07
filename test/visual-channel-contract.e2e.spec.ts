import { test, expect, type Page } from '@playwright/test';
import { captureStyleMap } from '../dist/capture.js';
import { diffStyleMaps } from '../dist/diff.js';

// Fixture blocks isolate helper state; the test bodies and matrices are unchanged.
{
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
}

{
  // Canonical/source comparisons use settling; unstabilized relative models have document-wide limits.
  const options = { captureVisualChannels: true, captureStates: false };

  const animation = (body: string, extra = '') => `<!doctype html><style>
  @keyframes pulse { ${body} }
  .target { animation: pulse 10s infinite; width: 10px; height: 10px; }
  ${extra}
  </style><div class="target"></div>`;

  async function capture(page: Page, html: string, settings = options) {
    await page.setContent(html);
    return captureStyleMap(page, settings);
  }

  const props = (before: Awaited<ReturnType<typeof capture>>, after: Awaited<ReturnType<typeof capture>>) =>
    diffStyleMaps(before, after).flatMap((finding) => (finding.kind === 'dom' ? [] : finding.props));

  test('keyframes body changes surface with the same animation-name; default captures remain unchanged', async ({
    page,
  }) => {
    const before = await capture(page, animation('from { opacity: 0; } to { opacity: 1; }'));
    const after = await capture(page, animation('from { opacity: 0; } to { opacity: .5; }'));
    expect(props(before, after).map((p) => p.prop)).toContain('animation keyframes (pulse)');
    expect(props(before, after).map((p) => p.prop)).not.toContain('animation-name');
    const legacyBefore = await capture(page, animation('to { opacity: 1; }'), {
      ...options,
      captureVisualChannels: false,
    });
    const legacyAfter = await capture(page, animation('to { opacity: .5; }'), {
      ...options,
      captureVisualChannels: false,
    });
    expect(diffStyleMaps(legacyBefore, legacyAfter)).toEqual([]);
    expect(diffStyleMaps(legacyBefore, after)).toEqual([]);
  });
}
