import { test, expect, type Page } from '@playwright/test';
import { captureStyleMap, diffStyleMaps } from '../dist/index.js';
import { installVisualChannels, type VisualChannelWindow } from '../dist/capture/visual-channels.js';

const options = { captureVisualChannels: true, captureStates: false, stabilize: false };
const markup = (frames: string) =>
  `<!doctype html><style>${frames}.target{animation:pulse 10s infinite;width:10px;height:10px}</style><div class="target"></div>`;
async function capture(page: Page, html: string) {
  await page.setContent(html);
  return captureStyleMap(page, options);
}
const changes = (a: Awaited<ReturnType<typeof capture>>, b: Awaited<ReturnType<typeof capture>>) =>
  diffStyleMaps(a, b).flatMap((finding) => (finding.kind === 'dom' ? [] : finding.props));

for (const [name, head] of [
  ['deleted', ''],
  ['non-applying media', '@media (max-width:1px){@keyframes pulse{to{opacity:.2}}}'],
]) {
  test(`keyframes ${name} is proved absent rather than unknown`, async ({ page }) => {
    const before = await capture(page, markup('@keyframes pulse{to{opacity:.2}}'));
    const after = await capture(page, markup(head));
    expect(Object.values(after.visualChannels!.keyframes)).toEqual([{ name: 'pulse', status: 'none' }]);
    expect(changes(before, after)).toContainEqual({
      prop: 'animation keyframes (pulse)',
      before: '100% { opacity: 0.2; }',
      after: '(no @keyframes)',
    });
  });
}

test('timeline range selectors retain their identity and never collapse to NaN', async ({ page }) => {
  const before = await capture(page, markup('@keyframes pulse{entry 10%{opacity:.2}}'));
  const after = await capture(page, markup('@keyframes pulse{cover 10%{opacity:.2}}'));
  expect(changes(before, after).map((p) => p.prop)).toContain('animation keyframes (pulse)');
  expect(JSON.stringify(before.visualChannels)).toContain('entry 10%');
  expect(JSON.stringify(after.visualChannels)).toContain('cover 10%');
  expect(JSON.stringify(after.visualChannels)).not.toContain('NaN');
});

for (const [name, a, b] of [
  ['reorder', 'from{opacity:0}to{opacity:1}', 'to{opacity:1}from{opacity:0}'],
  ['split lists', '0%,100%{opacity:1}', '0%{opacity:1}100%{opacity:1}'],
  ['merge declarations', '0%{opacity:1}0%{color:red}', '0%{opacity:1;color:red}'],
  ['duplicate cascade', '0%{opacity:0;color:red}0%{opacity:1}', '0%{opacity:1;color:red}'],
  ['range reorder', 'entry 10%{opacity:0}cover 10%{opacity:1}', 'cover 10%{opacity:1}entry 10%{opacity:0}'],
]) {
  test(`effective keyframes canonicalise ${name}`, async ({ page }) => {
    const before = await capture(page, markup(`@keyframes pulse{${a}}`));
    const after = await capture(page, markup(`@keyframes pulse{${b}}`));
    expect(changes(before, after)).toEqual([]);
    expect(before.visualChannels).toEqual(after.visualChannels);
  });
}

test('merging duplicate offsets still detects a changed effective property', async ({ page }) => {
  const before = await capture(page, markup('@keyframes pulse{0%{opacity:0}0%{opacity:1}}'));
  const after = await capture(page, markup('@keyframes pulse{0%{opacity:0}0%{opacity:.4}}'));
  expect(changes(before, after).map((p) => p.prop)).toContain('animation keyframes (pulse)');
});

test('a readable unlayered winner after an opaque sheet is compared; an opaque later sheet stays unknown', async ({
  page,
}) => {
  let sheetAfter = false;
  await page.route('http://**/*', (route) => {
    if (route.request().resourceType() === 'stylesheet')
      return route.fulfill({ contentType: 'text/css', body: '.irrelevant{color:red}' });
    const css = markup('@keyframes pulse{to{opacity:.2}}');
    const link = '<link rel="stylesheet" href="http://opaque.test/style.css">';
    return route.fulfill({ contentType: 'text/html', body: sheetAfter ? css + link : link + css });
  });
  await page.goto('http://fixture.test/');
  const known = await captureStyleMap(page, options);
  expect(Object.values(known.visualChannels!.keyframes)[0].status).toBe('known');
  sheetAfter = true;
  await page.goto('http://fixture.test/');
  const unknown = await captureStyleMap(page, options);
  expect(Object.values(unknown.visualChannels!.keyframes)[0].status).toBe('unknown');
});

