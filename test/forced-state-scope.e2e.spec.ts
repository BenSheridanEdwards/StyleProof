/* eslint-disable no-console -- these tests spy on capture-side warnings */
import { expect, test, type Page } from '@playwright/test';
import { captureStyleMap, type StyleMap } from '../dist/index.js';

// `forcedStateScope: 'stylesheet'` narrows each forced-state read to the elements the page's
// own state selectors can reach. It must capture exactly what a whole-document read captures,
// for a fraction of the work, and fall back to the document whenever it cannot bound a rule.

function board(cards: number, rules: string): string {
  const card = (index: number) =>
    `<article class="card"><h2>Agent ${index}</h2><p class="meta"><span>granted</span><span>live</span></p>` +
    `<button class="refresh"><span class="label">Refresh</span></button><a class="link" href="#c${index}">Open</a>` +
    `<ul>${'<li><span>chip</span></li>'.repeat(6)}</ul></article>`;
  return `<!doctype html><html><head><style>
    body { margin: 0; font: 14px sans-serif; }
    .card { padding: 8px; border: 1px solid rgb(40, 40, 40); }
    .refresh { color: rgb(10, 10, 10); }
    ${rules}
  </style></head><body><main>${Array.from({ length: cards }, (_, index) => card(index)).join('')}</main></body></html>`;
}

const DESCENDANT_RULES = `
  .refresh:hover { background: rgb(200, 0, 0); }
  .refresh:hover .label { color: rgb(0, 120, 0); }
  .refresh:focus-visible { outline: 2px solid rgb(0, 0, 200); }
  .link:active { color: rgb(120, 0, 120); }
  .card [data-kind~="x+y"] { color: rgb(1, 2, 3); }
  .hover\\:ring:hover { box-shadow: 0 0 0 1px rgb(9, 9, 9); }`;

async function capture(page: Page, html: string, options: Parameters<typeof captureStyleMap>[1]): Promise<StyleMap> {
  await page.setContent(html, { waitUntil: 'load' });
  return captureStyleMap(page, { stabilize: false, ...options });
}

async function warnings(page: Page, run: () => Promise<StyleMap>): Promise<{ map: StyleMap; warned: string[] }> {
  const warned: string[] = [];
  const original = console.warn;
  console.warn = (message: unknown) => warned.push(String(message));
  try {
    return { map: await run(), warned };
  } finally {
    console.warn = original;
  }
}

test('subtree scope captures the same states as whole-document reads within the default budget', async ({ page }) => {
  const html = board(16, DESCENDANT_RULES);
  const documentMap = await capture(page, html, { maxForcedStateScanWork: 2_000_000 });
  expect(documentMap.statesSkipped).toBeFalsy();

  const defaultBudget = await capture(page, html, {});
  expect(defaultBudget.statesSkipped, 'whole-document reads exhaust the default budget on this board').toBe(true);

  const { map: scoped, warned } = await warnings(page, () => capture(page, html, { forcedStateScope: 'stylesheet' }));
  expect(scoped.statesSkipped).toBeFalsy();
  expect(warned.filter((line) => line.includes('forced-state'))).toEqual([]);
  expect(scoped.states).toEqual(documentMap.states);
  expect(Object.keys(scoped.states).length).toBe(32);
  const label = Object.values(scoped.states).find((states) =>
    Object.values(states.hover ?? {}).some((properties) => properties.color === 'rgb(0, 120, 0)'),
  );
  expect(label, 'the descendant .label hover colour is captured on the control').toBeTruthy();
});

test('a sibling combinator widens reads to the parent subtree and still matches the document', async ({ page }) => {
  const html = board(12, `${DESCENDANT_RULES}\n  .refresh:hover ~ .link { color: rgb(250, 100, 0); }`);
  const documentMap = await capture(page, html, { maxForcedStateScanWork: 2_000_000 });
  const scoped = await capture(page, html, { forcedStateScope: 'stylesheet' });
  expect(scoped.statesSkipped).toBeFalsy();
  expect(scoped.states).toEqual(documentMap.states);
  expect(
    Object.values(scoped.states).some((states) =>
      Object.values(states.hover ?? {}).some((properties) => properties.color === 'rgb(250, 100, 0)'),
    ),
  ).toBe(true);
});

for (const [name, rule] of [
  [':has()', 'main:has(.refresh:hover) h2 { color: rgb(0, 90, 90); }'],
  [':focus-within', '.card:focus-within h2 { color: rgb(0, 90, 90); }'],
  ['@scope', '@scope (.card:hover) { h2 { color: rgb(0, 90, 90); } }'],
]) {
  test(`${name} falls back to whole-document reads, loudly`, async ({ page }) => {
    const html = board(3, `${DESCENDANT_RULES}\n  ${rule}`);
    const documentMap = await capture(page, html, { maxForcedStateScanWork: 2_000_000 });
    const { map: scoped, warned } = await warnings(page, () =>
      capture(page, html, { forcedStateScope: 'stylesheet', maxForcedStateScanWork: 2_000_000 }),
    );
    expect(warned.some((line) => line.includes("forcedStateScope 'stylesheet' fell back to whole-document"))).toBe(
      true,
    );
    expect(scoped.states).toEqual(documentMap.states);
  });
}

test('an ancestor reached only through :has() is still captured under the stylesheet scope', async ({ page }) => {
  const html = board(2, `${DESCENDANT_RULES}\n  .card:has(.refresh:hover) { border-color: rgb(255, 0, 255); }`);
  const scoped = await capture(page, html, { forcedStateScope: 'stylesheet' });
  expect(scoped.statesSkipped).toBeFalsy();
  expect(
    Object.values(scoped.states).some((states) =>
      Object.values(states.hover ?? {}).some((properties) => properties['border-top-color'] === 'rgb(255, 0, 255)'),
    ),
  ).toBe(true);
});
