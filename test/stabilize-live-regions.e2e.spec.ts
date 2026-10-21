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
  // The second 700ms tick lands outside the final 300ms window, so only "changed again in the
  // last poll that changed" catches it. One tick alone is a settled step, so the budget fits two.
  const map = await captureStyleMap(page, {
    captureStates: false,
    stabilize: { interval: 50, quietFor: 300, timeout: 1800 },
  });
  expect(map.volatile ?? []).toHaveLength(1);
  expect(Object.keys(map.elements).some((p) => p.startsWith('body > div'))).toBe(false);
  expect(Object.keys(map.elements).some((p) => p.startsWith('body > p'))).toBe(true);
});

// A live list that grows resizes every ancestor up to <html> in the same poll. Those
// ancestors used to be recorded as volatile roots, which dropped the whole page from the
// comparison while the run still certified.
const growingList = (heading: string, button: string): string => `<!doctype html>
<style>h1 { color: ${heading} } button { background: ${button} }</style>
<body><h1>Status</h1><button>Refresh</button><ul aria-live="polite"></ul>
<script>
  let n = 0;
  setInterval(() => { const li = document.createElement('li'); li.textContent = 'item ' + ++n; document.querySelector('ul').append(li); }, 400);
</script></body>`;

test('stabilize excludes only a growing live list, never html, body or its static siblings', async ({ page }) => {
  const capture = async (heading: string, button: string) => {
    await page.setContent(growingList(heading, button));
    return captureStyleMap(page, { stabilize: { timeout: 2000 } });
  };
  const base = await capture('rgb(0, 0, 0)', 'rgb(0, 0, 255)');
  const head = await capture('rgb(255, 0, 0)', 'rgb(0, 128, 0)');
  for (const map of [base, head]) {
    expect(map.volatile ?? []).not.toContain('html');
    expect(map.volatile ?? []).not.toContain('body');
    expect(Object.keys(map.elements)).toContain('body > h1:nth-child(1)');
    expect(Object.keys(map.states)).toContain('body > button:nth-child(2)');
  }
  const changed = diffStyleMaps(base, head, { includeStructure: false }).flatMap((f) =>
    f.kind === 'style' && !f.pseudo ? f.props.map((p) => `${f.path} ${p.prop}`) : [],
  );
  expect(changed).toContain('body > h1:nth-child(1) color');
  expect(changed).toContain('body > button:nth-child(2) background-color');
});

test('stabilize compares a panel that rendered once while a data request never answers', async ({ page }) => {
  const capture = async (text: string) => {
    await page.route('https://styleproof.test/**', () => {});
    const requests = trackInflightRequests(page);
    try {
      await page.setContent(`<!doctype html><style>p { color: ${text} }</style>
<body><h1>Report</h1><section id="panel"></section>
<script>
  fetch('https://styleproof.test/data').catch(() => {});
  setTimeout(() => { panel.innerHTML = '<p>loaded data</p>'; }, 400);
</script></body>`);
      return await captureStyleMap(page, {
        captureStates: false,
        pendingRequests: requests.pending,
        stabilize: { timeout: 2000 },
      });
    } finally {
      requests.dispose();
    }
  };
  const base = await capture('rgb(0, 0, 0)');
  const head = await capture('rgb(255, 0, 0)');
  expect(base.volatile ?? []).toEqual([]);
  expect(head.volatile ?? []).toEqual([]);
  const changed = diffStyleMaps(base, head, { includeStructure: false }).flatMap((f) =>
    f.kind === 'style' && !f.pseudo ? f.props.map((p) => `${f.path.replace(/:sp-key\(\w+\)/, '')} ${p.prop}`) : [],
  );
  expect(changed).toContain('body > section > p:nth-child(1) color');
});
