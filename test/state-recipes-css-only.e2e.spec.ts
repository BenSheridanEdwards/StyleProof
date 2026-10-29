import { test, expect } from '@playwright/test';
import { captureStyleMap, diffStyleMaps } from '../dist/index.js';
import { expandSurfaceVariants } from '../dist/runner.js';
import { assertDeterministic } from '../dist/runner/self-check.js';
import { resolveSettings } from '../dist/runner/settings.js';

const html = `<!doctype html><html><head><style>
  body { margin: 0; }
  .card { padding: 16px; background: rgb(243, 244, 246); }
  .card:hover { background: rgb(219, 234, 254); }
  input { display: block; margin: 16px; border: 2px solid rgb(209, 213, 219); outline: none; }
  input:focus { border-color: rgb(124, 58, 237); }
</style></head><body>
  <div class="card" id="card" aria-label="Plan card">Plan card</div>
  <input id="email" aria-label="Email" />
</body></html>`;

for (const recipe of [
  { action: 'hover' as const, selector: '#card', label: 'Plan card' },
  { action: 'focus' as const, selector: '#email', label: 'Email' },
  { action: 'press' as const, selector: '#email', label: 'Email', key: 'ArrowDown' },
]) {
  test(`pure-CSS ${recipe.action} recipe survives capture and reports CSS changes`, async ({ page }) => {
    const [base, state] = expandSurfaceVariants({
      key: 'form',
      go: async (target) => {
        await target.setContent(html);
      },
      stateRecipes: [recipe],
    });

    await base.go(page);
    const resting = await captureStyleMap(page);
    await state.go(page);
    const after = await captureStyleMap(page, { metadata: state.metadata });
    expect(diffStyleMaps(resting, after).length, 'recipe differs from rest').toBeGreaterThan(0);
    expect(
      await page
        .locator(recipe.selector)
        .evaluate((element, action) => element.matches(action === 'hover' ? ':hover' : ':focus'), recipe.action),
    ).toBe(true);

    await assertDeterministic(
      page,
      state,
      after,
      resolveSettings({ dir: '.takeover/maps', freezeClock: false }),
      () => 0,
    );

    await page.addStyleTag({
      content: '.card:hover { background: rgb(255, 0, 0); } input:focus { border-color: rgb(0, 128, 0); }',
    });
    const changed = await captureStyleMap(page, { metadata: state.metadata });
    expect(diffStyleMaps(after, changed).length, 'recipe CSS change is reported').toBeGreaterThan(0);

    // A subsequent ordinary capture must still clear ambient hover and focus.
    const cleared = await captureStyleMap(page);
    expect(cleared.elements).toEqual(resting.elements);
  });
}
