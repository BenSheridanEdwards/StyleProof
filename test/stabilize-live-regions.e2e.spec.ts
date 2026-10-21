import { test, expect } from '@playwright/test';
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

test('a growing live list is excluded on its own: html, body and its static siblings stay compared', async ({
  page,
}) => {
  const capture = async (color: string) => {
    // Standards mode: html and body grow with the list (quirks mode stretches them to the viewport).
    await page.setContent(`<!doctype html><style>h1 { color: ${color}; } .cta:hover { color: rgb(255, 0, 0); }</style>
<body><h1>Sample dashboard</h1><button class="cta">Go</button><ul id="log" aria-live="polite"></ul>
<script>
  let n = 0;
  setInterval(() => { const li = document.createElement('li'); li.textContent = 'event ' + ++n; log.append(li); }, 400);
</script></body>`);
    // The default 600ms quietFor outlasts the 400ms append, so the list is still growing at timeout.
    return captureStyleMap(page, { stabilize: { timeout: 1500 } });
  };
  const base = await capture('rgb(0, 0, 0)');
  const head = await capture('rgb(255, 0, 0)');
  for (const map of [base, head]) {
    expect(map.volatile ?? []).not.toContain('html');
    expect(map.volatile ?? []).not.toContain('body');
    expect((map.volatile ?? []).some((p) => p.startsWith('body > ul'))).toBe(true);
    expect(Object.keys(map.elements).some((p) => p.startsWith('body > h1'))).toBe(true);
    expect(Object.keys(map.states).some((p) => p.startsWith('body > button'))).toBe(true);
  }
  expect(restyled(diffStyleMaps(base, head), 'body > h1')).toBe(true);
});

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
