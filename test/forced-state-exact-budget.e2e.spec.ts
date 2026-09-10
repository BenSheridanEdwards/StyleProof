import { expect, test } from '@playwright/test';
import { captureStyleMap } from '../dist/index.js';

test('spending the final default work allowance still completes the last state', async ({ page }) => {
  const controls = '<button>Inspect</button>'.repeat(40);
  const content = '<span>Text</span>'.repeat(157);
  await page.setContent(`<!doctype html><html><head><style>
    button:hover ~ output { color: rgb(200, 0, 0); }
    button:focus ~ output { color: rgb(0, 100, 0); }
    button:active ~ output { color: rgb(0, 0, 200); }
  </style></head><body>${controls}${content}<output>Witness</output></body></html>`);
  // 200 elements * 40 controls * (one resting + three forced reads) = 32,000.
  const map = await captureStyleMap(page, { stabilize: false });
  expect(Object.keys(map.elements)).toHaveLength(200);
  expect(Object.keys(map.states)).toHaveLength(40);
  expect(map.statesSkipped).toBeFalsy();
  for (const states of Object.values(map.states)) {
    expect(Object.values(states.active).some((properties) => properties.color === 'rgb(0, 0, 200)')).toBe(true);
  }
});
