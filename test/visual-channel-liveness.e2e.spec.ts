import { test, expect } from '@playwright/test';
import { captureStyleMap } from '../dist/capture.js';
import { diffStyleMaps } from '../dist/diff.js';
import { assertDeterministicVisualChannels } from '../dist/visual-channels.js';

// Fixture blocks isolate helper state; the test bodies and matrices are unchanged.
{
  const changes = (maps: Awaited<ReturnType<typeof captureStyleMap>>[]) =>
    diffStyleMaps(maps[0], maps[1])
      .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
      .filter((p) => p.prop.includes('keyframes'));

  for (const kind of ['closed', 'declarative closed', 'finished closed'] as const)
    test(`static ${kind} sibling keeps a real document body change detectable`, async ({ page }) => {
      const maps = [];
      for (const value of [0.5, 0.6]) {
        await page.goto('about:blank');
        await page.setContent(
          `<style>@keyframes pulse{to{opacity:${value}}}.a{animation:pulse 1s linear 100s infinite paused both}</style><div class=a>x</div>${kind === 'declarative closed' ? '<x-host><template shadowrootmode="closed"><span>static</span></template></x-host>' : '<x-host></x-host>'}`,
        );
        if (kind === 'declarative closed') expect(await page.locator('x-host').innerHTML()).toBe('');
        else
          await page.locator('x-host').evaluate((host, finished) => {
            const root = host.attachShadow({ mode: 'closed' });
            root.innerHTML = finished
              ? '<style>@keyframes drive{to{opacity:.5}}span{animation:drive 1ms forwards}</style><span>x</span>'
              : '<span>static</span>';
            for (const a of root.getAnimations()) a.finish();
          }, kind === 'finished closed');
        maps.push(await captureStyleMap(page, { captureVisualChannels: true, captureStates: false }));
      }
      for (const map of maps)
        expect(Object.values(map.visualChannels!.keyframes).find((k) => k.name === 'pulse')?.status).toBe('known');
      expect(changes(maps)).toHaveLength(1);
    });
}

{
  const options = { captureVisualChannels: true, captureStates: false };

  for (const inherited of [false, true])
    test(`unstabilized global motion holds custom-property models (${inherited ? 'ancestor' : 'self'})`, async ({
      page,
    }) => {
      const maps = [];
      for (const time of [0, 300, 900]) {
        await page.setContent(
          `<style>@property --x{syntax:'<length>';inherits:true;initial-value:0px}@keyframes custom{from{--x:10px}to{--x:20px}}@keyframes pulse{to{margin-left:var(--x)}}${inherited ? '.parent{animation:custom 1s linear infinite paused}.a{animation:pulse 1s linear infinite paused}' : '.a{animation:custom 1s linear infinite paused,pulse 1s linear infinite paused}'}</style><div class=parent><div class=a>x</div></div>`,
        );
        await page.evaluate((time) => {
          for (const a of document.getAnimations()) a.currentTime = time;
        }, time);
        const map = await captureStyleMap(page, { ...options, stabilize: false });
        maps.push(map);
        expect(Object.values(map.visualChannels!.keyframes).find((body) => body.name === 'pulse')?.status).toBe(
          'unknown',
        );
      }
      expect(maps[0].visualChannels).toEqual(maps[2].visualChannels);
    });

  test('unstabilized global motion holds a variable consumer with an opaque ancestor', async ({ page }) => {
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
    const map = await captureStyleMap(page, { ...options, stabilize: false });
    expect(Object.values(map.visualChannels!.keyframes).find((body) => body.name === 'pulse')?.status).toBe('unknown');
  });

  test('a surviving paused Web Animation holds keyframe bodies unknown', async ({ page }) => {
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
      expect(Object.values(map.visualChannels!.keyframes).find((body) => body.name === 'pulse')?.status).toBe(
        'unknown',
      );
    }
    expect(evidence[0]).toEqual(evidence[1]);
  });
}

