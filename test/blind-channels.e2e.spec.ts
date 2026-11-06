import { test, expect, type Page } from '@playwright/test';
import { captureStyleMap, diffStyleMaps } from '../dist/index.js';

const options = { captureVisualChannels: true, captureStates: false, stabilize: false };
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

test('inactive media/supports and losing cascade layers cannot replace the winning keyframes', async ({ page }) => {
  const before = await capture(page, animation('to { opacity: 1; }'));
  const after = await capture(
    page,
    animation(
      'to { opacity: 1; }',
      `
    @media (min-width: 99999px) { @keyframes pulse { to { opacity: .2; } } }
    @supports (not-a-property: bogus) { @keyframes pulse { to { opacity: .3; } } }
    @layer last { @keyframes pulse { to { opacity: .4; } } }
  `,
    ),
  );
  expect(props(before, after)).toEqual([]);
  const layered = (body: string) =>
    animation(
      '',
      `@layer first, last;
    @layer last { @keyframes pulse { to { opacity: 1; } } }
    @layer first { @keyframes pulse { to { opacity: ${body}; } } }`,
    ).replace('@keyframes pulse {  }', '');
  expect(props(await capture(page, layered('.1')), await capture(page, layered('.2')))).toEqual([]);
});

test('keyframe selectors and declaration order normalise; bodies are shared and captures byte-identical', async ({
  page,
}) => {
  const before = await capture(page, animation('from { opacity: 0; color: red; } to { opacity: 1; }'));
  const after = await capture(page, animation('0% { color: red; opacity: 0; } 100% { opacity: 1; }'));
  expect(props(before, after)).toEqual([]);
  const again = await capture(page, animation('0% { color: red; opacity: 0; } 100% { opacity: 1; }'));
  expect(JSON.stringify(after)).toEqual(JSON.stringify(again));
  const many = await capture(page, animation('to { opacity: 1; }') + '<div class="target"></div>'.repeat(300));
  expect(Object.keys(many.visualChannels!.keyframes)).toHaveLength(1);
  expect(JSON.stringify(many.visualChannels).length).toBeLessThan(500);
});

test('img swaps, data hashes, picture/srcset and empty lazy currentSrc are captured', async ({ page }) => {
  const image = (color: string) =>
    `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="${color}"/></svg>`)}`;
  const markup = (color: string) =>
    `<!doctype html><picture><source srcset="${image(color)}"><img class="target" width="10" height="10"></picture><img class="lazy" loading="lazy" style="position:absolute;top:99999px" src="/lazy.png">`;
  await page.route('**/lazy.png', (route) => route.abort());
  const before = await capture(page, markup('blue'));
  const after = await capture(page, markup('red'));
  expect(props(before, after).map((p) => p.prop)).toContain('img currentSrc');
  const img = Object.values(after.elements).find((entry) => entry.cls === 'target')!;
  expect(img.style['img currentSrc']).toMatch(/^data:sha256:[0-9a-f]{64}$/);
  expect(JSON.stringify(after)).not.toContain('data:image/svg+xml');
  expect(Object.values(after.elements).find((entry) => entry.cls === 'lazy')!.style['img currentSrc']).toBe('');
});

test('pseudo-elements and forced-state references report their own keyframes body', async ({ page }) => {
  const markup = (opacity: string) => `<!doctype html><style>
    @keyframes rest { to { opacity: 1; } }
    @keyframes pulse { to { opacity: ${opacity}; } }
    button::before { content: 'x'; animation: rest 10s infinite; }
    button:hover::before { animation-name: pulse; }
  </style><button class="target">Go</button>`;
  const before = await capture(page, markup('1'), { ...options, captureStates: true });
  const after = await capture(page, markup('.2'), { ...options, captureStates: true });
  expect(
    diffStyleMaps(before, after).some(
      (finding) =>
        finding.kind === 'state' &&
        finding.state === 'hover' &&
        finding.props.some((p) => p.prop === 'animation keyframes (pulse)'),
    ),
  ).toBe(true);
});
