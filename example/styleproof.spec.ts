import type { Page } from '@playwright/test';
import { defineStyleMapCapture, type Surface } from 'styleproof';

/**
 * Example capture spec. Each surface is one deterministic page state; widths
 * sweep one viewport per @media band so breakpoint rules are verified too.
 *
 *   STYLEMAP_DIR=before npx playwright test example/   # capture baseline
 *   ...refactor your CSS...
 *   STYLEMAP_DIR=after  npx playwright test example/   # capture again
 *   npx styleproof-diff __stylemaps__/before __stylemaps__/after
 */

// Captures read whatever is in front of them, so the page must be settled and
// deterministic first: fonts loaded, entrance animations at their end state.
// Scrolling through the page triggers IntersectionObserver-driven reveals;
// alternatively inject CSS that forces your reveal classes to their final
// values (e.g. `.reveal{opacity:1!important;transform:none!important}`).
async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (let y = 0; y < document.body.scrollHeight; y += window.innerHeight) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(900);
}

const SURFACES: Surface[] = [
  {
    key: 'home',
    go: async (page) => {
      await page.goto('/', { waitUntil: 'networkidle' });
      await settle(page);
    },
    ignore: [], // e.g. ['.live-feed', '.ad-slot'] for nondeterministic regions
    widths: [1280, 768, 390],
  },
  // Add one surface per distinct page state: open menus, dialogs, selected
  // tabs, form errors — anything whose styling you want certified.
];

defineStyleMapCapture({ surfaces: SURFACES, dir: process.env.STYLEMAP_DIR });
