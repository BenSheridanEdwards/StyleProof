import { test, expect } from '@playwright/test';
import { collectClickable } from '../dist/crawl/browser.js';
import { DANGER_SOURCE, SUBMITS_FORM_SOURCE } from '../dist/danger.js';
import { popupDomSnapshot } from '../dist/runner/browser.js';
import { resolvePopupCaptureOptions } from '../dist/runner/settings.js';

for (const ownership of ['none', 'ancestor', 'attribute']) {
  test(`discovery checks effective submit types with ${ownership} form ownership`, async ({ page }) => {
    const controls = `<button id="untyped" aria-haspopup="dialog">Continue</button><button id="invalid" type="invalid" role="button">Continue</button><button id="submit" type="SUBMIT" popovertarget="popup">Continue</button><input id="input-submit" type="submit" value="Continue"><input id="image" type="image" aria-label="Continue"><button id="safe" type="button">Open menu</button>`;

    const owned = ownership === 'attribute' ? controls.replace(/<(button|input)/g, '<$1 form="owner"') : controls;

    await page.setContent(ownership === 'ancestor' ? `<form>${owned}</form>` : `<form id="owner"></form>${owned}`);

    await page.locator('#untyped').evaluate((el: HTMLElement) => {
      el.onclick = () => {
        document.body.dataset.opened = 'true';
      };
    });

    const options = {
      dangerSource: DANGER_SOURCE,
      popupSelector: 'dialog[open]',
      submitsFormSource: SUBMITS_FORM_SOURCE,
      triggerSelector: resolvePopupCaptureOptions(true).triggers,
      attr: 'data-popup-trigger',
      max: 20,
    };

    const candidates = await page.evaluate(collectClickable, options);
    const snapshot = await page.evaluate(popupDomSnapshot, options);

    for (const id of ['untyped', 'invalid', 'submit', 'input-submit', 'image']) {
      expect(candidates.find((candidate) => candidate.selector === `#${id}`)?.unsafe).toBe(ownership !== 'none');
      const inPopup = snapshot.candidates.some((candidate) => candidate.path.includes(`#${id}`));

      expect(inPopup).toBe(ownership === 'none' && !['input-submit', 'image'].includes(id));

      if (ownership === 'ancestor') {
        expect(
          await page.locator(`#${id}`).evaluate((el, selector) => el.matches(selector), options.triggerSelector),
        ).toBe(false);
      }
    }

    expect(candidates.find((candidate) => candidate.selector === '#safe')?.unsafe).toBe(false);
    expect(snapshot.candidates.some((candidate) => candidate.path.includes('#safe'))).toBe(true);

    if (ownership === 'none') {
      await page.locator('#untyped').click();
      await expect(page.locator('body')).toHaveAttribute('data-opened', 'true');
      const trigger = snapshot.candidates.find((candidate) => candidate.path.includes('#untyped'))!;
      await page.locator('#untyped').evaluate((el) => el.setAttribute('form', 'owner'));

      const rebound = await page.evaluate(popupDomSnapshot, {
        ...options,
        relocatePath: trigger.path,
        relocateLabel: trigger.label,
      });

      expect(rebound.found).toBe(false);
    }
  });
}
