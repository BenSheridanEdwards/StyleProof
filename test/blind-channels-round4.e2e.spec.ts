import { test, expect } from '@playwright/test';
import { captureStyleMap, diffStyleMaps } from '../dist/index.js';
import { assertBrowserLinearScaling } from './browser-linearity-helper.mjs';
const options = { captureVisualChannels: true, captureStates: false, stabilize: false };
const css = '@keyframes pulse{from{opacity:0}to{opacity:.5}} .a{animation:pulse 1s infinite paused}';
test('one flat animation index per channel read, without per-element native lookups', async ({ page }) => {
  await page.setContent(`<style>${css}</style>` + '<div class=a>x</div>'.repeat(40));
  const calls = await page.evaluate(() => {
    let calls = 0;
    const native = Element.prototype.getAnimations;
    Element.prototype.getAnimations = function (...args) {
      calls++;
      return native.apply(this, args);
    };
    (window as Window & { count: () => number }).count = () => calls;
  });
  void calls;
  await captureStyleMap(page, options);
  expect(await page.evaluate(() => (window as Window & { count: () => number }).count())).toBe(0);
});
test('reset and finishing animations have identical evidence across ten captures', async ({ page }) => {
  let first: unknown;
  for (let i = 0; i < 10; i++) {
    await page.setContent(
      `<style>@media(prefers-reduced-motion:reduce){*{animation-duration:.01ms!important;animation-iteration-count:1!important}}@keyframes spin{to{transform:rotate(360deg)}}@keyframes enter{from{opacity:0}}.a{animation:spin 1s infinite}.b{animation:enter 60ms}</style><div class=a>x</div><div class=b>y</div>` +
        '<p>text</p>'.repeat(300),
    );
    const map = await captureStyleMap(page, { captureVisualChannels: true, captureStates: false });
    const evidence = map.visualChannels;
    if (i === 0) first = evidence;
    else expect(evidence).toEqual(first);
  }
});
for (const inherited of [false, true])
  test(`animated custom-property input stays unknown (${inherited ? 'ancestor' : 'self'})`, async ({ page }) => {
    const maps = [];
    for (const time of [0, 300, 900]) {
      await page.setContent(
        `<style>@property --x{syntax:'<length>';inherits:true;initial-value:0px}@keyframes custom{from{--x:10px}to{--x:20px}}@keyframes pulse{to{margin-left:var(--x)}}${inherited ? '.parent{animation:custom 1s linear infinite paused}.a{animation:pulse 1s linear infinite paused}' : '.a{animation:custom 1s linear infinite paused,pulse 1s linear infinite paused}'}</style><div class=parent><div class=a>x</div></div>`,
      );
      await page.evaluate((time) => {
        for (const a of document.getAnimations()) a.currentTime = time;
      }, time);
      const map = await captureStyleMap(page, options);
      maps.push(map);
      expect(Object.values(map.visualChannels!.keyframes).find((body) => body.name === 'pulse')?.status).toBe(
        'unknown',
      );
    }
    expect(maps[0].visualChannels).toEqual(maps[2].visualChannels);
  });
test('T2 disjoint reorder stays clean and shared-property timing order still flags', async ({ page }) => {
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
test('capture does not pause an inline important animation', async ({ page }) => {
  await page.setContent(`<style>${css}</style><div class=a style="animation:pulse 1s infinite!important">x</div>`);
  await captureStyleMap(page, options);
  expect(await page.evaluate(() => document.getAnimations().map((a) => a.playState))).not.toContain('paused');
});
test('animated element captures scale linearly at 500, 1000 and 2000 elements', async ({ page }) => {
  test.setTimeout(180_000);
  const client = await page.context().newCDPSession(page);
  const prepare = async (n: number) => {
    await page.setContent(`<style>${css}</style>` + '<div class=a>x</div>'.repeat(n));
  };
  const run = async () => {
    const map = await captureStyleMap(page, options);
    expect(Object.values(map.visualChannels!.keyframes)[0].status).toBe('known');
    return Object.values(map.elements).filter((element) => element.cls === 'a').length;
  };
  try {
    await prepare(1000);
    expect(await run()).toBe(1000);
    await assertBrowserLinearScaling(
      { diagnostic: (message: string) => process.stdout.write(message + '\n') },
      {
        client,
        name: 'Chromium animated capture',
        n: 500,
        prepare,
        run,
        check: (count: number, n: number) => expect(count).toBe(n),
      },
    );
  } finally {
    await client.detach();
  }
});

test('forced-state reads traverse the full author-root tree only once per capture', async ({ page }) => {
  const context = page.context();
  const native = context.newCDPSession.bind(context);
  let deep = 0;
  context.newCDPSession = async (...args) => {
    const client = await native(...args);
    const send = client.send.bind(client);
    client.send = async (method, params) => {
      if (method === 'DOM.getDocument' && (params as { depth?: number })?.depth === -1) deep++;
      return send(method, params);
    };
    return client;
  };
  await page.setContent(
    `<style>${css}button:hover{color:red}</style>` + '<div class=a>x</div>'.repeat(80) + '<button>b</button>'.repeat(5),
  );
  try {
    await captureStyleMap(page, { captureVisualChannels: true, stabilize: false });
    expect(deep).toBeLessThanOrEqual(1);
  } finally {
    context.newCDPSession = native;
  }
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

test('a variable consumer stays unknown when an opaque ancestor animation drives its input', async ({ page }) => {
  await page.route('http://fixture.test/', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<style>@property --x{syntax:'<length>';inherits:true;initial-value:0px}@keyframes pulse{to{margin-left:var(--x)}}.parent{animation:custom 1s linear infinite paused}.a{animation:pulse 1s linear infinite paused}</style><link rel=stylesheet href="http://other.test/custom.css"><div class=parent><div class=a>x</div></div>`,
    }),
  );
  await page.route('http://other.test/custom.css', (route) =>
    route.fulfill({ contentType: 'text/css', body: '@keyframes custom{from{--x:10px}to{--x:20px}}' }),
  );
  await page.goto('http://fixture.test/');
  const map = await captureStyleMap(page, options);
  expect(Object.values(map.visualChannels!.keyframes).find((body) => body.name === 'pulse')?.status).toBe('unknown');
});

test('a paused Web Animation driving a variable input cannot produce known time-dependent endpoints', async ({
  page,
}) => {
  const evidence = [];
  for (const time of [0, 900]) {
    await page.setContent(
      `<style>@property --x{syntax:'<length>';inherits:true;initial-value:0px}@keyframes pulse{to{margin-left:var(--x)}}.a{animation:pulse 1s linear infinite paused}</style><div class=parent><div class=a>x</div></div>`,
    );
    await page.evaluate((t) => {
      const a = document
        .querySelector('.parent')!
        .animate({ '--x': ['10px', '20px'] }, { duration: 1000, fill: 'both' });
      a.pause();
      a.currentTime = t;
    }, time);
    const map = await captureStyleMap(page, options);
    evidence.push(map.visualChannels);
    expect(Object.values(map.visualChannels!.keyframes).find((body) => body.name === 'pulse')?.status).toBe('unknown');
  }
  expect(evidence[0]).toEqual(evidence[1]);
});
