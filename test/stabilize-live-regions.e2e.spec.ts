import { test, expect, type BrowserContext } from '@playwright/test';
import { captureStyleMap, trackInflightRequests } from '../dist/capture.js';
import { diffStyleMaps } from '../dist/diff.js';

test('stabilize excludes every live region, not only the one that changed in the last poll', async ({ page }) => {
  await page.setContent(`<body><div id="clock">0</div><div id="ticker">0</div><p id="still">static</p>
<script>
  let a = 0, b = 0;
  setInterval(() => { clock.textContent = ++a; clock.style.width = (100 + (a % 2)) + 'px'; }, 200);
  setTimeout(() => setInterval(() => { ticker.textContent = ++b; ticker.style.width = (200 + (b % 2)) + 'px'; }, 200), 100);
</script></body>`);
  // A 25ms poll so the two tickers never land in the same changing poll (the bug's trigger).
  const map = await captureStyleMap(page, { captureStates: false, stabilize: { interval: 25, timeout: 1200 } });
  const divs = Object.keys(map.elements).filter((p) => p.startsWith('body > div'));
  expect(map.volatile ?? []).toHaveLength(2);
  expect(divs).toEqual([]);
  expect(Object.keys(map.elements).some((p) => p.startsWith('body > p'))).toBe(true);
});

test('stabilize still compares content that loaded in two steps while another region ticks', async ({ page }) => {
  await page.setContent(`<body><div id="clock">0</div><section id="panel"></section>
<script>
  let a = 0;
  setInterval(() => { clock.textContent = ++a; }, 150);
  setTimeout(() => { panel.textContent = 'loading'; }, 100);
  setTimeout(() => { panel.textContent = 'loaded data'; panel.style.width = '300px'; }, 500);
</script></body>`);
  const map = await captureStyleMap(page, {
    captureStates: false,
    stabilize: { interval: 50, quietFor: 300, timeout: 1200 },
  });
  expect(Object.keys(map.elements).some((p) => p.startsWith('body > section'))).toBe(true);
  expect((map.volatile ?? []).some((p) => p.startsWith('body > section'))).toBe(false);
  expect((map.volatile ?? []).some((p) => p.startsWith('body > div'))).toBe(true);
});

test('stabilize still compares content that loaded in three steps while another region ticks', async ({ page }) => {
  await page.setContent(`<body><div id="clock">0</div><section id="panel"></section>
<script>
  let a = 0;
  setInterval(() => { clock.textContent = ++a; }, 150);
  setTimeout(() => { panel.textContent = 'loading'; }, 100);
  setTimeout(() => { panel.style.width = '200px'; }, 250);
  setTimeout(() => { panel.textContent = 'loaded data'; panel.style.width = '300px'; }, 500);
</script></body>`);
  const map = await captureStyleMap(page, {
    captureStates: false,
    stabilize: { interval: 50, quietFor: 300, timeout: 1200 },
  });
  expect(Object.keys(map.elements).some((p) => p.startsWith('body > section'))).toBe(true);
  expect((map.volatile ?? []).some((p) => p.startsWith('body > section'))).toBe(false);
});

test('stabilize still excludes a slow ticker while a request is in flight', async ({ page }) => {
  await page.route('https://styleproof.test/**', () => {});
  await page.setContent(`<body><div id="clock">0</div><p id="still">static</p>
<script>
  let a = 0;
  setInterval(() => fetch('https://styleproof.test/poll').catch(() => {}), 100);
  setInterval(() => { clock.textContent = ++a; }, 700);
</script></body>`);
  // The 700ms tick lands outside the final 300ms window, so only "last poll that changed" catches it.
  const map = await captureStyleMap(page, {
    captureStates: false,
    stabilize: { interval: 50, quietFor: 300, timeout: 1200 },
  });
  expect(map.volatile ?? []).toHaveLength(1);
  expect(Object.keys(map.elements).some((p) => p.startsWith('body > div'))).toBe(false);
  expect(Object.keys(map.elements).some((p) => p.startsWith('body > p'))).toBe(true);
});

const restyled = (findings: ReturnType<typeof diffStyleMaps>, prefix: string): boolean =>
  findings.some((f) => f.kind === 'style' && f.path.startsWith(prefix) && f.props.some((p) => p.prop === 'color'));

const leaf = (p: string): string => p.split(' > ').pop() ?? '';

