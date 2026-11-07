import { test, expect, type Page } from '@playwright/test';
import { captureStyleMap } from '../dist/capture.js';
import { diffStyleMaps } from '../dist/diff.js';
import { installVisualChannelValues } from '../dist/capture/visual-channel-proof.js';
import { installVisualChannels, type VisualChannelWindow } from '../dist/capture/visual-channels.js';
import fs from 'node:fs';
import { generateStyleMapReport } from '../dist/index.js';
import { pairFixture, rmTmp } from './helpers.mjs';

// Fixture blocks isolate helper state; the test bodies and matrices are unchanged.
{
  // Canonical/source comparisons use settling; unstabilized relative models have document-wide limits.
  const options = { captureVisualChannels: true, captureStates: false };

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
      const finding = changes(before, after).find((property) => property.prop === 'animation keyframes (pulse)');
      expect(finding?.after).toBe('(no @keyframes)');
      expect(JSON.parse(finding!.before).at(-1).opacity).toBe('0.2');
    });
  }

  test('unusable timeline-range engine frames stay unknown and never collapse to NaN', async ({ page }) => {
    const before = await capture(page, markup('@keyframes pulse{entry 10%{opacity:.2}}'));
    const after = await capture(page, markup('@keyframes pulse{cover 10%{opacity:.2}}'));
    expect(changes(before, after)).toEqual([]);
    expect(Object.values(before.visualChannels!.keyframes)[0].status).toBe('unknown');
    expect(Object.values(after.visualChannels!.keyframes)[0].status).toBe('unknown');
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

  test('matched engine source verifies a readable winner before or after an opaque sheet', async ({ page }) => {
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
    const after = await captureStyleMap(page, options);
    expect(Object.values(after.visualChannels!.keyframes)[0].status).toBe('known');
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
}

{
  // Canonical/source comparisons use settling; unstabilized relative models have document-wide limits.
  const options = { captureVisualChannels: true, captureStates: false };

  const markup = (body: string) =>
    `<!doctype html><style>:root{--a:0px 0px;--b:40px 40px}@keyframes pulse{${body}}.target{animation:pulse 10s infinite;width:10px;height:10px}</style><div class="target"></div>`;

  async function capture(page: Page, html: string) {
    await page.setContent(html);
    return captureStyleMap(page, options);
  }

  const changes = (a: Awaited<ReturnType<typeof capture>>, b: Awaited<ReturnType<typeof capture>>) =>
    diffStyleMaps(a, b).flatMap((finding) => (finding.kind === 'dom' ? [] : finding.props));

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

  test('engine keyframes need no cumulative CSS declaration rewriting', async ({ page }) => {
    await page.setContent(
      markup(Array.from({ length: 1000 }, (_, index) => `100%{--p-${index}:${index};opacity:.5}`).join('')),
    );
    await installVisualChannelValues(page);
    await page.evaluate(installVisualChannels, true);
    const work = await page.evaluate(() => {
      const descriptor = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'cssText')!;
      const originalFrames = KeyframeEffect.prototype.getKeyframes;
      let reads = 0;
      KeyframeEffect.prototype.getKeyframes = function () {
        reads++;
        return originalFrames.call(this);
      };
      let writes = 0;
      let characters = 0;
      Object.defineProperty(CSSStyleDeclaration.prototype, 'cssText', {
        ...descriptor,
        set(value: string) {
          writes++;
          characters += value.length;
          descriptor.set!.call(this, value);
        },
      });
      try {
        (window as Window & VisualChannelWindow).__spReadChannels!([document.querySelector('.target')!], []);
        return { writes, characters, reads };
      } finally {
        Object.defineProperty(CSSStyleDeclaration.prototype, 'cssText', descriptor);
        KeyframeEffect.prototype.getKeyframes = originalFrames;
      }
    });
    expect(work.writes).toBe(0);
    expect(work.characters).toBe(0);
    expect(work.reads).toBe(1);
  });
}

{
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
}

{
  const options = { captureVisualChannels: true, captureStates: false };

  const css = '@keyframes pulse{from{opacity:0}to{opacity:.5}} .a{animation:pulse 1s infinite paused}';

  test('T2 disjoint-property timing groups remain clean when reordered', async ({ page }) => {
    const frames = [
      '50%{opacity:1;animation-timing-function:steps(1)}',
      '50%{transform:translateX(30px);animation-timing-function:ease-in}',
    ];
    const maps = [];
    for (const blocks of [frames, frames.toReversed()]) {
      await page.setContent(
        `<style>@keyframes pulse{${blocks.join('')}}.a{animation:pulse 1s linear infinite paused}</style><div class=a>x</div>`,
      );
      maps.push(await captureStyleMap(page, options));
    }
    expect(diffStyleMaps(maps[0], maps[1])).toEqual([]);
  });

  test('identical duplicated definitions remain known', async ({ page }) => {
    await page.setContent(`<style>${css}</style><style>${css}</style><div class=a>x</div>`);
    const map = await captureStyleMap(page, options);
    expect(Object.values(map.visualChannels!.keyframes)[0].status).toBe('known');
  });

  test('engine and matched source agreement overrides an unreadable later sheet', async ({ page }) => {
    await page.route('http://fixture.test/', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<style>${css}</style><link rel=stylesheet href="http://other.test/font.css"><div class=a>x</div>`,
      }),
    );
    await page.route('http://other.test/font.css', (route) =>
      route.fulfill({ contentType: 'text/css', body: '.unrelated{color:red}' }),
    );
    await page.goto('http://fixture.test/');
    const map = await captureStyleMap(page, options);
    expect(Object.values(map.visualChannels!.keyframes)[0].status).toBe('known');
  });

  for (const style of ['display:none;animation:g 1s infinite', 'animation:g 1s,g 2s'])
    test(`unavailable or ambiguous live model stays unknown: ${style}`, async ({ page }) => {
      await page.setContent(`<style>@keyframes g{to{opacity:.5}}.a{${style}}</style><div class=a>x</div>`);
      const map = await captureStyleMap(page, options);
      expect(Object.values(map.visualChannels!.keyframes)).toEqual([{ name: 'g', status: 'unknown' }]);
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
}
