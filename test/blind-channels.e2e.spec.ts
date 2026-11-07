import { test, expect, type Page } from '@playwright/test';
import { captureStyleMap, diffStyleMaps } from '../dist/index.js';
import { assertDeterministicVisualChannels } from '../dist/visual-channels.js';

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
    `<!doctype html><picture><source srcset="${image(color)}"><img class="target" width="10" height="10"></picture><img class="lazy" loading="lazy" style="position:absolute;top:99999px" src="http://lazy.test/lazy.png">`;
  await page.route('**/lazy.png', (route) => route.abort());
  const before = await capture(page, markup('blue'));
  const after = await capture(page, markup('red'));
  expect(props(before, after).map((p) => p.prop)).toContain('img currentSrc');
  const img = Object.values(after.elements).find((entry) => entry.cls === 'target')!;
  expect(img.style['img currentSrc']).toMatch(/^data:sha256:[0-9a-f]{64}$/);
  expect(JSON.stringify(after)).not.toContain('data:image/svg+xml');
  expect(Object.values(after.elements).find((entry) => entry.cls === 'lazy')!.style['img currentSrc']).toBe('');
  expect(await page.locator('img.lazy').evaluate((element) => element.complete)).toBe(false);
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

test('same-origin currentSrc ignores host/port and retains query and fragment identity', async ({ page }) => {
  await page.route('http://**/*', async (route) => {
    if (route.request().resourceType() === 'image')
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
      });
    return route.fulfill({
      contentType: 'text/html',
      body: '<img class="target" width="10" height="10" src="/image.svg?version=1#part">',
    });
  });
  await page.goto('http://base.test:1234/');
  const before = await captureStyleMap(page, options);
  await page.goto('http://head.test:9876/');
  const after = await captureStyleMap(page, options);
  expect(Object.values(after.elements).find((entry) => entry.tag === 'img')!.style['img currentSrc']).toBe(
    '/image.svg?version=1#part',
  );
  expect(diffStyleMaps(before, after)).toEqual([]);
});

test('unreadable cross-origin stylesheet records unknown, never an invented winning body', async ({ page }) => {
  await page.route('http://**/*', (route) =>
    route.request().resourceType() === 'stylesheet'
      ? route.fulfill({ contentType: 'text/css', body: '@keyframes pulse { to { opacity: .1; } }' })
      : route.fulfill({
          contentType: 'text/html',
          body: animation('to { opacity: 1; }') + '<link rel="stylesheet" href="http://other.test/style.css">',
        }),
  );
  await page.goto('http://base.test/');
  const map = await captureStyleMap(page, options);
  expect(Object.values(map.visualChannels!.keyframes)).toEqual([{ name: 'pulse', status: 'unknown' }]);
  expect(diffStyleMaps(map, map)).toEqual([]);
});

test('finished shadow-root keyframes cannot override document names; internals remain outside capture', async ({
  page,
}) => {
  const markup = (opacity: string) =>
    animation('to { opacity: 1; }') +
    `<section id="host"></section><script>
    document.querySelector('#host').attachShadow({mode:'open'}).innerHTML = '<style>@keyframes pulse { to { opacity: ${opacity}; } } i { animation: pulse 1ms forwards; }</style><i>inside</i>';
    document.querySelector('#host').shadowRoot.getAnimations()[0].finish();
  </script>`;
  const before = await capture(page, markup('.1'));
  const after = await capture(page, markup('.2'));
  expect(props(before, after)).toEqual([]);
  expect(
    Object.values(after.visualChannels!.keyframes).every(
      (rule) => rule.status === 'known' && JSON.parse(rule.body!).at(-1).opacity === '1',
    ),
  ).toBe(true);
});

test('self-check rejects keyframe/currentSrc drift and missing evidence', async ({ page }) => {
  const before = await capture(page, animation('to { opacity: 1; }'));
  const after = await capture(page, animation('to { opacity: .2; }'));
  expect(() => assertDeterministicVisualChannels(before, before, 'home')).not.toThrow();
  expect(() => assertDeterministicVisualChannels(before, after, 'home')).toThrow(/self-check failed/);
  const missing = structuredClone(before);
  delete missing.visualChannels;
  expect(() => assertDeterministicVisualChannels(before, missing, 'home')).toThrow(/evidence changed or is missing/);
  const image = structuredClone(before);
  image.elements.body.style['img currentSrc'] = '/different.png';
  expect(() => assertDeterministicVisualChannels(before, image, 'home')).toThrow(/self-check failed/);
});

test('multiple animation names retain quoted commas and escaped identifiers', async ({ page }) => {
  const markup = (opacity: string) =>
    animation(
      'from { opacity: 0; } to { opacity: 1; }',
      `
    @keyframes "has,comma" { from { opacity: 0; } to { opacity: ${opacity}; } }
    @keyframes esc\\61 ped { from { color: blue; } to { color: red; } }
    .target { animation-name: pulse, "has,comma", escaped; }
  `,
    );
  const before = await capture(page, markup('1'));
  const after = await capture(page, markup('.2'));
  expect(props(before, after).map((p) => p.prop)).toEqual(['animation keyframes (has,comma)']);
  expect(Object.values(after.visualChannels!.keyframes).every((body) => body.status === 'known')).toBe(true);
});

test('a missing active stylesheet makes the referenced keyframes unknown', async ({ page }) => {
  await page.route('http://**/*', (route) =>
    route.request().resourceType() === 'stylesheet'
      ? route.abort()
      : route.fulfill({
          contentType: 'text/html',
          body: animation('to { opacity: 1; }') + '<link rel="stylesheet" href="/missing.css">',
        }),
  );
  await page.goto('http://fixture.test/');
  const map = await captureStyleMap(page, options);
  expect(Object.values(map.visualChannels!.keyframes)).toEqual([{ name: 'pulse', status: 'unknown' }]);
});

test('slotted light-DOM names never claim a body from the wrong tree scope', async ({ page }) => {
  const map = await capture(
    page,
    `<!doctype html><style>@keyframes pulse {to{opacity:.1}}</style>
    <section id="host"><i class="target">slotted</i></section><script>
    document.querySelector('#host').attachShadow({mode:'open'}).innerHTML =
      '<style>@keyframes pulse {to{opacity:.8}} ::slotted(i) {animation:pulse 10s infinite}</style><slot></slot>';
    </script>`,
  );
  expect(Object.values(map.visualChannels!.keyframes)).toEqual([{ name: 'pulse', status: 'unknown' }]);
});
