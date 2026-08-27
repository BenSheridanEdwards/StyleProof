import { test, expect } from '@playwright/test';
import http from 'node:http';
import {
  applyStateRecipe,
  stateRecipeGo,
  stateRecipeKey,
  captureStyleMap,
  diffStyleMaps,
  hashDeterminismMap,
  StateRecipeError,
} from '../dist/index.js';
import { expandSurfaceVariants } from '../dist/runner.js';

/**
 * Sticky interaction fixture: pure CSS :hover/:focus is intentionally neutralised
 * by captureStyleMap (hover-sink + blur) so resting maps stay clean. Real recipe
 * drivers still fire native hover/focus/press/click; the page mirrors those into
 * sticky classes so the computed-style map records the reached UI state — the same
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
    body.menu-clicked #menu { background: rgb(254, 226, 226); border: 2px solid rgb(220, 38, 38); }
    .toast { margin: 16px; padding: 12px; color: white; background: rgb(190, 24, 93); }
    .network-error { margin: 16px; padding: 12px; color: white; background: rgb(185, 28, 28); }
    button { margin: 16px; }
  </style></head><body>
    <div class="card" id="card" aria-label="Plan card" tabindex="0">Plan card</div>
    <p class="tip" id="tip">Hover tip</p>
    <label>Email <input id="email" aria-label="Email" /></label>
    <button id="menu" aria-label="Open menu" aria-haspopup="listbox">Menu</button>
    <button id="danger" aria-label="Delete account">Delete</button>
    <button id="notify" aria-label="Show notification">Notify</button>
    <button id="flash" aria-label="Show brief notification">Flash</button>
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
      menu.addEventListener('click', () => {
        document.body.classList.add('menu-clicked');
        document.body.classList.add('list-open');
      });
      function showToast(id, removeAfterMs) {
        document.getElementById(id)?.remove();
        const toast = document.createElement('div');
        toast.id = id;
        toast.className = 'toast';
        toast.textContent = 'private rendered toast copy';
        document.body.append(toast);
        if (removeAfterMs) setTimeout(() => toast.remove(), removeAfterMs);
      }
      document.getElementById('notify').addEventListener('click', () => showToast('toast', 0));
      document.getElementById('flash').addEventListener('click', () => showToast('flash-toast', 75));
      fetch('/api/plans')
        .then((response) => {
          if (!response.ok) throw new Error('request failed');
          return response.json();
        })
        .then(() => {
          document.body.dataset.plans = 'loaded';
        })
        .catch(() => {
          const error = document.createElement('div');
          error.id = 'network-error';
          error.className = 'network-error';
          error.textContent = 'private network error copy';
          document.body.append(error);
        });
    </script>
  </body></html>`;
}

async function withFixture(
  browser: import('@playwright/test').Browser,
  run: (page: import('@playwright/test').Page, baseUrl: string) => Promise<void>,
) {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/plans') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"plans":[]}');
      return;
    }
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

test('state recipes: hover/focus/press/click change computed maps with stable keys', async ({ browser }) => {
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
      key: 'ArrowDown' as const,
      label: 'Open menu',
    };
    const clickRecipe = {
      action: 'click' as const,
      selector: '#menu',
      label: 'Open menu',
    };

    expect(stateRecipeKey(hoverRecipe)).toBe('hover-plan-card');
    expect(stateRecipeKey(focusRecipe)).toBe('focus-email');
    expect(stateRecipeKey(pressRecipe)).toBe('press-open-menu-arrowdown');
    expect(stateRecipeKey(clickRecipe)).toBe('click-open-menu');

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

    // --- keyboard press opens listbox (explicit selector required) ---
    await page.goto(page.url(), { waitUntil: 'load' });
    const pressBefore = await captureStyleMap(page, { captureStates: false });
    const pressApplied = await applyStateRecipe(page, pressRecipe);
    expect(pressApplied).toEqual(
      expect.objectContaining({
        stateKey: 'press-open-menu-arrowdown',
        action: 'press',
        key: 'ArrowDown',
        selector: '#menu',
      }),
    );
    await expect(page.locator('#list')).toBeVisible();
    const pressAfter = await captureStyleMap(page, { captureStates: false });
    expect(diffStyleMaps(pressBefore, pressAfter).length, 'press opens listbox styles').toBeGreaterThan(0);

    // --- click opens listbox ---
    await page.goto(page.url(), { waitUntil: 'load' });
    const clickBefore = await captureStyleMap(page, { captureStates: false });
    const clickApplied = await applyStateRecipe(page, clickRecipe);
    expect(clickApplied).toEqual(
      expect.objectContaining({
        stateKey: 'click-open-menu',
        action: 'click',
        selector: '#menu',
      }),
    );
    await expect(page.locator('#list')).toBeVisible();
    await expect(page.locator('body')).toHaveClass(/menu-clicked/);
    const clickAfter = await captureStyleMap(page, { captureStates: false });
    expect(diffStyleMaps(clickBefore, clickAfter).length, 'click opens listbox styles').toBeGreaterThan(0);

    // stateRecipeGo is the SurfaceVariant.go adapter (Promise<void>)
    await page.goto(page.url(), { waitUntil: 'load' });
    const go = stateRecipeGo(focusRecipe);
    const driven = go(page);
    expect(driven).toBeInstanceOf(Promise);
    await expect(driven).resolves.toBeUndefined();
    await expect(page.locator('body')).toHaveClass(/email-focused/);
  });
});

test('state recipes: transient observation requires continuous visibility and emits privacy-safe diagnostics', async ({
  browser,
}) => {
  await withFixture(browser, async (page) => {
    const applied = await applyStateRecipe(page, {
      action: 'click',
      selector: '#notify',
      stateKey: 'held-toast',
      observeSelector: '#toast',
      observeMs: 100,
    });
    expect(applied).toEqual(expect.objectContaining({ stateKey: 'held-toast', observationMs: 100 }));
    await expect(page.locator('#toast')).toBeVisible();

    await page.goto(page.url(), { waitUntil: 'load' });
    const error = await applyStateRecipe(page, {
      action: 'click',
      selector: '#flash',
      stateKey: 'brief-toast',
      observeSelector: '#flash-toast',
      observeMs: 150,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StateRecipeError);
    expect(String((error as Error).message)).toMatch(/brief-toast.*continuous-visibility/);
    expect(String((error as Error).message)).not.toContain('#flash-toast');
    expect(String((error as Error).message)).not.toContain('private rendered toast copy');

    await page.goto(page.url(), { waitUntil: 'load' });
    await applyStateRecipe(page, {
      action: 'click',
      selector: '#flash',
      stateKey: 'brief-toast',
      observeSelector: '#flash-toast',
      observeMs: 50,
    });
    await expect(
      captureStyleMap(page, {
        captureStates: false,
        requiredVisibleState: { selector: '#flash-toast', stateKey: 'brief-toast' },
      }),
    ).rejects.toThrow(/brief-toast.*pre-capture/);
  });
});

test('state recipes: route setup captures a deterministic mocked network-error state with bounded provenance', async ({
  browser,
}) => {
  await withFixture(browser, async (page, baseUrl) => {
    await expect(page.locator('body')).toHaveAttribute('data-plans', 'loaded');
    const baseline = await captureStyleMap(page, { captureStates: false });

    const surfaces = expandSurfaceVariants({
      key: 'plans',
      go: async (surfacePage) => {
        await surfacePage.goto(baseUrl, { waitUntil: 'load' });
      },
      stateRecipes: [
        {
          action: 'route',
          stateKey: 'plans-network-error',
          urlPattern: '**/api/plans',
          status: 503,
        },
      ],
    });
    const networkError = surfaces[1];
    const hashes: string[] = [];
    for (let run = 0; run < 3; run++) {
      await networkError.go(page);
      await expect(page.locator('#network-error')).toBeVisible();
      const captured = await captureStyleMap(page, {
        captureStates: false,
        metadata: networkError.metadata,
      });

      expect(diffStyleMaps(baseline, captured).length).toBeGreaterThan(0);
      expect(captured.metadata).toEqual({
        surfaceKey: 'plans',
        variantKey: 'plans-network-error',
        variantKind: 'state-recipe',
        stateRecipe: {
          stateKey: 'plans-network-error',
          action: 'route',
          status: 503,
        },
      });
      const persisted = JSON.stringify(captured.metadata);
      expect(persisted).not.toContain('**/api/plans');
      expect(persisted).not.toContain('private network error copy');
      hashes.push(hashDeterminismMap(captured));

      // The one-shot route must not poison the reused page's next ordinary surface.
      await page.goto(baseUrl, { waitUntil: 'load' });
      await expect(page.locator('body')).toHaveAttribute('data-plans', 'loaded');
      await expect(page.locator('#network-error')).toHaveCount(0);
    }
    expect(new Set(hashes).size).toBe(1);
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

    // Click on destructive live label also refused
    await expect(
      applyStateRecipe(page, {
        action: 'click',
        selector: '#danger',
        label: 'Open details',
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

test('state recipes: declared label controls key while live label still guards danger', async ({ browser }) => {
  await withFixture(browser, async (page) => {
    const recipe = { action: 'hover' as const, selector: '#card', label: 'Marketing hero' };
    const applied = await applyStateRecipe(page, recipe);
    expect(applied.stateKey).toBe(stateRecipeKey(recipe));
    expect(applied.stateKey).toBe('hover-marketing-hero');
    expect(applied.label).toBe('Marketing hero');

    // No declared label: key stays selector-based even though live aria-label is "Plan card"
    const bare = await applyStateRecipe(page, { action: 'hover' as const, selector: '#card' });
    expect(bare.stateKey).toBe('hover-card');
    expect(bare.label).toBe('Plan card');

    await expect(
      applyStateRecipe(page, {
        action: 'focus',
        selector: '#danger',
        label: 'Safe declared label',
      }),
    ).rejects.toThrow(/destructive-action guard/);
  });
});

/** Normalize baseline→state findings for flake-resistant identity (not full maps). */
function normalizeDelta(findings: ReturnType<typeof diffStyleMaps>): string {
  return JSON.stringify(
    findings.map((f) => ({
      kind: f.kind,
      path: 'path' in f ? f.path : undefined,
      prop: 'prop' in f ? f.prop : undefined,
      before: 'before' in f ? f.before : undefined,
      after: 'after' in f ? f.after : undefined,
    })),
  );
}

test('state recipes: independent fresh-baseline runs share state key, provenance, and normalized delta', async ({
  browser,
}) => {
  // Focus is a stable sticky state (no pointer/hover-sink noise).
  const recipe = { action: 'focus' as const, selector: '#email', label: 'Email' };

  // withFixture returns void — reshape via collector
  async function collect(): Promise<{
    applied: Awaited<ReturnType<typeof applyStateRecipe>>;
    deltaNorm: string;
  }> {
    let out!: { applied: Awaited<ReturnType<typeof applyStateRecipe>>; deltaNorm: string };
    await withFixture(browser, async (page) => {
      const baseline = await captureStyleMap(page, { captureStates: false });
      const applied = await applyStateRecipe(page, recipe);
      const after = await captureStyleMap(page, { captureStates: false });
      const delta = diffStyleMaps(baseline, after);
      expect(applied.stateKey).toBe('focus-email');
      expect(delta.length).toBeGreaterThan(0);
      await expect(page.locator('body')).toHaveClass(/email-focused/);
      out = { applied, deltaNorm: normalizeDelta(delta) };
    });
    return out;
  }

  const first = await collect();
  const second = await collect();

  expect(second.applied.stateKey).toBe(first.applied.stateKey);
  expect(second.applied).toEqual(first.applied);
  // Equal normalized baseline→state delta only — not layout-volatile entire maps.
  expect(second.deltaNorm).toBe(first.deltaNorm);
});

test('state recipes: apply failure messages never echo secret selectors', async ({ browser }) => {
  await withFixture(browser, async (page) => {
    const secret = 'leaked-secret-value-9f3a';
    await expect(
      applyStateRecipe(page, {
        action: 'focus',
        selector: `input[value=${secret}]`,
      }),
    ).rejects.toThrow(/privacy policy/);

    try {
      await applyStateRecipe(page, { action: 'focus', selector: `input[value=${secret}]` });
      expect.fail('should reject');
    } catch (e) {
      const err = e as Error;
      const text = `${err.name}\n${err.message}\n${err.stack ?? ''}`;
      expect(text.includes(secret)).toBe(false);
    }

    // Missing target: error names action + stable key only (no Playwright locator dump).
    // Explicit stateKey so the message does not need the selector slug.
    try {
      await applyStateRecipe(page, {
        action: 'click',
        selector: '#does-not-exist-xyz',
        stateKey: 'missing-target',
      });
      expect.fail('should fail');
    } catch (e) {
      expect(e).toBeInstanceOf(StateRecipeError);
      const msg = String((e as Error).message);
      expect(msg).toBe('state recipe failed (click key=missing-target)');
      expect(msg).not.toMatch(/does-not-exist|locator|Timeout/i);
    }
  });
});

test('state recipes: preflight rejects >> selectors and non-slug labels without mutating target', async ({
  browser,
}) => {
  await withFixture(browser, async (page) => {
    const secret = 'leaked-chain-value-9f3a';
    // Snapshot mutation markers before any reject attempt
    const beforeClass = await page.locator('body').getAttribute('class');
    const emailFocusedBefore = await page.locator('body').evaluate((b) => b.classList.contains('email-focused'));
    const cardHoveredBefore = await page.locator('body').evaluate((b) => b.classList.contains('card-hovered'));
    const listOpenBefore = await page.locator('body').evaluate((b) => b.classList.contains('list-open'));

    // Playwright >> chaining — pure preflight (apply / go validates on build)
    for (const selector of [`>> ${secret}`, `button >> ${secret}`] as const) {
      await expect(applyStateRecipe(page, { action: 'focus', selector })).rejects.toThrow(/privacy policy/);
      expect(() => stateRecipeGo({ action: 'click', selector })).toThrow(/privacy policy/);
      try {
        await applyStateRecipe(page, { action: 'hover', selector });
        expect.fail('should reject');
      } catch (e) {
        const text = `${(e as Error).name}\n${(e as Error).message}\n${(e as Error).stack ?? ''}`;
        expect(text.includes(secret)).toBe(false);
        expect(text).toMatch(/privacy policy/);
      }
    }

    // Non-slug labels fail before browser I/O — target must stay pristine
    for (const label of ['🎉', '你好', '!!!'] as const) {
      await expect(applyStateRecipe(page, { action: 'focus', selector: '#email', label })).rejects.toThrow(
        /label rejected by privacy policy|slug-able/,
      );
      expect(() => stateRecipeGo({ action: 'hover', selector: '#card', label })).toThrow(
        /label rejected by privacy policy|slug-able/,
      );
    }

    // No mutation from any of the above rejects
    expect(await page.locator('body').getAttribute('class')).toBe(beforeClass);
    expect(await page.locator('body').evaluate((b) => b.classList.contains('email-focused'))).toBe(emailFocusedBefore);
    expect(await page.locator('body').evaluate((b) => b.classList.contains('card-hovered'))).toBe(cardHoveredBefore);
    expect(await page.locator('body').evaluate((b) => b.classList.contains('list-open'))).toBe(listOpenBefore);
    await expect(page.locator('#list')).toBeHidden();

    // Safe apply still works afterward
    const applied = await applyStateRecipe(page, {
      action: 'focus',
      selector: '#email',
      label: 'Email',
    });
    expect(applied.stateKey).toBe('focus-email');
    await expect(page.locator('body')).toHaveClass(/email-focused/);
  });
});