{
  const options = { captureVisualChannels: true, captureStates: false, stabilize: false };

  const cases = [
    [
      'em-parent',
      '@keyframes drive{from{font-size:10px}to{font-size:30px}}@keyframes pulse{to{margin-left:2em}}.p{animation:drive 1s linear infinite paused}.a{animation:pulse 1s linear infinite paused}',
      false,
    ],
    [
      'em-self',
      '@keyframes drive{from{font-size:10px}to{font-size:30px}}@keyframes pulse{to{margin-left:2em}}.a{animation:drive 1s linear infinite paused,pulse 1s linear infinite paused}',
      false,
    ],
    [
      'currentColor-parent',
      '@keyframes drive{from{color:red}to{color:blue}}@keyframes pulse{to{outline:2px solid currentColor}}.p{animation:drive 1s linear infinite paused}.a{animation:pulse 1s linear infinite paused}',
      false,
    ],
    [
      'color-explicit',
      '@keyframes drive{from{color:red}to{color:blue}}@keyframes pulse{from{border-color:currentColor}to{border-color:currentColor}}.a{animation:drive 1s linear infinite paused,pulse 1s linear infinite paused}',
      false,
    ],
    [
      'paused-transition',
      '@keyframes pulse{to{margin-left:2em}}.p{font-size:10px;transition:font-size 1s linear}.p.on{font-size:30px}.a{animation:pulse 1s linear infinite paused}',
      true,
    ],
  ] as const;

  for (const [label, css, transition] of cases)
    test(`unstabilized global motion holds bodies unknown: ${label}`, async ({ page }) => {
      const maps = [];
      for (const time of [100, 900]) {
        await page.goto('about:blank');
        await page.setContent(`<style>${css}</style><div class=p><div class=a>x</div></div>`);
        await page.evaluate(
          ({ time, transition }) => {
            const p = document.querySelector('.p')!;
            if (transition) {
              void getComputedStyle(p).fontSize;
              p.classList.add('on');
              void getComputedStyle(p).fontSize;
              if (!document.getAnimations().some((a) => a instanceof CSSTransition))
                throw new Error('fixture must create a live font-size transition');
            }
            for (const a of document.getAnimations()) {
              a.pause();
              a.currentTime = time;
            }
          },
          { time, transition },
        );
        maps.push(await captureStyleMap(page, options));
      }
      for (const map of maps)
        expect(Object.values(map.visualChannels!.keyframes).find((k) => k.name === 'pulse')?.status).toBe('unknown');
      expect(() => assertDeterministicVisualChannels(maps[0], maps[1], label)).not.toThrow();
      expect(
        diffStyleMaps(maps[0], maps[1])
          .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
          .filter((p) => p.prop === 'animation keyframes (pulse)'),
      ).toEqual([]);
    });

  for (const pseudo of ['before', 'after', 'marker'])
    for (const important of [false, true])
      test(`unstabilized pseudo motion holds bodies unknown: ${pseudo} (important=${important})`, async ({ page }) => {
        const maps = [];
        for (const time of [0, 900]) {
          const rule = `.a::${pseudo}{content:'x';animation:custom 1s linear infinite paused,pulse 1s linear infinite paused${important ? '!important' : ''}}`;
          await page.setContent(
            `<style>@property --x{syntax:'<length>';inherits:true;initial-value:0px}@keyframes custom{from{--x:10px}to{--x:20px}}@keyframes pulse{to{margin-left:var(--x)}}${important ? '@layer locked{' + rule + '}' : rule}</style><ul><li class=a>x</li></ul>`,
          );
          await page.evaluate((time) => {
            for (const a of document.getAnimations()) {
              a.pause();
              a.currentTime = time;
            }
          }, time);
          maps.push(await captureStyleMap(page, options));
        }
        for (const map of maps)
          expect(Object.values(map.visualChannels!.keyframes).find((k) => k.name === 'pulse')?.status).toBe('unknown');
        expect(() => assertDeterministicVisualChannels(maps[0], maps[1], pseudo)).not.toThrow();
      });

  for (const stabilize of [false, true])
    for (const property of ['color', 'font-size'])
      test(`running ${property} transition is clean with stabilize=${stabilize}`, async ({ page }) => {
        const maps = [];
        for (const delay of [100, 900]) {
          const style =
            property === 'color'
              ? '@keyframes pulse{to{outline:2px solid currentColor}}.p{color:red;transition:color 3s linear}.p.dark{color:blue}'
              : '@keyframes pulse{to{margin-left:2em}}.p{font-size:10px;transition:font-size 3s linear}.p.dark{font-size:30px}';
          await page.goto('about:blank');
          await page.setContent(
            `<style>${style}.a{animation:pulse 1s linear infinite}</style><div class=p><div class=a>x</div></div>`,
          );
          await page.evaluate((property) => {
            const p = document.querySelector('.p')!;
            void getComputedStyle(p).getPropertyValue(property);
            p.classList.add('dark');
            void getComputedStyle(p).getPropertyValue(property);
            if (!document.getAnimations().some((a) => a instanceof CSSTransition))
              throw new Error('fixture must create a live transition');
          }, property);
          await page.waitForTimeout(delay);
          maps.push(await captureStyleMap(page, { ...options, stabilize }));
        }
        expect(
          diffStyleMaps(maps[0], maps[1])
            .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
            .filter((p) => p.prop === 'animation keyframes (pulse)'),
        ).toEqual([]);
        expect(() => assertDeterministicVisualChannels(maps[0], maps[1], 'theme')).not.toThrow();
        if (!stabilize)
          for (const map of maps)
            expect(Object.values(map.visualChannels!.keyframes).find((k) => k.name === 'pulse')?.status).toBe(
              'unknown',
            );
      });

  test('stabilized relative and fixed explicit bodies remain compared', async ({ page }) => {
    for (const [a, b] of [
      ['2em', '3em'],
      ['20px', '30px'],
    ]) {
      const maps = [];
      for (const value of [a, b]) {
        await page.setContent(
          `<style>@keyframes pulse{from{margin-left:0px}to{margin-left:${value}}}.a{animation:pulse 1s infinite paused}</style><div class=a>x</div>`,
        );
        maps.push(await captureStyleMap(page, { ...options, stabilize: true }));
      }
      expect(
        diffStyleMaps(maps[0], maps[1])
          .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
          .some((p) => p.prop === 'animation keyframes (pulse)'),
      ).toBe(true);
    }
  });
}