test('an opaque imported layer cannot beat a readable later layer', async ({ page }) => {
  await page.route('http://**/*', (route) =>
    route.request().resourceType() === 'stylesheet'
      ? route.fulfill({ contentType: 'text/css', body: '@keyframes pulse{to{opacity:.1}}' })
      : route.fulfill({
          contentType: 'text/html',
          body: markup(
            '@import url("http://opaque.test/style.css") layer(first); @layer last{@keyframes pulse{to{opacity:.2}}}',
          ),
        }),
  );
  await page.goto('http://fixture.test/');
  const map = await captureStyleMap(page, options);
  expect(Object.values(map.visualChannels!.keyframes)[0].status).toBe('known');
});

test('credential query fields are removed from stored sources but benign parameters and external hosts retain identity', async ({
  page,
}) => {
  await page.route('http://**/*', (route) => {
    if (route.request().resourceType() === 'image')
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
      });
    const keys = [
      'X-Amz-Credential',
      'X-Amz-Signature',
      'Signature',
      'token',
      'access_token',
      'sig',
      'se',
      'sp',
      'sv',
      'Expires',
      'Key-Pair-Id',
      'Policy',
    ];
    const query = keys.map((key) => `${key}=fixture-sensitive-${key}`).join('&');
    return route.fulfill({
      contentType: 'text/html',
      body: `<img width="10" height="10" src="/a.svg?version=7&${query}#part">`,
    });
  });
  await page.goto('http://fixture.test/');
  const map = await captureStyleMap(page, options);
  expect(Object.values(map.elements).find((e) => e.tag === 'img')!.style['img currentSrc']).toBe(
    '/a.svg?version=7#part',
  );
  expect(JSON.stringify(map)).not.toContain('fixture-sensitive');
  const before = await capture(page, '<img width="10" height="10" src="http://assets-a.test/a.svg">');
  const after = await capture(page, '<img width="10" height="10" src="http://assets-b.test/a.svg">');
  expect(changes(before, after).map((p) => p.prop)).toContain('img currentSrc');
});

for (const ruleCount of [5000, 20000]) {
  test(`channel CSSOM cost is one root walk per capture with ${ruleCount} rules`, async ({ page }) => {
    await page.setContent(markup('@keyframes pulse{to{opacity:1}}' + '.unrelated{color:red}'.repeat(ruleCount)));
    await page.evaluate(installVisualChannels, true);
    const counts = await page.evaluate(() => {
      const sheet = Object.getOwnPropertyDescriptor(CSSStyleSheet.prototype, 'cssRules')!;
      const text = Object.getOwnPropertyDescriptor(CSSRule.prototype, 'cssText')!;
      let reads = 0;
      let serialisations = 0;
      Object.defineProperty(CSSStyleSheet.prototype, 'cssRules', {
        configurable: true,
        get() {
          reads++;
          return sheet.get!.call(this);
        },
      });
      Object.defineProperty(CSSRule.prototype, 'cssText', {
        configurable: true,
        get() {
          serialisations++;
          return text.get!.call(this);
        },
      });
      try {
        const reader = (window as Window & VisualChannelWindow).__spReadChannels!;
        const elements = [document.querySelector('.target')!];
        reader(elements, []);
        const first = reads;
        for (let i = 0; i < 20; i++) reader(elements, []);
        return { first, repeats: reads - first, serialisations };
      } finally {
        Object.defineProperty(CSSStyleSheet.prototype, 'cssRules', sheet);
        Object.defineProperty(CSSRule.prototype, 'cssText', text);
      }
    });
    expect(counts.first).toBe(1);
    expect(counts.repeats).toBe(0);
    expect(counts.serialisations).toBe(0);
  });
}
