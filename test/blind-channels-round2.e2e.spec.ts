import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { captureStyleMap, diffStyleMaps, generateStyleMapReport } from '../dist/index.js';
import { assertDeterministicVisualChannels } from '../dist/visual-channels.js';
import { pairFixture, rmTmp } from './helpers.mjs';

const options = { captureVisualChannels: true, captureStates: false, stabilize: false };
const markup = (body: string) =>
  `<!doctype html><style>@keyframes pulse{${body}}.target{animation:pulse 10s infinite;width:10px;height:10px}</style><div class="target"></div>`;
async function capture(page: Page, html: string) {
  await page.setContent(html);
  return captureStyleMap(page, options);
}
const changes = (a: Awaited<ReturnType<typeof capture>>, b: Awaited<ReturnType<typeof capture>>) =>
  diffStyleMaps(a, b).flatMap((finding) => (finding.kind === 'dom' ? [] : finding.props));
function report(before: Awaited<ReturnType<typeof capture>>, after: Awaited<ReturnType<typeof capture>>) {
  const fixture = pairFixture({ surface: 'home@800', before, after });
  try {
    return fs.readFileSync(generateStyleMapReport(fixture).reportMdPath, 'utf8');
  } finally {
    rmTmp(fixture.root);
  }
}
const image = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>';
async function imageRoutes(page: Page) {
  await page.route('http://**/*', (route) => route.fulfill({ contentType: 'image/svg+xml', body: image }));
}
const sourceOf = (map: Awaited<ReturnType<typeof capture>>) =>
  Object.values(map.elements).find((element) => element.tag === 'img')!.style['img currentSrc'];

test('every root in a re-slot chain keeps untraversed keyframes unknown, never definite none', async ({ page }) => {
  const html = (opacity: string) => `<x-outer><span>light</span></x-outer><script>
    customElements.define('x-inner', class extends HTMLElement { constructor(){ super(); this.attachShadow({mode:'open'}).innerHTML = '<style>@keyframes deep{to{opacity:${opacity}}} ::slotted(*){animation:deep 1s infinite paused}</style><slot></slot>'; } });
    customElements.define('x-outer', class extends HTMLElement { constructor(){ super(); this.attachShadow({mode:'open'}).innerHTML = '<x-inner><slot></slot></x-inner>'; } });
  </script>`;
  const before = await capture(page, html('.5'));
  expect(await page.locator('span').evaluate((element) => getComputedStyle(element).animationName)).toBe('deep');
  // A new document gives custom elements fresh definitions for the second body.
  await page.goto('about:blank');
  const after = await capture(page, html('.8'));
  for (const map of [before, after])
    expect(Object.values(map.visualChannels!.keyframes)).toEqual([{ name: 'deep', status: 'unknown' }]);
  expect(changes(before, after)).toEqual([]);
  expect(report(before, after)).toContain('unknown; not compared');
});

test('a closed slotted root cannot produce a false definite absence', async ({ page }) => {
  const map = await capture(
    page,
    `<x-closed><span>light</span></x-closed><script>
    customElements.define('x-closed', class extends HTMLElement { constructor(){ super(); this.attachShadow({mode:'closed'}).innerHTML = '<style>@keyframes deep{to{opacity:.5}} ::slotted(*){animation:deep 1s infinite}</style><slot></slot>'; } });
  </script>`,
  );
  expect(
    await page.locator('span').evaluate((element) => ({
      assignedSlot: element.assignedSlot,
      animations: element.getAnimations().length,
    })),
  ).toEqual({ assignedSlot: null, animations: 1 });
  expect(Object.values(map.visualChannels!.keyframes)).toEqual([{ name: 'deep', status: 'unknown' }]);
});

for (const [name, a, b] of [
  [
    'background-position var substitution',
    'to{opacity:.5;background-position:var(--a)}',
    'to{opacity:.5;background-position:var(--b)}',
  ],
  ['margin var deletion', 'to{opacity:.5;margin:var(--m,20px)}', 'to{opacity:.5}'],
  [
    'timing function groups',
    '50%{opacity:1;animation-timing-function:steps(1)}50%{transform:translateX(30px)}',
    '50%{opacity:1;transform:translateX(30px);animation-timing-function:steps(1)}',
  ],
  [
    'composition groups',
    '50%{opacity:1;animation-composition:add}50%{transform:translateX(30px)}',
    '50%{opacity:1;transform:translateX(30px);animation-composition:add}',
  ],
]) {
  test(`keyframe canonicalisation preserves ${name}`, async ({ page }) => {
    const before = await capture(page, markup(a));
    const after = await capture(page, markup(b));
    expect(changes(before, after).map((property) => property.prop)).toContain('animation keyframes (pulse)');
  });
}

for (const [name, a, b] of [
  ['var shorthand split and merge', '0%{margin:var(--m,20px)}0%{color:red}', '0%{color:red;margin:var(--m,20px)}'],
  ['var shorthand later wins', '0%{margin:var(--a)}0%{margin:var(--b)}', '0%{margin:var(--b)}'],
  [
    'matching timing groups merge',
    '50%{opacity:1;animation-timing-function:steps(1)}50%{transform:none;animation-timing-function:steps(1)}',
    '50%{transform:none;opacity:1;animation-timing-function:steps(1)}',
  ],
  [
    'quoted semicolon and var fallback',
    'to{font-family:"a;b";margin:var(--m,20px);opacity:.5}',
    'to{opacity:.5;margin:var(--m,20px);font-family:"a;b"}',
  ],
]) {
  test(`equivalent keyframes stay clean for ${name}`, async ({ page }) => {
    const before = await capture(page, markup(a));
    const after = await capture(page, markup(b));
    expect(before.visualChannels).toEqual(after.visualChannels);
    expect(changes(before, after)).toEqual([]);
  });
}