{
  const cases = [
    [
      'self-em',
      '@keyframes pulse{from{font-size:10px;margin-left:2em}to{font-size:30px;margin-left:2em}}.a{animation:pulse 1s linear infinite paused}',
      '<div class=a>x</div>',
    ],
    [
      'self-currentcolor',
      '@keyframes pulse{from{color:red;border-color:currentColor}to{color:blue;border-color:currentColor}}.a{animation:pulse 1s linear infinite paused}',
      '<div class=a>x</div>',
    ],
    [
      'sibling-cqw',
      'section{display:flex;width:800px}.p{flex:1;min-width:0;container-type:inline-size}.s{flex:none;animation:drive 1s linear infinite paused}@keyframes drive{from{width:100px}to{width:500px}}@keyframes pulse{from{margin-left:1cqw}to{margin-left:20cqw}}.a{animation:pulse 1s linear infinite paused}',
      '<section><div class=s>s</div><div class=p><div class=a>x</div></div></section>',
    ],
  ] as const;

  for (const [name, css, body] of cases)
    test(`${name} has no progress-dependent known body`, async ({ page }) => {
      const maps = [];
      for (const time of [0, 900]) {
        await page.goto('about:blank');
        await page.setContent(`<style>${css}</style>${body}`);
        await page.evaluate((time) => {
          for (const a of document.getAnimations()) {
            a.pause();
            a.currentTime = time;
          }
        }, time);
        maps.push(await captureStyleMap(page, { captureVisualChannels: true, captureStates: false, stabilize: false }));
      }
      for (const map of maps)
        expect(Object.values(map.visualChannels!.keyframes).find((k) => k.name === 'pulse')?.status).toBe('unknown');
      expect(() => assertDeterministicVisualChannels(maps[0], maps[1], name)).not.toThrow();
      expect(
        diffStyleMaps(maps[0], maps[1])
          .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
          .filter((p) => p.prop.includes('keyframes')),
      ).toEqual([]);
    });

  for (const stabilize of [true, false])
    test(`nothing in progress: em, currentColor and var stay known with stabilize=${stabilize}`, async ({ page }) => {
      for (const body of [
        (v: number) => `from{margin-left:1em}to{margin-left:${v}em}`,
        (v: number) =>
          `from{border-color:currentColor;border-width:1px}to{border-color:currentColor;border-width:${v}px}`,
        (v: number) => `from{margin-left:var(--distance)}to{margin-left:calc(var(--distance)*${v})}`,
      ]) {
        const maps = [];
        for (const version of [2, 3]) {
          await page.goto('about:blank');
          await page.setContent(
            `<style>:root{--distance:12px}.a{font-size:16px;color:blue;animation:pulse 1ms forwards}@keyframes pulse{${body(version)}}</style><div class=a>x</div>`,
          );
          await page.evaluate(() => {
            for (const a of document.getAnimations()) a.finish();
          });
          expect(
            await page.evaluate(() =>
              document.getAnimations().some((a) => ['running', 'paused'].includes(a.playState)),
            ),
          ).toBe(false);
          const map = await captureStyleMap(page, { captureVisualChannels: true, captureStates: false, stabilize });
          expect(Object.values(map.visualChannels!.keyframes).find((k) => k.name === 'pulse')?.status).toBe('known');
          maps.push(map);
        }
        expect(
          diffStyleMaps(maps[0], maps[1])
            .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
            .some((p) => p.prop === 'animation keyframes (pulse)'),
        ).toBe(true);
      }
    });

  test('unstabilized live motion holds even absolute and implicit-colour bodies unknown', async ({ page }) => {
    await page.setContent(
      '<style>@keyframes pixels{from{margin-left:0px}to{margin-left:20px}}@keyframes colour{to{text-shadow:0 0 3px}}.a{animation:pixels 1s infinite paused}.b{animation:colour 1s infinite paused}</style><div class=a>x</div><div class=b>y</div>',
    );
    const map = await captureStyleMap(page, { captureVisualChannels: true, captureStates: false, stabilize: false });
    expect(Object.values(map.visualChannels!.keyframes).map((k) => k.status)).toEqual(['unknown', 'unknown']);
  });

  test('finished entrance wrapper preserves all four Tailwind body changes in default mode', async ({ page }) => {
    const maps = [];
    for (const v of [360, 350]) {
      await page.goto('about:blank');
      await page.setContent(
        `<style>@keyframes spin{to{transform:rotate(${v}deg)}}@keyframes ping{75%,100%{transform:scale(${v / 180});opacity:0}}@keyframes pulse{50%{opacity:${v / 720}}}@keyframes bounce{0%,100%{transform:translateY(-${v / 15}%);animation-timing-function:cubic-bezier(.8,0,1,1)}50%{transform:none;animation-timing-function:cubic-bezier(0,0,.2,1)}}@keyframes enter{from{opacity:0}to{opacity:1}}.page{animation:enter .1s both}.spin{animation:spin 1s linear infinite}.ping{animation:ping 1s infinite}.pulse{animation:pulse 2s infinite}.bounce{animation:bounce 1s infinite}</style><div class=page><div class=spin>s</div><div class=ping>p</div><div class=pulse>u</div><div class=bounce>b</div></div>`,
      );
      await page.waitForTimeout(400);
      expect(await page.evaluate(() => document.querySelector('.page')!.getAnimations()[0].playState)).toBe('finished');
      maps.push(await captureStyleMap(page, { captureVisualChannels: true, captureStates: false }));
    }
    for (const map of maps)
      expect(Object.values(map.visualChannels!.keyframes).every((k) => k.status === 'known')).toBe(true);
    const changes = diffStyleMaps(maps[0], maps[1])
      .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
      .filter((p) => p.prop.includes('keyframes') && !p.prop.includes('enter'));
    expect(changes).toHaveLength(4);
  });

  test('a genuinely surviving inline-important CSS effect stays unknown in default mode', async ({ page }) => {
    const maps = [];
    for (const time of [0, 900]) {
      await page.goto('about:blank');
      await page.setContent(
        '<style>@keyframes pulse{from{font-size:10px;margin-left:2em}to{font-size:30px;margin-left:2em}}</style><div style="animation:pulse 1s linear infinite paused!important">x</div>',
      );
      await page.evaluate((time) => {
        for (const a of document.getAnimations()) a.currentTime = time;
      }, time);
      maps.push(await captureStyleMap(page, { captureVisualChannels: true, captureStates: false }));
    }
    for (const map of maps)
      expect(Object.values(map.visualChannels!.keyframes).every((k) => k.status === 'unknown')).toBe(true);
    expect(() => assertDeterministicVisualChannels(maps[0], maps[1], 'surviving CSS')).not.toThrow();
  });
}
