import { test, expect, type Page } from '@playwright/test';
import { captureStyleMap } from '../dist/capture.js';
import fs from 'node:fs';
import { diffStyleMaps } from '../dist/diff.js';
import { generateStyleMapReport } from '../dist/index.js';
import { pairFixture, rmTmp } from './helpers.mjs';
import { assertDeterministicVisualChannels } from '../dist/visual-channels.js';

// Fixture blocks isolate helper state; the test bodies and matrices are unchanged.
{
  for (const stabilize of [false, true])
    test(`a new inert subtree subscribes before it gains a closed-root child; stabilize=${stabilize}`, async ({
      page,
    }) => {
      const context = page.context(),
        native = context.newCDPSession.bind(context);
      let inserted = false;
      context.newCDPSession = async (...args) => {
        const client = await native(...args),
          send = client.send.bind(client);
        client.send = async (method, params) => {
          if (
            !inserted &&
            method === 'Runtime.evaluate' &&
            (params as { expression?: string })?.expression?.includes('window.__spChannelRequests()')
          ) {
            inserted = true;
            await page.evaluate(() => document.querySelector('#target')!.append(document.createElement('i')));
            await send('Runtime.evaluate', { expression: '0' });
            await page.evaluate(() => {
              const host = document.createElement('x-late');
              const root = host.attachShadow({ mode: 'closed' });
              root.innerHTML =
                '<style>@keyframes drive{to{width:500px}}div{animation:drive 1s linear infinite paused}</style><div>x</div>';
              document.querySelector('i')!.append(host);
              root.getAnimations()[0].currentTime = 500;
            });
            await send('Runtime.evaluate', { expression: '0' });
          }
          return send(method, params);
        };
        return client;
      };
      try {
        await page.setContent(
          '<style>@keyframes k{to{opacity:.5}}.k{animation:k 1s linear 100s paused both}</style><div class=k>x</div><main id=target></main>',
        );
        const map = await captureStyleMap(page, { captureVisualChannels: true, captureStates: false, stabilize });
        expect(inserted).toBe(true);
        expect(Object.values(map.visualChannels!.keyframes).find((k) => k.name === 'k')?.status).toBe('unknown');
      } finally {
        context.newCDPSession = native;
      }
    });
}

