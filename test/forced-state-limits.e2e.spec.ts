import { expect, test } from '@playwright/test';
import { captureStyleMap } from '../dist/index.js';

function controlsWithWitness(controlCount: number, contentCount = 0): string {
  const controls = Array.from({ length: controlCount }, (_, index) => `<button>Control ${index}</button>`).join('');
  const content = '<span>Text</span>'.repeat(contentCount);
  return `<!doctype html><html><head><style>
    button:hover ~ output { color: rgb(200, 0, 0); }
    button:focus ~ output { color: rgb(0, 100, 0); }
    button:active ~ output { color: rgb(0, 0, 200); }
  </style></head><body>${controls}${content}<output>Witness</output></body></html>`;
}

for (const [elements, work, incomplete] of [
  [5, 40, false],
  [5, 39, true],
  [4, 40, true],
]) {
  test(`honors document ${elements} and aggregate ${work} limits at the exact boundary`, async ({ page }) => {
    await page.setContent(controlsWithWitness(2));
    const map = await captureStyleMap(page, {
      stabilize: false,
      maxForcedStateElements: elements,
      maxForcedStateScanWork: work,
    });
    expect(Object.keys(map.elements)).toHaveLength(5);
    expect(map.statesSkipped === true).toBe(incomplete);
    if (!incomplete) {
      expect(Object.keys(map.states)).toHaveLength(2);
      for (const states of Object.values(map.states))
        expect(Object.keys(states).sort()).toEqual(['active', 'focus', 'hover']);
    }
  });
}

test('explicit aggregate capacity captures every control beyond the default limit', async ({ page }) => {
  await page.setContent(controlsWithWitness(53, 242));
  const map = await captureStyleMap(page, { stabilize: false, maxForcedStateScanWork: 70_000 });
  expect(Object.keys(map.elements)).toHaveLength(298);
  expect(map.statesSkipped).toBeFalsy();
  expect(Object.keys(map.states)).toHaveLength(53);
  for (const states of Object.values(map.states)) {
    expect(Object.values(states.hover).some((properties) => properties.color === 'rgb(200, 0, 0)')).toBe(true);
    expect(Object.values(states.focus).some((properties) => properties.color === 'rgb(0, 100, 0)')).toBe(true);
    expect(Object.values(states.active).some((properties) => properties.color === 'rgb(0, 0, 200)')).toBe(true);
  }
});
