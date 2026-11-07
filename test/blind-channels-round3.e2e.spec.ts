import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { captureStyleMap, diffStyleMaps, generateStyleMapReport } from '../dist/index.js';
import { pairFixture, rmTmp } from './helpers.mjs';
// Canonical/source comparisons use settling; unstabilized relative models have document-wide limits.
const options = { captureVisualChannels: true, captureStates: false };
async function capture(page: Page, html: string) {
  await page.goto('about:blank');
  await page.setContent(html);
  return captureStyleMap(page, options);
}
const changes = (a: Awaited<ReturnType<typeof capture>>, b: Awaited<ReturnType<typeof capture>>) =>
  diffStyleMaps(a, b).flatMap((f) => (f.kind === 'dom' ? [] : f.props));
const markup = (frames: string) =>
  `<style>:root{--m:7px;--n:15px;--b1:2px solid green;--b2:9px dashed black}@keyframes pulse{${frames}}.a{width:50px;height:50px;position:relative;animation:pulse 1s linear infinite paused}</style><div class=a></div>`;
for (const [name, a, b] of [
  ['V1', 'to{margin:var(--m);margin-left:3px}', 'to{margin:var(--n);margin-left:3px}'],
  ['V2', 'to{margin:var(--m)}to{margin-left:3px}', 'to{margin:var(--n)}to{margin-left:3px}'],
  ['V3', 'to{border:var(--b1);border-left-color:red}', 'to{border:var(--b2);border-left-color:red}'],
  ['LP1', 'to{margin-left:3px;margin-inline-start:25px}', 'to{margin-inline-start:25px;margin-left:3px}'],
  ['LP2', 'to{margin-left:3px}to{margin-inline-start:25px}', 'to{margin-inline-start:25px}to{margin-left:3px}'],
  ['LP3', 'to{inset-inline-start:20px;left:2px}', 'to{left:2px;inset-inline-start:20px}'],
  [
    'non-adjacent timing',
    '0%{opacity:0}50%{animation-timing-function:steps(1);opacity:.5}50%{animation-timing-function:linear;opacity:.7}50%{animation-timing-function:steps(1);opacity:.8}100%{opacity:1}',
    '0%{opacity:0}50%{animation-timing-function:steps(1);opacity:.8}50%{animation-timing-function:linear;opacity:.7}100%{opacity:1}',
  ],
  [
    'T1',
    '50%{opacity:1;animation-timing-function:steps(1)}50%{transform:translateX(30px);animation-timing-function:ease-in}',
    '50%{opacity:1;animation-timing-function:ease-in}50%{transform:translateX(30px);animation-timing-function:steps(1)}',
  ],
  [
    'C1',
    'to{transform:translateX(5px);animation-composition:add}',
    'to{transform:translateX(5px);animation-composition:replace}',
  ],
])
  test(`${name} uses the live engine body`, async ({ page }) => {
    const before = await capture(page, markup(a));
    const after = await capture(page, markup(b));
    expect(changes(before, after).map((p) => p.prop)).toContain('animation keyframes (pulse)');
  });
test('K1 animated custom properties omitted by the engine model stay unknown', async ({ page }) => {
  const before = await capture(page, markup('to{--x:10px;margin-left:var(--x)}'));
  const after = await capture(page, markup('to{--x:20px;margin-left:var(--x)}'));
  for (const map of [before, after]) expect(Object.values(map.visualChannels!.keyframes)[0].status).toBe('unknown');
  const fixture = pairFixture({ surface: 'home@800', before, after });
  try {
    expect(fs.readFileSync(generateStyleMapReport(fixture).reportMdPath, 'utf8')).toContain(
      'keyframes resolution ambiguous',
    );
  } finally {
    rmTmp(fixture.root);
  }
});

for (const [name, a, b] of [
  [
    'deleting only the first timing duplicate',
    '0%{opacity:0}50%{animation-timing-function:steps(1);opacity:.5}50%{animation-timing-function:linear;opacity:.7}50%{animation-timing-function:steps(1);opacity:.8}100%{opacity:1}',
    '0%{opacity:0}50%{animation-timing-function:linear;opacity:.7}50%{animation-timing-function:steps(1);opacity:.8}100%{opacity:1}',
  ],
  ['V4 stable', 'to{margin:var(--m);margin-left:3px}', 'to{margin:var(--m);margin-left:3px}'],
  [
    'adjacent timing',
    '50%{opacity:.5;animation-timing-function:steps(1)}50%{transform:none;animation-timing-function:steps(1)}',
    '50%{opacity:.5;transform:none;animation-timing-function:steps(1)}',
  ],
  ['offset reorder', 'from{opacity:0}to{opacity:1}', 'to{opacity:1}from{opacity:0}'],
  [
    'T3 easing',
    '50%{opacity:.5;animation-timing-function:ease}',
    '50%{opacity:.5;animation-timing-function:cubic-bezier(.25,.1,.25,1)}',
  ],
  ['Q1 quoted content', 'to{font-family:"a;b}c",serif;opacity:.5}', 'to{opacity:.5;font-family:"a;b}c",serif}'],
])
  test(`${name} stays clean`, async ({ page }) => {
    const aMap = await capture(page, markup(a));
    const bMap = await capture(page, markup(b));
    expect(changes(aMap, bMap)).toEqual([]);
    expect(aMap.visualChannels).toEqual(bMap.visualChannels);
  });
