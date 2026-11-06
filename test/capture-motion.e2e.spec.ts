import { test, expect } from '@playwright/test';
import { freezeMotion, unfreezeMotion } from '../dist/capture/browser.js';

// Complements the bookkeeping VM in capture-shared.test.mjs with a real CSS cascade.
test('motion freeze disables animation and transition, then restores the application sheet', async ({ page }) => {
  await page.setContent(`<style>
    @keyframes pulse { from { opacity: .2 } to { opacity: .8 } }
    button { animation: pulse 10s linear infinite; transition: color 2s; }
  </style><button>Continue</button>`);
  const motion = () =>
    page.locator('button').evaluate((button) => {
      const style = getComputedStyle(button);
      return { animation: style.animationName, transition: style.transitionDuration };
    });
  expect(await motion()).toEqual({ animation: 'pulse', transition: '2s' });
  await page.evaluate(freezeMotion, '*,*::before,*::after{animation:none!important;transition:none!important}');
  expect(await motion()).toEqual({ animation: 'none', transition: '0s' });
  await page.evaluate(unfreezeMotion, true);
  expect(await motion()).toEqual({ animation: 'pulse', transition: '2s' });
  expect(await page.evaluate(() => document.adoptedStyleSheets.length)).toBe(0);
});
