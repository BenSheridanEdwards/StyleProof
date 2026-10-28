import { expect, test, type CDPSession, type JSHandle, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { mock } from 'node:test';
import { captureStyleMap } from '../dist/index.js';

type Command = { method: string; params?: Record<string, unknown> };
type Forward = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

// Observe the real session, never replace the browser's styles with canned results.
async function observeSession<T>(
  page: Page,
  commands: Command[],
  intercept: (command: Command, forward: Forward) => Promise<unknown>,
  run: () => Promise<T>,
): Promise<T> {
  const context = page.context();
  const descriptor = Object.getOwnPropertyDescriptor(context, 'newCDPSession');
  const create = context.newCDPSession.bind(context);
  Object.defineProperty(context, 'newCDPSession', {
    configurable: true,
    value: async (...args: Parameters<typeof create>) => {
      const session = await create(...args);
      const forward = session.send.bind(session) as unknown as Forward;
      const detach = session.detach.bind(session);
      session.send = ((method: string, params?: Record<string, unknown>) => {
        const command = { method, params };
        commands.push(command);
        return intercept(command, forward);
      }) as CDPSession['send'];
      session.detach = async () => {
        commands.push({ method: 'detach' });
        return detach();
      };
      return session;
    },
  });
  try {
    return await run();
  } finally {
    if (descriptor) Object.defineProperty(context, 'newCDPSession', descriptor);
    else Reflect.deleteProperty(context, 'newCDPSession');
  }
}

const TARGETS = 4;
function fixture(ancestor: boolean): string {
  return `<!doctype html><html><head><style>
    button { color: rgb(10, 20, 30); outline: 0; }
    button:hover span { color: rgb(100, 110, 120); }
    button:focus { border-color: rgb(30, 40, 50); }
    button:focus-visible { outline: 3px solid rgb(60, 70, 80); }
    button:active { background: rgb(90, 100, 110); }
    button:hover + output { color: rgb(120, 130, 140); }
    ${ancestor ? 'section:has(button:hover) { border: 2px solid rgb(150, 160, 170); }' : ''}
  </style></head><body>${Array.from(
    { length: TARGETS },
    (_, i) => `<section><button><span>Choice ${i}</span></button><output>Ready</output></section>`,
  ).join('')}</body></html>`;
}

async function restingStyles(page: Page, originals: JSHandle<Element[]>) {
  return page.evaluate((nodes) => {
    // Only the engine's explicit hover sink is infrastructure. Added, replaced,
    // reordered or missing fixture nodes must still fail the equality check.
    return [...document.querySelectorAll('body *')]
      .filter((element) => !element.hasAttribute('data-styleproof-hover-sink'))
      .map((element) => {
        const style = getComputedStyle(element);
        return {
          identity: nodes.indexOf(element),
          tag: element.tagName,
          styles: [style.color, style.backgroundColor, style.borderColor, style.borderWidth, style.outline],
        };
      });
  }, originals);
}

async function saveEvidence(testInfo: TestInfo, name: string, data: unknown) {
  const path = testInfo.outputPath(`${name}.json`);
  await writeFile(path, JSON.stringify(data, null, 2));
  await testInfo.attach(name, { path, contentType: 'application/json' });
}

async function expectClean(page: Page, commands: Command[]) {
  expect(commands.filter(({ method }) => method === 'detach')).toHaveLength(1);
  expect(await page.locator('[data-styleproof-hover-sink]').count()).toBe(1);
  expect(await page.locator('[data-styleproof-state-id]').count()).toBe(0);
  expect(
    await page.evaluate(() => Object.keys(window).filter((key) => key.startsWith('__spForcedStateBaseline'))),
  ).toEqual([]);
}

for (const mode of ['document', 'stylesheet', 'fallback'] as const) {
  test(`coalesces pre-read barriers without dropping state coverage: ${mode}`, async ({ page }, testInfo) => {
    await page.setContent(fixture(mode === 'fallback'));
    const originals = await page.evaluateHandle(() => [...document.querySelectorAll('body *')]);
    const rest = await restingStyles(page, originals);
    expect(rest.map(({ identity }) => identity)).toEqual(Array.from({ length: TARGETS * 4 }, (_, i) => i));
    const commands: Command[] = [];
    const start = performance.now();
    const map = await observeSession(
      page,
      commands,
      (call, forward) => forward(call.method, call.params),
      () =>
        captureStyleMap(page, { stabilize: false, forcedStateScope: mode === 'document' ? 'document' : 'stylesheet' }),
    );
    const elapsedMs = performance.now() - start;
    const evaluates = commands.filter(({ method }) => method === 'Runtime.evaluate').length;
    const forces = commands.filter(({ method }) => method === 'CSS.forcePseudoState');
    const after = await restingStyles(page, originals);
    await saveEvidence(testInfo, 'map', map);
    await saveEvidence(testInfo, 'commands', { elapsedMs, evaluates, commands, rest, after });
    expect(map.statesSkipped).toBeFalsy();
    expect(Object.keys(map.states)).toHaveLength(TARGETS);
    for (const states of Object.values(map.states)) {
      expect(Object.keys(states)).toEqual(['hover', 'focus', 'active']);
      expect(Object.values(states.hover).some((props) => props.color === 'rgb(100, 110, 120)')).toBe(true);
      expect(Object.values(states.hover).some((props) => props.color === 'rgb(120, 130, 140)')).toBe(true);
      expect(Object.values(states.focus).some((props) => props['outline-color'] === 'rgb(60, 70, 80)')).toBe(true);
      expect(Object.values(states.focus).some((props) => props['border-top-color'] === 'rgb(30, 40, 50)')).toBe(true);
      expect(Object.values(states.active).some((props) => props['background-color'] === 'rgb(90, 100, 110)')).toBe(
        true,
      );
      if (mode === 'fallback')
        expect(Object.values(states.hover).some((props) => props['border-top-color'] === 'rgb(150, 160, 170)')).toBe(
          true,
        );
    }
    // One installed snapshot, four evaluations per target (baseline and three
    // states), one final reset barrier, plus shared save/check for document reads.

    const sharedBaseline = mode !== 'stylesheet';
    expect(evaluates).toBe(1 + TARGETS * 4 + 1 + (sharedBaseline ? 2 : 0));
    expect(commands.map(({ method }) => method)).toEqual([
      'DOM.enable',
      'CSS.enable',
      'DOM.getDocument',
      'Runtime.evaluate',
      ...(sharedBaseline ? ['Runtime.evaluate'] : []),
      ...Array(TARGETS).fill('DOM.querySelectorAll'),
      ...Array.from({ length: TARGETS }, () => [
        'Runtime.evaluate',
        'CSS.forcePseudoState',
        'Runtime.evaluate',
        'CSS.forcePseudoState',
        'Runtime.evaluate',
        'CSS.forcePseudoState',
        'Runtime.evaluate',
        'CSS.forcePseudoState',
      ]).flat(),
      'Runtime.evaluate',
      ...(sharedBaseline ? ['Runtime.evaluate'] : []),
      'detach',
    ]);
    expect(forces.map(({ params }) => params?.forcedPseudoClasses)).toEqual(
      Array.from({ length: TARGETS }, () => [['hover'], ['focus', 'focus-visible'], ['active'], []]).flat(),
    );
    await expectClean(page, commands);
    expect(after).toEqual(rest);
    await originals.dispose();
  });
}

test('subtree scope shares one resting baseline: call sequence', async ({ page }) => {
  // Keep four targets, including an ancestor/descendant pair. Use independent
  // longhands so the complete expected deltas do not depend on UA border defaults.
  const html = fixture(false)
    .replace('button:hover + output { color: rgb(120, 130, 140); }', '')
    .replace('button { color:', 'button { border-style: solid; color:')
    .replace('button:hover span { color:', 'button:hover span { background-color:')
    .replace('button:focus { border-color:', 'button:focus { border-top-color:')
    .replace('outline: 3px solid rgb(60, 70, 80)', 'outline-color: rgb(60, 70, 80)')
    .replace(/<section><button><span>Choice [23]<\/span><\/button><output>Ready<\/output><\/section>/g, '')
    .replace('</body>', '<section><a href="#nested"><button><span>Nested</span></button></a></section></body>')
    .replace(
      '</style>',
      `
      a, a:focus-visible { outline: 0; color: rgb(10, 20, 30); }
      a:hover { background-color: rgb(180, 190, 200); }
      a:focus { background-color: rgb(150, 160, 170); }
      a:active { background-color: rgb(210, 220, 230); }
    </style>`,
    );

  await page.setContent(html);
  const originals = await page.evaluateHandle(() => [...document.querySelectorAll('body *')]);

  try {
    const rest = await restingStyles(page, originals);
    const commands: Command[] = [];

    const map = await observeSession(
      page,
      commands,
      (call, forward) => forward(call.method, call.params),
      () => captureStyleMap(page, { forcedStateScope: 'stylesheet' }),
    );

    expect(map.statesSkipped).toBeFalsy();
    const link = 'body > section:nth-child(3) > a:sp-key(2nfcss)';

    const buttons = [
      'body > section:nth-child(1) > button:nth-child(1)',
      'body > section:nth-child(2) > button:nth-child(1)',
      `${link} > button:nth-child(1)`,
    ];

    const expected: typeof map.states = Object.fromEntries(
      buttons.map((button) => [
        button,
        {
          hover: { [`${button} > span:nth-child(1)`]: { 'background-color': 'rgb(100, 110, 120)' } },
          focus: {
            [button]: {
              'border-top-color': 'rgb(30, 40, 50)',
              'border-block-start-color': 'rgb(30, 40, 50)',
              'outline-color': 'rgb(60, 70, 80)',
            },
          },
          active: { [button]: { 'background-color': 'rgb(90, 100, 110)' } },
        },
      ]),
    );

    expected[link] = {
      hover: { [link]: { 'background-color': 'rgb(180, 190, 200)' } },
      focus: { [link]: { 'background-color': 'rgb(150, 160, 170)', 'outline-offset': '1px' } },
      active: { [link]: { 'background-color': 'rgb(210, 220, 230)' } },
    };
    expect(map.states).toEqual(expected);
    expect(Object.keys(map.states)).toEqual([buttons[0], buttons[1], link, buttons[2]]);
    expect(commands.map(({ method }) => method)).toEqual([
      'DOM.enable',
      'CSS.enable',
      'DOM.getDocument',
      'Runtime.evaluate',
      'Runtime.evaluate',
      ...Array(TARGETS).fill('DOM.querySelectorAll'),
      ...Array.from({ length: TARGETS }, () => [
        'CSS.forcePseudoState',
        'Runtime.evaluate',
        'CSS.forcePseudoState',
        'Runtime.evaluate',
        'CSS.forcePseudoState',
        'Runtime.evaluate',
        'CSS.forcePseudoState',
      ]).flat(),
      'Runtime.evaluate',
      'Runtime.evaluate',
      'detach',
    ]);
    expect(
      commands.flatMap(({ method, params }) =>
        method === 'CSS.forcePseudoState' ? [params?.forcedPseudoClasses] : [],
      ),
    ).toEqual(Array.from({ length: TARGETS }, () => [['hover'], ['focus', 'focus-visible'], ['active'], []]).flat());
    expect(await restingStyles(page, originals)).toEqual(rest);
    await expectClean(page, commands);
  } finally {
    await originals.dispose();
  }
});

for (const which of ['first', 'last'] as const) {
  test(`a target removed after its reset is warned, uncertified and loses only its active delta: ${which}`, async ({
    page,
  }) => {
    await page.setContent(fixture(false));
    const index = which === 'first' ? 0 : TARGETS - 1;
    const removed = `body > section:nth-child(${index + 1}) > button:nth-child(1)`;
    const warnings: string[] = [];
    const warningSpy = mock.method(console, 'warn', (message: string) => warnings.push(message));

    let resets = 0;

    try {
      const map = await observeSession(
        page,
        [],
        async (call, forward) => {
          const result = await forward(call.method, call.params);
          const classes = call.params?.forcedPseudoClasses;

          if (call.method === 'CSS.forcePseudoState' && Array.isArray(classes) && classes.length === 0) {
            if (resets++ === index) await page.evaluate((i) => document.querySelectorAll('section')[i].remove(), index);
          }

          return result;
        },
        () => captureStyleMap(page, { stabilize: false, forcedStateScope: 'stylesheet' }),
      );

      expect(map.statesSkipped).toBe(true);
      expect(map.stateComputedValueStyle).toBeUndefined();
      expect(Object.keys(map.states)).toHaveLength(TARGETS);
      expect(Object.keys(map.states[removed])).toEqual(['hover', 'focus']);

      for (const [path, states] of Object.entries(map.states)) {
        if (path !== removed) expect(Object.keys(states)).toEqual(['hover', 'focus', 'active']);
      }

      expect(warnings).toEqual([
        `styleproof: interactive element sp-${index} detached while resetting forced state; skipping it.`,
      ]);
    } finally {
      warningSpy.mock.restore();
    }
  });
}

test('deferred active commits keep states key order', async ({ page }) => {
  await page.setContent(`<!doctype html><html><head><style>
    button { all: initial; display: block; background-color: rgb(1, 2, 3); }
    .a:active, .c:active { background-color: rgb(10, 20, 30); }
    .b:hover { background-color: rgb(40, 50, 60); }
  </style></head><body><button class="a">A</button><button class="b">B</button><button class="c">C</button></body></html>`);
  const a = 'body > button:nth-child(1)';
  const b = 'body > button:nth-child(2)';
  const c = 'body > button:nth-child(3)';
  const map = await captureStyleMap(page, { stabilize: false, forcedStateScope: 'stylesheet' });
  expect(map.statesSkipped).toBeFalsy();
  expect(Object.keys(map.states)).toEqual([a, b, c]);
  expect(map.states).toEqual({
    [a]: { active: { [a]: { 'background-color': 'rgb(10, 20, 30)' } } },
    [b]: { hover: { [b]: { 'background-color': 'rgb(40, 50, 60)' } } },
    [c]: { active: { [c]: { 'background-color': 'rgb(10, 20, 30)' } } },
  });
});

test('forced-state output matches the pre-change deltas for sibling, focus-visible, active and :has rules', async ({
  page,
}) => {
  const html = `<!doctype html><html><head><style>
    section, button, output { all: initial; display: block; background-color: rgb(1, 2, 3); }
    button { outline: 2px solid rgb(4, 5, 6); outline-offset: 0; }
    button:hover { background-color: rgb(10, 20, 30); }
    button:hover ~ output { background-color: rgb(40, 50, 60); }
    section:has(button:hover) { background-color: rgb(70, 80, 90); }
    button:focus-visible { outline-color: rgb(100, 110, 120); }
    button:active { background-color: rgb(130, 140, 150); }
    button:hover:focus-visible { background-color: rgb(200, 0, 0); }
  </style></head><body>${'<section><button>Control</button><output>Ready</output></section>'.repeat(3)}</body></html>`;

  // Each rule changes one non-inherited longhand. These are the complete deltas
  // from forcing each state from rest in the pre-change algorithm.
  const expected = Object.fromEntries(
    [1, 2, 3].map((index) => {
      const parent = `body > section:nth-child(${index})`;
      const button = `${parent} > button:nth-child(1)`;
      const sibling = `${parent} > output:nth-child(2)`;

      return [
        button,
        {
          hover: {
            [button]: { 'background-color': 'rgb(10, 20, 30)' },
            [parent]: { 'background-color': 'rgb(70, 80, 90)' },
            [sibling]: { 'background-color': 'rgb(40, 50, 60)' },
          },
          focus: { [button]: { 'outline-color': 'rgb(100, 110, 120)' } },
          active: { [button]: { 'background-color': 'rgb(130, 140, 150)' } },
        },
      ];
    }),
  );

  for (const forcedStateScope of ['document', 'stylesheet'] as const) {
    await page.setContent(html);
    const map = await captureStyleMap(page, { stabilize: false, forcedStateScope });
    expect(map.statesSkipped).toBeFalsy();
    expect(map.states).toEqual(expected);
    expect(await page.locator('[data-styleproof-state-id]').count()).toBe(0);
  }
});

for (const fault of ['removed', 'snapshot-error'] as const) {
  test(`cleans the applied state when the pre-read target is ${fault}`, async ({ page }, testInfo) => {
    await page.setContent(fixture(false));
    const originals = await page.evaluateHandle(() => [...document.querySelectorAll('body *')]);
    const rest = await restingStyles(page, originals);
    expect(rest.map(({ identity }) => identity)).toEqual(Array.from({ length: TARGETS * 4 }, (_, i) => i));
    const commands: Command[] = [];
    let injected = false;
    const run = () =>
      observeSession(
        page,
        commands,
        async (call, forward) => {
          const result = await forward(call.method, call.params);
          if (
            !injected &&
            call.method === 'CSS.forcePseudoState' &&
            (call.params?.forcedPseudoClasses as string[])?.length
          ) {
            injected = true;
            await page.evaluate((mode) => {
              if (mode === 'removed') document.querySelector('button')!.remove();
              else
                Object.defineProperty(window, '__spPathOf', {
                  configurable: true,
                  value: () => {
                    throw new Error('deliberate snapshot failure');
                  },
                });
            }, fault);
          }
          return result;
        },
        () => captureStyleMap(page, { stabilize: false }),
      );
    const start = performance.now();
    try {
      if (fault === 'removed') {
        const map = await run();
        await saveEvidence(testInfo, 'map', map);
        expect(map.statesSkipped).toBe(true);
        expect(Object.keys(map.states)).toHaveLength(TARGETS - 1);
      } else {
        await expect(run()).rejects.toThrow('forced-state snapshot failed');
      }
    } finally {
      await saveEvidence(testInfo, 'commands', {
        elapsedMs: performance.now() - start,
        evaluates: commands.filter(({ method }) => method === 'Runtime.evaluate').length,
        commands,
        rest,
        after: await restingStyles(page, originals),
      });
    }
    // Removal deliberately removes exactly the first button and its span.
    const expectedRest = fault === 'removed' ? rest.filter(({ identity }) => identity !== 1 && identity !== 2) : rest;
    expect(await restingStyles(page, originals)).toEqual(expectedRest);
    await originals.dispose();
    expect(injected).toBe(true);
    expect(
      commands.some(
        ({ method, params }) =>
          method === 'CSS.forcePseudoState' && (params?.forcedPseudoClasses as string[])?.length === 0,
      ),
    ).toBe(true);
    await expectClean(page, commands);
  });
}