{
  // Canonical/source comparisons use settling; unstabilized relative models have document-wide limits.
  const options = { captureVisualChannels: true, captureStates: false };

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

  for (const shadowFirst of [false, true]) {
    test(`definite absence and unknown scope have distinct references (shadow first: ${shadowFirst})`, async ({
      page,
    }) => {
      const absent = '<div class="absent">absent</div>';
      const shadow = '<x-scope><span>slotted</span></x-scope>';
      const map = await capture(
        page,
        `<style>.absent{animation:deep 1s infinite}</style>${shadowFirst ? shadow + absent : absent + shadow}<script>
      customElements.define('x-scope', class extends HTMLElement { constructor(){ super(); this.attachShadow({mode:'open'}).innerHTML = '<style>@keyframes deep{to{opacity:.5}} ::slotted(*){animation:deep 1s infinite}</style><slot></slot>'; } });
    </script>`,
      );
      const absentElement = Object.values(map.elements).find((element) => element.cls === 'absent')!;
      const slotted = Object.values(map.elements).find((element) => element.tag === 'span')!;
      expect(map.visualChannels!.keyframes[absentElement.style['animation keyframes (deep)']].status).toBe('none');
      expect(map.visualChannels!.keyframes[slotted.style['animation keyframes (deep)']].status).toBe('unknown');
      expect(report(map, map)).toContain('unknown; not compared');
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

  const changes = (a: Awaited<ReturnType<typeof capture>>, b: Awaited<ReturnType<typeof capture>>) =>
    diffStyleMaps(a, b).flatMap((f) => (f.kind === 'dom' ? [] : f.props));

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
          expect(map.visualChannels!.keyframes[control.style['animation keyframes (deep)']].status).toBe('known');
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
}

{
  const unstable = { captureVisualChannels: true, captureStates: false, stabilize: false };

  const light =
    '<style>@keyframes pulse{from{margin-left:1cqw}to{margin-left:20cqw}}section{display:flex;width:800px}.p{flex:1;min-width:0;container-type:inline-size}.a{animation:pulse 1s linear 100s infinite paused both}</style>';

  const kf = (a: Awaited<ReturnType<typeof captureStyleMap>>, b: typeof a) =>
    diffStyleMaps(a, b)
      .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
      .filter((p) => p.prop.includes('keyframes'));

  for (const [name, mode, kind, nested, status] of [
    ['open width', 'open', 'width', false, 'unknown'],
    ['open font', 'open', 'font', false, 'unknown'],
    ['nested open', 'open', 'width', true, 'unknown'],
    ['closed width', 'closed', 'width', false, 'unknown'],
    ['closed static', 'closed', 'static', false, 'known'],
    ['static open control', 'open', 'static', false, 'known'],
    ['unreadable open', 'open', 'unreadable', false, 'unknown'],
  ] as const)
    test(`${name}: shadow liveness is conservative without tainting readable static roots`, async ({ page }) => {
      const maps = [];
      for (const time of [0, 900]) {
        await page.goto('about:blank');
        await page.setContent(light + '<section><div class=p><div class=a>x</div></div><x-host></x-host></section>');
        await page.evaluate(
          ({ time, mode, kind, nested }) => {
            let root = document.querySelector('x-host')!.attachShadow({ mode });
            if (nested) {
              root.innerHTML = '<x-inner></x-inner>';
              root = root.querySelector('x-inner')!.attachShadow({ mode: 'open' });
            }
            const property = kind === 'font' ? 'font-size' : 'width';
            root.innerHTML = `<style>@keyframes drive{from{${property}:100px}to{${property}:500px}}.g{height:10px;${kind === 'static' || kind === 'unreadable' ? 'width:300px' : 'animation:drive 1s linear infinite paused'}}</style><div class=g>t</div>`;
            for (const a of root.getAnimations()) {
              a.pause();
              a.currentTime = time;
            }
            if (kind === 'unreadable')
              root.getAnimations = () => {
                throw new Error('unreadable shadow animation list');
              };
          },
          { time, mode, kind, nested },
        );
        maps.push(await captureStyleMap(page, unstable));
      }
      for (const map of maps)
        expect(Object.values(map.visualChannels!.keyframes).find((k) => k.name === 'pulse')?.status).toBe(status);
      expect(kf(maps[0], maps[1])).toEqual([]);
      expect(() => assertDeterministicVisualChannels(maps[0], maps[1], name)).not.toThrow();
    });

  for (const mode of ['open', 'closed'] as const)
    for (const stabilize of [true, false])
      test(`QA finished light consumer: ${mode} shadow motion holds bodies with stabilize=${stabilize}`, async ({
        page,
      }) => {
        const maps = [];
        for (const time of [100, 900]) {
          await page.goto('about:blank');
          await page.setContent(
            light.replace('pulse 1s linear 100s infinite paused both', 'pulse 1ms forwards') +
              '<section><x-host></x-host><div class=p><div class=a>x</div></div></section>',
          );
          await page.evaluate(
            ({ mode, time }) => {
              for (const a of document.getAnimations()) a.finish();
              const root = document.querySelector('x-host')!.attachShadow({ mode });
              root.innerHTML =
                '<style>@keyframes drive{from{width:100px}to{width:500px}}div{animation:drive 1s linear infinite paused}</style><div>x</div>';
              root.getAnimations()[0].currentTime = time;
            },
            { mode, time },
          );
          maps.push(await captureStyleMap(page, { captureVisualChannels: true, captureStates: false, stabilize }));
        }
        for (const map of maps)
          expect(Object.values(map.visualChannels!.keyframes).find((k) => k.name === 'pulse')?.status).toBe('unknown');
        expect(kf(maps[0], maps[1])).toEqual([]);
        expect(() => assertDeterministicVisualChannels(maps[0], maps[1], 'QA shadow')).not.toThrow();
      });
}

{
  const kf = (maps: Awaited<ReturnType<typeof captureStyleMap>>[]) =>
    diffStyleMaps(maps[0], maps[1])
      .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
      .filter((p) => p.prop.includes('keyframes'));

  for (const mode of ['closed', 'open'] as const)
    for (const stabilize of [true, false])
      test(`late ${mode} shadow root is revalidated for forced states; stabilize=${stabilize}`, async ({ page }) => {
        const maps = [];
        for (const time of [100, 900]) {
          await page.goto('about:blank');
          await page.setContent(
            `<style>body{margin:0}section{display:flex;width:800px}x-drive{display:block;flex:none}.ct{flex:1;min-width:0;container-type:inline-size}@keyframes pulse{from{margin-left:1cqw}to{margin-left:20cqw}}button:hover .a{animation:pulse 1s linear 100s infinite paused both}</style><section><x-drive></x-drive><div class=ct><button><span class=a>x</span></button></div></section>`,
          );
          await page.evaluate(
            ({ mode, time }) => {
              new MutationObserver(() => {
                if (
                  !document.querySelector('[data-styleproof-state-id]') ||
                  document.querySelector('x-drive')!.hasAttribute('attached')
                )
                  return;
                const host = document.querySelector('x-drive')!;
                host.setAttribute('attached', '');
                const root = host.attachShadow({ mode });
                root.innerHTML =
                  '<style>@keyframes drive{from{width:100px}to{width:500px}}div{animation:drive 1s linear infinite paused}</style><div>x</div>';
                root.getAnimations()[0].currentTime = time;
              }).observe(document.documentElement, {
                subtree: true,
                attributes: true,
                attributeFilter: ['data-styleproof-state-id'],
              });
            },
            { mode, time },
          );
          maps.push(await captureStyleMap(page, { captureVisualChannels: true, stabilize }));
        }
        for (const map of maps)
          expect(
            Object.values(map.visualChannels!.keyframes)
              .filter((k) => k.name === 'pulse')
              .map((k) => k.status),
          ).toEqual(['unknown']);
        expect(kf(maps)).toEqual([]);
        expect(() => assertDeterministicVisualChannels(maps[0], maps[1], 'late root')).not.toThrow();
      });
}

{
  for (const mode of ['open', 'closed'] as const)
    for (const stabilize of [false, true])
      test(`${mode} root finishing during freeze retains entry motion only without stabilization=${stabilize}`, async ({
        page,
      }) => {
        const maps = [];
        for (const time of [100, 900]) {
          await page.goto('about:blank');
          await page.setContent(
            '<style>@keyframes pulse{from{margin-left:10px}to{margin-left:20px}}.a{animation:pulse 1s linear 100s paused both}</style><div class=a>x</div><x-drive></x-drive>',
          );
          const driver = await page.evaluateHandle(
            ({ mode, time }) => {
              const root = document.querySelector('x-drive')!.attachShadow({ mode });
              root.innerHTML =
                '<style>@keyframes d{from{width:100px}to{width:500px}}div{animation:d 1s linear paused both}</style><div>x</div>';
              const driver = root.getAnimations()[0];
              driver.currentTime = time;
              return driver;
            },
            { mode, time },
          );
          let finish: Promise<unknown> | undefined;
          maps.push(
            await captureStyleMap(page, {
              captureVisualChannels: true,
              captureStates: false,
              stabilize,
              onPhase(phase) {
                if (phase === 'settle')
                  finish = driver.evaluate((a) => {
                    a.finish();
                    return a.playState;
                  });
              },
            }),
          );
          expect(await finish).toBe('finished');
          await driver.dispose();
        }
        for (const map of maps)
          expect(Object.values(map.visualChannels!.keyframes).find((k) => k.name === 'pulse')?.status).toBe(
            stabilize ? 'known' : 'unknown',
          );
        expect(
          diffStyleMaps(maps[0], maps[1])
            .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
            .filter((p) => p.prop.includes('keyframes')),
        ).toEqual([]);
        expect(() => assertDeterministicVisualChannels(maps[0], maps[1], 'entry motion')).not.toThrow();
      });

  for (const entry of ['static', 'finished'] as const)
    test(`closed root ${entry} at entry keeps unstabilized models known and detects edits`, async ({ page }) => {
      const maps = [];
      for (const endpoint of [20, 30]) {
        await page.goto('about:blank');
        await page.setContent(
          `<style>@keyframes pulse{from{margin-left:10px}to{margin-left:${endpoint}px}}.a{animation:pulse 1s linear 100s paused both}</style><div class=a>x</div><x-drive></x-drive>`,
        );
        await page.evaluate((entry) => {
          const root = document.querySelector('x-drive')!.attachShadow({ mode: 'closed' });
          root.innerHTML =
            entry === 'static'
              ? '<div>x</div>'
              : '<style>@keyframes d{to{width:500px}}div{animation:d 1s paused both}</style><div>x</div>';
          for (const animation of root.getAnimations()) animation.finish();
        }, entry);
        maps.push(await captureStyleMap(page, { captureVisualChannels: true, captureStates: false, stabilize: false }));
      }
      for (const map of maps)
        expect(Object.values(map.visualChannels!.keyframes).find((k) => k.name === 'pulse')?.status).toBe('known');
      expect(
        diffStyleMaps(maps[0], maps[1])
          .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
          .filter((p) => p.prop.includes('keyframes')),
      ).toHaveLength(1);
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
}
