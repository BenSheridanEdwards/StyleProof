import { test, expect, type Page } from '@playwright/test';
import { captureStyleMap, type CaptureOptions } from '../dist/capture.js';

const fixture = `<!doctype html><style>
  button { color: rgb(10, 20, 30); transition: color 240ms; }
  button::before { content: 'Go'; color: rgb(40, 50, 60); }
  button:hover { color: rgb(70, 80, 90); }
</style><body><button>Continue</button><p class="ignored">Skip me</p></body>`;

async function countDocumentReads(page: Page): Promise<void> {
  await page.evaluate(() => {
    const original = window.getComputedStyle;
    let reads = 0;
    Object.defineProperty(document.documentElement, 'styleReadCount', { get: () => reads });
    window.getComputedStyle = (element, pseudo) => {
      if (element === document.documentElement && !pseudo) reads++;

      return original(element, pseudo);
    };
  });
}

async function measuredCapture(page: Page, options: CaptureOptions = {}) {
  const reads = () =>
    page.evaluate(() => Number(Object.getOwnPropertyDescriptor(document.documentElement, 'styleReadCount')?.get?.()));

  const before = await reads();
  const boundaries: Promise<number>[] = [];
  const map = await captureStyleMap(page, { ...options, onPhase: () => boundaries.push(reads()) });
  const [start, end] = await Promise.all(boundaries);

  return { map, polls: end - start, reads: (await reads()) - before };
}

test('quiet captures and self-checks reuse the final poll without another resting pass', async ({ page }) => {
  await page.setContent(fixture);
  await countDocumentReads(page);
  // Calibrate motion, geometry, token and forced-state reads against the same page.
  const direct = await measuredCapture(page, { stabilize: false });

  for (let run = 0; run < 2; run++) {
    const settled = await measuredCapture(page);
    expect(settled.map.elements).toEqual(direct.map.elements);
    expect(settled.polls).toBeGreaterThanOrEqual(2);
    expect(settled.reads).toBe(settled.polls + direct.reads - 1);
  }
});

for (const options of [{}, { captureText: false, ignore: ['.ignored'] }]) {
  test(`default settle matches a fresh resting map: ${JSON.stringify(options)}`, async ({ page }) => {
    await page.setContent(fixture);
    const settled = await captureStyleMap(page, options);
    const direct = await captureStyleMap(page, { ...options, stabilize: false });
    expect(settled.elements).toEqual(direct.elements);
  });
}

test('quiet capture includes a mutation 300ms after load', async ({ page }) => {
  await page.setContent(`${fixture}<script>
    setTimeout(() => {
      const button = document.querySelector('button');
      button.textContent = 'Ready';
      button.style.color = 'rgb(100, 110, 120)';
    }, 300);
  </script>`);
  const map = await captureStyleMap(page, { captureStates: false });
  const button = Object.values(map.elements).find((entry) => entry.tag === 'button');
  expect(button?.text).toBe('Ready');
  expect(button?.style.color).toBe('rgb(100, 110, 120)');
  expect(map.volatile ?? []).toEqual([]);
});

test('component capture keeps its fresh read and component metadata', async ({ page }) => {
  await page.setContent(`${fixture}<script>
    function Button() {}
    document.querySelector('button')['__reactFiber$fixture'] = {
      type: Button, return: null, memoizedProps: { variant: 'primary' }
    };
  </script>`);
  await countDocumentReads(page);
  const options = { captureComponent: true, captureStates: false };
  const direct = await measuredCapture(page, { ...options, stabilize: false });
  const settled = await measuredCapture(page, options);
  const button = Object.values(settled.map.elements).find((entry) => entry.tag === 'button');
  expect(button?.component).toEqual({ name: 'Button', props: { variant: 'primary' } });
  expect(settled.map.elements).toEqual(direct.map.elements);
  expect(settled.reads).toBe(settled.polls + direct.reads);
});

test('reach capture keeps the fresh read and reached rules', async ({ page }) => {
  await page.setContent(fixture);
  await countDocumentReads(page);
  const options = { captureReach: true, captureStates: false };
  const direct = await measuredCapture(page, { ...options, stabilize: false });
  const settled = await measuredCapture(page, options);
  expect(settled.map.reach?.rules.some((rule) => rule.used)).toBe(true);
  expect(settled.map.reach).toEqual(direct.map.reach);
  expect(settled.map.elements).toEqual(direct.map.elements);
  expect(settled.reads).toBe(settled.polls + direct.reads);
});

test('a settle that times out keeps the fresh resting read', async ({ page }) => {
  await page.setContent(fixture);
  await countDocumentReads(page);
  const direct = await measuredCapture(page, { stabilize: false, captureStates: false });

  const settled = await measuredCapture(page, {
    captureStates: false,
    stabilize: { interval: 25, quietFor: 600, timeout: 100 },
  });

  expect(settled.map.elements).toEqual(direct.map.elements);
  expect(settled.reads).toBe(settled.polls + direct.reads);
});
