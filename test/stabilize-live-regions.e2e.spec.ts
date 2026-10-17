import { test, expect } from '@playwright/test';
import { captureStyleMap } from '../dist/capture.js';

test('stabilize excludes every live region, not only the one that changed in the last poll', async ({ page }) => {
  await page.setContent(`<body><div id="clock">0</div><div id="ticker">0</div><p id="still">static</p>
<script>
  let a = 0, b = 0;
  setInterval(() => { clock.textContent = ++a; clock.style.width = (100 + (a % 2)) + 'px'; }, 400);
  setTimeout(() => setInterval(() => { ticker.textContent = ++b; ticker.style.width = (200 + (b % 2)) + 'px'; }, 400), 200);
</script></body>`);
  // A 50ms poll so the two tickers never land in the same changing poll (the bug's trigger).
  const map = await captureStyleMap(page, { captureStates: false, stabilize: { interval: 50, timeout: 3000 } });
  const divs = Object.keys(map.elements).filter((p) => p.startsWith('body > div'));
  expect(map.volatile ?? []).toHaveLength(2);
  expect(divs).toEqual([]);
  expect(Object.keys(map.elements).some((p) => p.startsWith('body > p'))).toBe(true);
});

test('stabilize still compares content that loaded in two steps while another region ticks', async ({ page }) => {
  await page.setContent(`<body><div id="clock">0</div><section id="panel"></section>
<script>
  let a = 0;
  setInterval(() => { clock.textContent = ++a; }, 400);
  setTimeout(() => { panel.textContent = 'loading'; }, 300);
  setTimeout(() => { panel.textContent = 'loaded data'; panel.style.width = '300px'; }, 3200);
</script></body>`);
  const map = await captureStyleMap(page, { captureStates: false, stabilize: { timeout: 5000 } });
  expect(Object.keys(map.elements).some((p) => p.startsWith('body > section'))).toBe(true);
  expect((map.volatile ?? []).some((p) => p.startsWith('body > section'))).toBe(false);
  expect((map.volatile ?? []).some((p) => p.startsWith('body > div'))).toBe(true);
});

test('stabilize still compares content that loaded in three steps while another region ticks', async ({ page }) => {
  await page.setContent(`<body><div id="clock">0</div><section id="panel"></section>
<script>
  let a = 0;
  setInterval(() => { clock.textContent = ++a; }, 400);
  setTimeout(() => { panel.textContent = 'loading'; }, 300);
  setTimeout(() => { panel.style.width = '200px'; }, 700);
  setTimeout(() => { panel.textContent = 'loaded data'; panel.style.width = '300px'; }, 3200);
</script></body>`);
  const map = await captureStyleMap(page, { captureStates: false, stabilize: { timeout: 5000 } });
  expect(Object.keys(map.elements).some((p) => p.startsWith('body > section'))).toBe(true);
  expect((map.volatile ?? []).some((p) => p.startsWith('body > section'))).toBe(false);
});

test('stabilize still excludes a slow ticker while a request is in flight', async ({ page }) => {
  await page.route('https://styleproof.test/**', () => {});
  await page.setContent(`<body><div id="clock">0</div><p id="still">static</p>
<script>
  let a = 0;
  setInterval(() => fetch('https://styleproof.test/poll').catch(() => {}), 200);
  setInterval(() => { clock.textContent = ++a; }, 2000);
</script></body>`);
  // The 2000ms tick lands outside the final 600ms window, so only "last poll that changed" catches it.
  const map = await captureStyleMap(page, { captureStates: false, stabilize: { interval: 50, timeout: 3000 } });
  expect(map.volatile ?? []).toHaveLength(1);
  expect(Object.keys(map.elements).some((p) => p.startsWith('body > div'))).toBe(false);
  expect(Object.keys(map.elements).some((p) => p.startsWith('body > p'))).toBe(true);
});
