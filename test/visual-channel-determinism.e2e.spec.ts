import { test, expect, type Page } from '@playwright/test';
import { captureStyleMap } from '../dist/capture.js';
import { diffStyleMaps } from '../dist/diff.js';
import { assertDeterministicVisualChannels } from '../dist/visual-channels.js';
import { installVisualChannelValues } from '../dist/capture/visual-channel-proof.js';
import { installVisualChannels, type VisualChannelWindow } from '../dist/capture/visual-channels.js';
import { assertBrowserLinearScaling } from './browser-linearity-helper.mjs';

// Fixture blocks isolate helper state; the test bodies and matrices are unchanged.
{
  const changes = (maps: Awaited<ReturnType<typeof captureStyleMap>>[]) =>
    diffStyleMaps(maps[0], maps[1])
      .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
      .filter((p) => p.prop.includes('keyframes'));

  test('text and inert list churn during every forced proof stays deterministic and detects 20/20 hover edits', async ({
    page,
  }) => {
    const context = page.context(),
      native = context.newCDPSession.bind(context);
    let n = 0;
    context.newCDPSession = async (...args) => {
      const client = await native(...args),
        send = client.send.bind(client);
      client.send = async (method, params) => {
        if (
          method === 'Runtime.evaluate' &&
          (params as { expression?: string })?.expression?.includes('window.__spChannelRequests()')
        )
          await page.evaluate((n) => {
            const clock = document.querySelector('#clock')!;
            clock.textContent = String(n);
            const i = document.createElement('i');
            clock.append(i);
            i.remove();
          }, ++n);
        return send(method, params);
      };
      return client;
    };
    const maps = [];
    try {
      for (const opacity of ['.5', '.5', '.6']) {
        await page.goto('about:blank');
        await page.setContent(
          `<style>#clock{position:absolute;width:100px;height:20px}button:hover{animation:hk 1s linear 100s paused both}@keyframes hk{to{opacity:${opacity}}}</style><div id=clock>0</div>` +
            '<button>x</button>'.repeat(20),
        );
        maps.push(await captureStyleMap(page, { captureVisualChannels: true, captureText: false }));
      }
      expect(() => assertDeterministicVisualChannels(maps[0], maps[1], 'churn')).not.toThrow();
      expect(changes([maps[1], maps[2]])).toHaveLength(20);
      expect(Object.values(maps[2].visualChannels!.keyframes).every((k) => k.status === 'known')).toBe(true);
    } finally {
      context.newCDPSession = native;
    }
  });
}

{
  const markup = (frames: string) =>
    `<!doctype html><style>${frames}.target{animation:pulse 10s infinite;width:10px;height:10px}</style><div class="target"></div>`;

  for (const ruleCount of [5000, 20000]) {
    test(`channel CSSOM cost is one root walk per capture with ${ruleCount} rules`, async ({ page }) => {
      await page.setContent(markup('@keyframes pulse{to{opacity:1}}' + '.unrelated{color:red}'.repeat(ruleCount)));
      expect(await page.evaluate(() => document.styleSheets[0].cssRules.length)).toBe(ruleCount + 2);
      await installVisualChannelValues(page);
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
}

{
  // Canonical/source comparisons use settling; unstabilized relative models have document-wide limits.
  const options = { captureVisualChannels: true, captureStates: false };

  async function capture(page: Page, html: string) {
    await page.goto('about:blank');
    await page.setContent(html);
    return captureStyleMap(page, options);
  }

  const markup = (frames: string) =>
    `<style>:root{--m:7px;--n:15px;--b1:2px solid green;--b2:9px dashed black}@keyframes pulse{${frames}}.a{width:50px;height:50px;position:relative;animation:pulse 1s linear infinite paused}</style><div class=a></div>`;

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
}

{
  const options = { captureVisualChannels: true, captureStates: false };

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

  test('forced-state boundary scans ignore repeated text and inert-list churn', async ({ page }) => {
    const context = page.context();
    const native = context.newCDPSession.bind(context);
    let deep = 0;
    let reads = 0;
    let hostResolves = 0;
    let churns = 0;
    context.newCDPSession = async (...args) => {
      const client = await native(...args);
      const send = client.send.bind(client);
      client.send = async (method, params) => {
        if (method === 'DOM.getDocument' && (params as { depth?: number })?.depth === -1) deep++;
        if (
          method === 'Runtime.evaluate' &&
          (params as { expression?: string })?.expression?.includes('window.__spChannelRequests()')
        )
          reads++;
        if (method === 'DOM.resolveNode') hostResolves++;
        if (
          method === 'Runtime.evaluate' &&
          (params as { expression?: string })?.expression?.includes('window.__spChannelRequests()')
        ) {
          await page.evaluate((n) => {
            const clock = document.querySelector('#clock')!;
            clock.textContent = String(n);
            const child = document.createElement('i');
            clock.append(child);
            child.remove();
          }, ++churns);
        }
        return send(method, params);
      };
      return client;
    };
    await page.setContent(
      `<style>${css}button:hover{color:red}</style>` +
        '<div id=clock>0</div>' +
        '<div class=a>x</div>'.repeat(80) +
        '<button>b</button>'.repeat(5),
    );
    try {
      await captureStyleMap(page, { captureVisualChannels: true, stabilize: false });
      expect(reads).toBeGreaterThan(1);
      expect(deep).toBeGreaterThanOrEqual(1);
      expect(churns).toBeGreaterThan(5);
      expect(deep).toBeLessThanOrEqual(2);
      expect(deep).toBeLessThan(reads);
      expect(hostResolves).toBe(0);
    } finally {
      context.newCDPSession = native;
    }
  });
}

{
  for (const mode of ['open', 'closed'] as const)
    test(`complete capture scales with ${mode} author hosts using warmed minimum CPU samples`, async ({
      page,
    }, info) => {
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
}
