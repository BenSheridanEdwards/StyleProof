import { test, expect } from '@playwright/test';
import { collectClickable } from '../dist/crawl/browser.js';
import { DANGER_SOURCE } from '../dist/danger.js';
import { resolvePopupCaptureOptions } from '../dist/runner/settings.js';

for (const inForm of [false, true]) {
  test(`discovery rejects effective submit types ${inForm ? 'inside' : 'outside'} forms`, async ({ page }) => {
    const controls = `
      <button id="untyped" aria-haspopup="dialog">Continue</button>
      <button id="invalid" type="invalid" role="button">Continue</button>
      <button id="submit" type="SUBMIT" popovertarget="popup">Continue</button>
      <input id="input-submit" type="submit" value="Continue">
      <input id="image" type="image" aria-label="Continue">
      <button id="safe" type="button">Open menu</button>`;

    await page.setContent(inForm ? `<form>${controls}</form>` : controls);

    const candidates = await page.evaluate(collectClickable, DANGER_SOURCE);

    for (const id of ['untyped', 'invalid', 'submit', 'input-submit', 'image']) {
      expect(candidates.find((candidate) => candidate.selector === `#${id}`)?.unsafe).toBe(true);
      expect(
        await page
          .locator(`#${id}`)
          .evaluate((element, triggers) => element.matches(triggers), resolvePopupCaptureOptions(true).triggers),
      ).toBe(false);
    }

    expect(candidates.find((candidate) => candidate.selector === '#safe')?.unsafe).toBe(false);
    expect(
      await page
        .locator('#safe')
        .evaluate((element, triggers) => element.matches(triggers), resolvePopupCaptureOptions(true).triggers),
    ).toBe(true);
  });
}
