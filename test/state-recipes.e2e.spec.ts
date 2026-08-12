import { test, expect } from '@playwright/test';
import http from 'node:http';
import {
  applyStateRecipe,
  stateRecipeDriver,
  stateRecipeKey,
  captureStyleMap,
  diffStyleMaps,
  StateRecipeError,
} from '../dist/index.js';

/**
 * Sticky interaction fixture: pure CSS :hover/:focus is intentionally neutralised
 * by captureStyleMap (hover-sink + blur) so resting maps stay clean. Real recipe
 * drivers still fire native hover/focus/press; the page mirrors those into sticky
 * classes so the computed-style map records the reached UI state — the same
 * pattern consumer apps use for hover-open menus and focus rings that must be
 * certified beyond CDP forced-state deltas.
 */
function fixture(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; font-family: system-ui, sans-serif; color: rgb(17, 24, 39); }
    .card { padding: 16px; background: rgb(243, 244, 246); border: 2px solid transparent; }
    body.card-hovered .card { background: rgb(219, 234, 254); border-color: rgb(37, 99, 235); }
    .tip { display: none; padding: 8px 12px; background: rgb(15, 118, 110); color: white; }
    body.card-hovered .tip { display: block; }
    input {
      display: block; margin: 16px; padding: 8px 12px;
      border: 2px solid rgb(209, 213, 219); outline: none;
      background: rgb(255, 255, 255);
    }
    body.email-focused input#email {
      border-color: rgb(124, 58, 237);
      background: rgb(245, 243, 255);
      box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.35);
    }
    [role="listbox"] {
      display: none; margin: 16px; padding: 8px;
      background: rgb(254, 243, 199); border: 2px solid rgb(217, 119, 6);
    }
    body.list-open [role="listbox"] { display: block; color: rgb(146, 64, 14); }
    button { margin: 16px; }
  </style></head><body>
    <div class="card" id="card" aria-label="Plan card" tabindex="0">Plan card</div>
    <p class="tip" id="tip">Hover tip</p>
    <label>Email <input id="email" aria-label="Email" /></label>
    <button id="menu" aria-label="Open menu" aria-haspopup="listbox">Menu</button>
    <button id="danger" aria-label="Delete account">Delete</button>
    <ul role="listbox" id="list" aria-label="Plan options">
      <li role="option">Free</li>
      <li role="option">Pro</li>
    </ul>
    <script>
      const card = document.getElementById('card');
      card.addEventListener('mouseenter', () => document.body.classList.add('card-hovered'));
      // Sticky on purpose: capture parks the pointer on a hover-sink; the opened
      // hover UI must remain for the map read (consumer menus behave the same).
      const email = document.getElementById('email');
      email.addEventListener('focus', () => document.body.classList.add('email-focused'));
      const menu = document.getElementById('menu');
      menu.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown' || event.key === 'Enter') {
          document.body.classList.add('list-open');
        }
        if (event.key === 'Escape') {
          document.body.classList.remove('list-open');
        }
      });
    </script>
  </body></html>`;
}

async function withFixture(
  browser: import('@playwright/test').Browser,
  run: (page: import('@playwright/test').Page, baseUrl: string) => Promise<void>,
) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(fixture());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as import('node:net').AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
  try {
    const page = await ctx.newPage();
    await page.goto(baseUrl, { waitUntil: 'load' });
    await run(page, baseUrl);
  } finally {
    await ctx.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('state recipes: hover/focus/press change computed maps with stable keys', async ({ browser }) => {
  await withFixture(browser, async (page) => {
    const hoverRecipe = {
      action: 'hover' as const,
      selector: '#card',
      label: 'Plan card',
    };
    const focusRecipe = {
      action: 'focus' as const,
      selector: '#email',
      label: 'Email',
    };
    const pressRecipe = {
      action: 'press' as const,
      selector: '#menu',
      key: 'ArrowDown',
      label: 'Open menu',
    };

    expect(stateRecipeKey(hoverRecipe)).toBe('hover-plan-card');
    expect(stateRecipeKey(focusRecipe)).toBe('focus-email');
    expect(stateRecipeKey(pressRecipe)).toBe('press-open-menu-arrowdown');

    // --- hover ---
    await page.goto(page.url(), { waitUntil: 'load' });
    const hoverBefore = await captureStyleMap(page, { captureStates: false });
    const hoverApplied = await applyStateRecipe(page, hoverRecipe);
    expect(hoverApplied).toEqual(
      expect.objectContaining({
        stateKey: 'hover-plan-card',
        action: 'hover',
        selector: '#card',
        label: 'Plan card',
      }),
    );
    await expect(page.locator('body')).toHaveClass(/card-hovered/);
    const hoverAfter = await captureStyleMap(page, { captureStates: false });
    expect(diffStyleMaps(hoverBefore, hoverAfter).length, 'hover changes computed styles').toBeGreaterThan(0);

    // --- focus ---
    await page.goto(page.url(), { waitUntil: 'load' });
    const focusBefore = await captureStyleMap(page, { captureStates: false });
    const focusApplied = await applyStateRecipe(page, focusRecipe);
    expect(focusApplied.stateKey).toBe('focus-email');
    await expect(page.locator('body')).toHaveClass(/email-focused/);
    const focusAfter = await captureStyleMap(page, { captureStates: false });
    expect(diffStyleMaps(focusBefore, focusAfter).length, 'focus changes computed styles').toBeGreaterThan(0);

    // --- keyboard press opens listbox ---
    await page.goto(page.url(), { waitUntil: 'load' });
    const pressBefore = await captureStyleMap(page, { captureStates: false });
    const pressApplied = await applyStateRecipe(page, pressRecipe);
    expect(pressApplied).toEqual(
      expect.objectContaining({
        stateKey: 'press-open-menu-arrowdown',
        action: 'press',
        key: 'ArrowDown',
      }),
    );
    await expect(page.locator('#list')).toBeVisible();
    const pressAfter = await captureStyleMap(page, { captureStates: false });
    expect(diffStyleMaps(pressBefore, pressAfter).length, 'press opens listbox styles').toBeGreaterThan(0);

    // stateRecipeDriver is the SurfaceVariant.go adapter
    await page.goto(page.url(), { waitUntil: 'load' });
    const driver = stateRecipeDriver(focusRecipe);
    const driven = await driver(page);
    expect(driven.stateKey).toBe('focus-email');
  });
});

test('state recipes: refuse destructive labels (declared and live)', async ({ browser }) => {
  await withFixture(browser, async (page) => {
    await expect(
      applyStateRecipe(page, {
        action: 'hover',
        selector: '#danger',
        label: 'Delete account',
      }),
    ).rejects.toBeInstanceOf(StateRecipeError);

    // Live label only — declared label omitted; driver must still refuse.
    await expect(
      applyStateRecipe(page, {
        action: 'focus',
        selector: '#danger',
      }),
    ).rejects.toThrow(/destructive-action guard/);

    // Safe control still works after a refused attempt
    const applied = await applyStateRecipe(page, {
      action: 'focus',
      selector: '#email',
      label: 'Email',
    });
    expect(applied.stateKey).toBe('focus-email');
  });
});

test('state recipes: repeated runs produce identical keys', async ({ browser }) => {
  await withFixture(browser, async (page) => {
    const recipe = { action: 'press' as const, selector: '#menu', key: 'Enter', label: 'Open menu' };
    const first = await applyStateRecipe(page, recipe);
    await page.goto(page.url(), { waitUntil: 'load' });
    const second = await applyStateRecipe(page, recipe);
    expect(first.stateKey).toBe(second.stateKey);
    expect(first.stateKey).toBe('press-open-menu-enter');
  });
});