test('identical blob images are stable skipped evidence without exposing per-run URLs', async ({ page }) => {
  const html = `<img width="10" height="10"><script>document.querySelector('img').src=URL.createObjectURL(new Blob([${JSON.stringify(image)}],{type:'image/svg+xml'}))</script>`;
  const before = await capture(page, html);
  const after = await capture(page, html);
  expect(sourceOf(before)).toBe('(blob URL; not compared)');
  expect(sourceOf(after)).toBe('(blob URL; not compared)');
  expect(changes(before, after)).toEqual([]);
  expect(() => assertDeterministicVisualChannels(before, after, 'home')).not.toThrow();
  expect(JSON.stringify(before)).not.toMatch(/blob:/);
  expect(report(before, after)).toContain('not compared (blob URL)');
});

for (const [provider, keys] of [
  ['S3 v2', ['AWSAccessKeyId', 'Expires', 'Signature']],
  [
    'S3 v4',
    [
      'X-Amz-Algorithm',
      'X-Amz-Credential',
      'X-Amz-Date',
      'X-Amz-Expires',
      'X-Amz-SignedHeaders',
      'X-Amz-Security-Token',
      'X-Amz-Signature',
    ],
  ],
  [
    'GCS v4',
    [
      'X-Goog-Algorithm',
      'X-Goog-Credential',
      'X-Goog-Date',
      'X-Goog-Expires',
      'X-Goog-SignedHeaders',
      'X-Goog-Signature',
    ],
  ],
  ['Azure SAS', ['sv', 'st', 'se', 'sr', 'sp', 'skt', 'ske', 'skoid', 'sktid', 'sks', 'skv', 'sdd', 'spr', 'sig']],
  ['CloudFront', ['Signature', 'Key-Pair-Id', 'Expires', 'Policy']],
] as const) {
  test(`${provider} credential rotations expose no credential text in map or report`, async ({ page }) => {
    await imageRoutes(page);
    const html = (rotation: string) =>
      `<img width="10" height="10" src="http://assets.test/a.svg?asset=a%20b&${keys.map((key) => `${key}=fixture-private-${rotation}-${key}`).join('&')}#part">`;
    const before = await capture(page, html('first'));
    const after = await capture(page, html('second'));
    expect(sourceOf(before)).toBe('http://assets.test/a.svg?asset=a%20b#part');
    expect(sourceOf(after)).toBe(sourceOf(before));
    expect(JSON.stringify([before, after])).not.toContain('fixture-private');
    expect(changes(before, after)).toEqual([]);
    // Also render a real source finding; signatures must not leak into its values.
    const changed = await capture(page, html('third').replace('/a.svg?', '/b.svg?'));
    expect(changes(before, changed).map((property) => property.prop)).toContain('img currentSrc');
    const text = report(before, changed);
    expect(text).toContain('img currentSrc');
    expect(text).not.toContain('fixture-private');
    for (const key of keys) expect(text).not.toContain(`${key}=`);
  });
}

test('unsigned query fields keep identity without provider signature markers', async ({ page }) => {
  await imageRoutes(page);
  const keys = [
    'sp',
    'se',
    'sv',
    'st',
    'skt',
    'ske',
    'skoid',
    'sktid',
    'sks',
    'skv',
    'sdd',
    'spr',
    'Expires',
    'Policy',
    'X-Amz-Date',
    'X-Goog-Date',
  ];
  for (const key of keys) {
    const before = await capture(page, `<img width="10" height="10" src="http://assets.test/sprite.svg?${key}=1">`);
    const after = await capture(page, `<img width="10" height="10" src="http://assets.test/sprite.svg?${key}=2">`);
    expect(
      changes(before, after).map((property) => property.prop),
      key,
    ).toContain('img currentSrc');
  }
});

test('loaded image to complete no-source is compared; unloaded lazy image remains skipped', async ({ page }) => {
  await imageRoutes(page);
  const before = await capture(page, '<img width="10" height="10" src="http://assets.test/a.svg">');
  const after = await capture(page, '<img width="10" height="10">');
  expect(await page.locator('img').evaluate((element) => element.complete)).toBe(true);
  expect(sourceOf(after)).toBe('(no source)');
  expect(changes(before, after)).toContainEqual({
    prop: 'img currentSrc',
    before: 'http://assets.test/a.svg',
    after: '(no source)',
  });
  expect(report(before, after)).not.toContain('unloaded image');
  const lazy = await capture(
    page,
    '<img loading="lazy" style="position:absolute;top:99999px" width="10" height="10" src="http://assets.test/lazy.svg">',
  );
  expect(sourceOf(lazy)).toBe('');
  expect(changes(before, lazy).map((property) => property.prop)).not.toContain('img currentSrc');
  expect(report(before, lazy)).toContain('not compared (unloaded image)');
});