function shadow(modes: string[], value: string, doc: string, host = false) {
  let script = '';
  for (let i = modes.length - 1; i >= 0; i--) {
    const inner =
      i === modes.length - 1
        ? `<style>@keyframes deep{to{opacity:${value}}}${host ? ':host' : '::slotted(*)'}{animation:deep 1s linear infinite paused;display:block}</style>${host ? '' : '<slot></slot>'}`
        : `<x-level-${i + 1}><slot></slot></x-level-${i + 1}>`;
    script += `customElements.define('x-level-${i}',class extends HTMLElement{constructor(){super();this.attachShadow({mode:'${modes[i]}'}).innerHTML=${JSON.stringify(inner)}}});`;
  }
  return `<style>${doc ? `@keyframes deep{to{opacity:${doc}}}` : ''}.control{animation:deep 1s infinite paused}</style><script>${script}</script><x-level-0>${host ? '' : '<span class=light>light</span>'}</x-level-0><div class=control>control</div>`;
}
for (const [label, modes, host, docChange] of [
  ['S1', ['closed'], false, true],
  ['S2', ['closed'], false, false],
  ['S3', ['closed'], true, true],
  ['S4', ['closed'], true, false],
  ['S5', ['closed'], true, false],
  ['S6', ['open', 'closed'], false, true],
  ['S7', ['open', 'closed'], false, false],
  ['S8', ['closed', 'open'], false, false],
  ['three mixed', ['open', 'closed', 'open'], false, false],
  ['three mixed reversed', ['closed', 'open', 'closed'], false, false],
  ['open-only', ['open', 'open'], false, false],
] as const)
  test(`${label} never borrows an outer keyframes body`, async ({ page }) => {
    const a = await capture(page, shadow([...modes], '.5', label === 'S5' ? '' : '.1', host));
    const b = await capture(
      page,
      shadow([...modes], docChange ? '.5' : '.8', docChange ? '.9' : label === 'S5' ? '' : '.1', host),
    );
    for (const map of [a, b]) {
      const target = Object.values(map.elements).find((e) => (host ? e.tag === 'x-level-0' : e.cls === 'light'))!;
      expect(map.visualChannels!.keyframes[target.style['animation keyframes (deep)']].status).toBe('unknown');
      const control = Object.values(map.elements).find((e) => e.cls === 'control')!;
      if (label !== 'S5')
        expect(map.visualChannels!.keyframes[control.style['animation keyframes (deep)']].status).toBe(
          modes.includes('closed') ? 'unknown' : 'known',
        );
    }
    const fixture = pairFixture({ surface: 'home@800', before: a, after: b });
    try {
      expect(fs.readFileSync(generateStyleMapReport(fixture).reportMdPath, 'utf8')).toContain(
        'keyframes resolution ambiguous',
      );
    } finally {
      rmTmp(fixture.root);
    }
    const targetChanges = diffStyleMaps(a, b)
      .filter((f) => f.cls !== 'control')
      .flatMap((f) => (f.kind === 'dom' ? [] : f.props));
    expect(targetChanges.filter((p) => p.prop.startsWith('animation keyframes'))).toEqual([]);
  });
