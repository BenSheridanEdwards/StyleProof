import { expect, test } from '@playwright/test';
import { captureStyleMap } from '../dist/index.js';

const crossElementFixture = `<!doctype html><html><head><style>
  button { padding: 12px 18px; }
  .panel { padding: 16px; background: rgb(255, 0, 0); }
  button:hover + .panel { background: rgb(0, 0, 255); }
</style></head><body><button>Inspect</button><section class="panel">Panel</section></body></html>`;

test('benchmark proof pointer state cannot contaminate the fresh sensor page', async ({ browser }) => {
  const proofPage = await browser.newPage();
  await proofPage.setContent(crossElementFixture);
  await proofPage.locator('button').hover();
  expect(await proofPage.locator('.panel').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
    'rgb(0, 0, 255)',
  );
  await proofPage.close();

  const sensorPage = await browser.newPage();
  await sensorPage.setContent(crossElementFixture);
  expect(await sensorPage.locator('.panel').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
    'rgb(255, 0, 0)',
  );
  const map = await captureStyleMap(sensorPage, { stabilize: false });
  const buttonPath = Object.entries(map.elements).find(([, element]) => element.tag === 'button')?.[0];
  const panelPath = Object.entries(map.elements).find(([, element]) => element.cls === 'panel')?.[0];
  expect(buttonPath).toBeTruthy();
  expect(panelPath).toBeTruthy();
  expect(map.elements[panelPath!]?.style['background-color']).toBe('rgb(255, 0, 0)');
  expect(map.states[buttonPath!]?.hover[panelPath!]?.['background-color']).toBe('rgb(0, 0, 255)');
  await sensorPage.close();
});