/** A fresh page per capture: a second setContent keeps the first document's Window, timers and globals. */
async function captureFresh(
  context: BrowserContext,
  html: string,
): Promise<Awaited<ReturnType<typeof captureStyleMap>>> {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.setContent(html);
    // The default 600ms quietFor outlasts the 400ms append, so the stream is still growing at timeout.
    const map = await captureStyleMap(page, { stabilize: { timeout: 1500 } });
    expect(errors).toEqual([]);
    return map;
  } finally {
    await page.close();
  }
}

const CARD = '.card { position: relative; } .card::after { content: ""; position: absolute; inset: 0; }';
// Each wrapper's own entry changes with every new item: its box, a box-sized ::after, a class.
const STREAMS = [
  {
    into: 'a list beside them',
    item: 'li',
    body: '<h1>Sample dashboard</h1><button class="cta">Go</button><ul id="log"></ul>',
  },
  {
    into: 'the wrapper that holds them',
    item: 'p',
    body: '<main id="log"><h1>Sample dashboard</h1><button class="cta">Go</button></main>',
  },
  {
    into: 'a list in a wrapper with a box-sized ::after',
    item: 'li',
    css: CARD,
    body: '<div class="card"><h1>Sample dashboard</h1><button class="cta">Go</button><ul id="log"></ul></div>',
  },
  {
    // Nothing inside the card changes, so only the pseudo-geometry rule keeps it compared.
    into: 'a list that stretches the card beside it',
    item: 'li',
    css: `${CARD} .row { display: flex; }`,
    body: '<div class="row"><div class="card"><h1>Sample dashboard</h1><button class="cta">Go</button></div><ul id="log"></ul></div>',
  },
  {
    into: 'a list in a wrapper that flags every new item',
    item: 'li',
    css: '.pulse { outline: 1px solid rgb(0, 0, 255); }',
    onAppend: 'panel.classList.toggle("pulse");',
    body: '<div id="panel"><h1>Sample dashboard</h1><button class="cta">Go</button><ul id="log"></ul></div>',
  },
];

for (const stream of STREAMS) {
  test(`a stream growing into ${stream.into} is excluded item by item: html, body, the h1 and the button stay compared`, async ({
    context,
  }) => {
    // Standards mode: html and body grow with the stream (quirks mode stretches them to the viewport).
    const html = (color: string) => `<!doctype html>
<style>h1 { color: ${color}; } .cta:hover { color: rgb(255, 0, 0); } ${stream.css ?? ''}</style>
<body>${stream.body}
<script>
  let n = 0;
  setInterval(() => {
    const el = document.createElement('${stream.item}');
    el.textContent = 'event ' + ++n;
    log.append(el);
    ${stream.onAppend ?? ''}
  }, 400);
</script></body>`;
    const base = await captureFresh(context, html('rgb(0, 0, 0)'));
    const head = await captureFresh(context, html('rgb(255, 0, 0)'));
    for (const map of [base, head]) {
      const volatile = map.volatile ?? [];
      expect(volatile.length).toBeGreaterThan(0);
      // Only the newest items: no ancestor (html, body, a wrapper) took the h1 and button with them.
      expect(volatile.filter((p) => !leaf(p).startsWith(stream.item))).toEqual([]);
      expect(Object.keys(map.states).some((p) => leaf(p).startsWith('button'))).toBe(true);
    }
    const h1 = Object.keys(base.elements).find((p) => leaf(p).startsWith('h1'));
    expect(h1).toBeDefined();
    expect(restyled(diffStyleMaps(base, head), h1!)).toBe(true);
  });
}

test('content that renders once while a request never answers is compared, not volatile', async ({ page }) => {
  await page.route('https://styleproof.test/**', () => {});
  const capture = async (color: string) => {
    const tracker = trackInflightRequests(page);
    await page.setContent(`<!doctype html><style>h1, #panel p { color: ${color}; }</style>
<body><h1>Sample reports</h1><section id="panel"></section>
<script>
  fetch('https://styleproof.test/longpoll').catch(() => {});
  setTimeout(() => { panel.innerHTML = '<p>Report ready</p>'; }, 400);
</script></body>`);
    try {
      return await captureStyleMap(page, {
        captureStates: false,
        pendingRequests: tracker.pending,
        stabilize: { interval: 50, quietFor: 300, timeout: 1200 },
      });
    } finally {
      tracker.dispose();
    }
  };
  const base = await capture('rgb(0, 0, 0)');
  const head = await capture('rgb(255, 0, 0)');
  expect(base.volatile ?? []).toEqual([]);
  expect(head.volatile ?? []).toEqual([]);
  expect(restyled(diffStyleMaps(base, head), 'body > section')).toBe(true);
});