for (const [label, a, b, equal] of [
  ['R1 Bunny', 'token=fixture-first&expires=1&exp=1', 'token=fixture-second&expires=2&exp=2', true],
  ['R2 Akamai', 'hdnts=exp%3D1~hmac%3Dfixture-first', 'hdnts=exp%3D2~hmac%3Dfixture-second', true],
  ['R3 Akamai token', '__token__=exp=1~hmac=fixture-first', '__token__=exp=2~hmac=fixture-second', true],
  [
    'R4 GCS V2',
    'GoogleAccessId=public&Expires=1&Signature=fixture-first',
    'GoogleAccessId=public&Expires=2&Signature=fixture-second',
    true,
  ],
  ['R5 S3 identity', 'w=100&X-Amz-Signature=fixture-first', 'w=200&X-Amz-Signature=fixture-second', false],
  ['R6 SAS identity', 'v=1&sig=fixture-first&se=1', 'v=2&sig=fixture-second&se=2', false],
  [
    'R7 encoded signature',
    'X-Amz-Credential=k&x%2Damz%2Dsignature=fixture-first',
    'X-Amz-Credential=k&x%2Damz%2Dsignature=fixture-second',
    true,
  ],
  ['R8 unsigned expiry', 'expires=1', 'expires=2', false],
  ['R9 Maps identity', 'key=public-one', 'key=public-two', false],
  [
    'R10 CloudFront',
    'Policy=p1&Signature=fixture-first&Key-Pair-Id=K',
    'Policy=p2&Signature=fixture-second&Key-Pair-Id=K',
    true,
  ],
  ['R11 encoding', 'b=%2B&a=1%20&token=fixture-first', 'b=%2B&a=1%20&token=fixture-second', true],
] as const)
  test(label, async ({ page }) => {
    await page.route('http://assets.test/**', (r) =>
      r.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
      }),
    );
    const html = (q: string) => `<img width=10 height=10 src="http://assets.test/a.svg?${q}">`;
    const before = await capture(page, html(a));
    const after = await capture(page, html(b));
    expect(changes(before, after).some((p) => p.prop === 'img currentSrc')).toBe(!equal);
    expect(JSON.stringify([before, after])).not.toMatch(/fixture-first|fixture-second|hmac/);
    const fixture = pairFixture({ surface: 'home@800', before, after });
    try {
      expect(fs.readFileSync(generateStyleMapReport(fixture).reportMdPath, 'utf8')).not.toMatch(
        /fixture-first|fixture-second|hmac/,
      );
    } finally {
      rmTmp(fixture.root);
    }
  });

for (const fault of ['body mismatch', 'missing winner', 'unavailable frames']) {
  test(`engine source cross-check names ${fault} as unknown`, async ({ page }) => {
    await page.setContent(markup('to{opacity:.5}'));
    await page.evaluate((fault) => {
      const sheet = document.styleSheets[0];
      const rule = Array.from(sheet.cssRules).find((rule) => rule instanceof CSSKeyframesRule) as CSSKeyframesRule;
      if (fault === 'body mismatch') {
        const style = (rule.cssRules[0] as CSSKeyframeRule).style;
        Object.defineProperty(style, 'cssText', { get: () => 'opacity: 0.9;' });
      } else if (fault === 'missing winner') {
        const rules = Array.from(sheet.cssRules).filter((rule) => !(rule instanceof CSSKeyframesRule));
        Object.defineProperty(sheet, 'cssRules', { get: () => rules });
      } else
        KeyframeEffect.prototype.getKeyframes = () => {
          throw new Error('unavailable model');
        };
    }, fault);
    const map = await captureStyleMap(page, options);
    expect(Object.values(map.visualChannels!.keyframes)).toEqual([{ name: 'pulse', status: 'unknown' }]);
  });
}

test('canonical engine bodies contain no sampled progress', async ({ page }) => {
  const map = await capture(page, markup('from{opacity:0}to{opacity:.5;margin:var(--m);margin-left:3px}'));
  const bodies = await page.locator('.a').evaluate((element) => {
    const animation = element.getAnimations()[0];
    const results = [];
    for (const time of [0, 300, 900]) {
      animation.currentTime = time;
      getComputedStyle(element).getPropertyValue('opacity');
      results.push(JSON.stringify(animation.effect!.getKeyframes()));
    }
    return results;
  });
  expect(new Set(bodies).size).toBe(1);
  expect(Object.values(map.visualChannels!.keyframes)[0].status).toBe('known');
});

for (const documentChanges of [false, true])
  test(`adopted slotted scope stays unknown when ${documentChanges ? 'document' : 'shadow'} body changes`, async ({
    page,
  }) => {
    const html = (doc: string, shadow: string) =>
      `<style>@keyframes deep{to{opacity:${doc}}}</style><script>customElements.define('x-adopted',class extends HTMLElement{constructor(){super();const r=this.attachShadow({mode:'open'});const s=new CSSStyleSheet();s.replaceSync('@keyframes deep{to{opacity:${shadow}}}::slotted(*){animation:deep 1s infinite paused}');r.adoptedStyleSheets=[s];r.innerHTML='<slot></slot>'}})</script><x-adopted><span>light</span></x-adopted>`;
    const a = await capture(page, html('.1', '.5'));
    const b = await capture(page, html(documentChanges ? '.9' : '.1', documentChanges ? '.5' : '.8'));
    for (const map of [a, b])
      expect(Object.values(map.visualChannels!.keyframes).every((rule) => rule.status === 'unknown')).toBe(true);
    expect(changes(a, b)).toEqual([]);
  });
