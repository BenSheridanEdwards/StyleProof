import { test, expect } from '@playwright/test';
import http from 'node:http';
import { captureStyleMap, diffStyleMaps, harvestStyleVariants, type HarvestedVariant } from '../dist/index.js';

function fixture(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; font-family: system-ui, sans-serif; }
    nav { display: flex; gap: 8px; padding: 16px; }
    button, input, select { font: inherit; }
    .drawer { display: none; padding: 20px; background: rgb(12, 74, 110); color: white; }
    body.drawer-open .drawer { display: block; }
    .panel { display: none; padding: 12px; color: rgb(75, 85, 99); }
    .panel.active { display: block; color: rgb(5, 150, 105); }
    .plan-preview { padding: 10px 16px; color: rgb(31, 41, 55); }
    body.plan-pro .plan-preview { color: rgb(124, 58, 237); }
    form { padding: 16px; }
    form.errors input { border: 3px solid rgb(220, 38, 38); }
    .noop { color: rgb(17, 24, 39); }
    [role="status"] { min-height: 24px; }
  </style></head><body>
    <nav>
      <button aria-label="Open navigation" aria-expanded="false">Menu</button>
      <button aria-label="Show navigation" aria-expanded="false">Menu duplicate</button>
      <button role="tab" aria-selected="false">Details</button>
      <button class="noop">No-op</button>
      <button aria-label="Open reports">Reports</button>
      <button>Delete account</button>
      <button title="Revoke access"><svg width="16" height="16" aria-hidden="true"><rect width="16" height="16"></rect></svg></button>
    </nav>
    <aside class="drawer">Navigation drawer</aside>
    <section class="panel">Details panel</section>
    <label>Plan
      <select aria-label="Plan">
        <option value="free">Free</option>
        <option value="pro">Pro</option>
      </select>
    </label>
    <p class="plan-preview">Plan preview</p>
    <form aria-label="Signup form">
      <input required aria-label="Email">
      <button type="submit">Join</button>
    </form>
    <form aria-label="Broken form">
      <input required aria-label="Broken field">
    </form>
    <div role="status" aria-live="polite" aria-busy="true">Loading</div>
    <script>
      for (const button of document.querySelectorAll('[aria-expanded]')) {
        button.addEventListener('click', () => {
          document.body.classList.add('drawer-open');
          button.setAttribute('aria-expanded', 'true');
        });
      }
      document.querySelector('[role=tab]').addEventListener('click', (event) => {
        event.currentTarget.setAttribute('aria-selected', 'true');
        document.querySelector('.panel').classList.add('active');
      });
      document.querySelector('select').addEventListener('change', () => {
        document.body.classList.add('plan-pro');
      });
      document.querySelector('button[aria-label="Open reports"]').addEventListener('click', () => {
        location.href = '/reports';
      });
      document.querySelector('form').addEventListener('invalid', (event) => {
        event.currentTarget.classList.add('errors');
      }, true);
      document.querySelector('form[aria-label="Broken form"]').requestSubmit = () => {
        throw new Error('fixture submit failed');
      };
    </script>
  </body></html>`;
}

async function applyVariant(page: import('@playwright/test').Page, variant: HarvestedVariant): Promise<void> {
  const target = page.locator(variant.selector).first();
  if (variant.action === 'select-option') {
    await target.selectOption(variant.value ?? '');
  } else if (variant.action === 'submit-empty') {
    await target.evaluate((node) => {
      const form = node as HTMLFormElement;
      for (const control of form.querySelectorAll('input, textarea, select')) {
        if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) control.value = '';
        if (control instanceof HTMLSelectElement) control.selectedIndex = -1;
      }
      form.requestSubmit();
    });
  } else {
    await target.click();
  }
}

async function replayComputedMapDiff(
  page: import('@playwright/test').Page,
  baseUrl: string,
  variant: HarvestedVariant,
) {
  await page.goto(baseUrl, { waitUntil: 'load' });
  const before = await captureStyleMap(page, { captureStates: false });
  await applyVariant(page, variant);
  const after = await captureStyleMap(page, { captureStates: false });
  return diffStyleMaps(before, after);
}

test('harvestStyleVariants discovers one-step computed-style variants', async ({ browser }) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname === '/reports') {
      res.end('<!doctype html><html><body><main class="reports">Reports</main></body></html>');
    } else {
      res.end(fixture());
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as import('node:net').AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
  try {
    const page = await ctx.newPage();
    const harvest = await harvestStyleVariants(page, {
      baseUrl,
      routes: [{ key: 'home', url: '/' }],
      maxActionsPerRoute: 20,
    });
    const route = harvest.routes[0]!;
    expect(route.key).toBe('home');
    expect(route.variants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'click', reason: 'aria-expanded' }),
        expect.objectContaining({ action: 'click', reason: 'tab' }),
        expect.objectContaining({ action: 'submit-empty', reason: 'form-validation' }),
        expect.objectContaining({ action: 'select-option', reason: 'select-option', value: 'pro' }),
      ]),
    );
    expect(route.variants.some((variant) => variant.label === 'No-op')).toBe(false);
    expect(route.variants.filter((variant) => variant.reason === 'aria-expanded')).toHaveLength(1);
    expect(route.liveStates).toEqual([
      expect.objectContaining({
        fixtureRequired: true,
        role: 'status',
        ariaLive: 'polite',
        ariaBusy: 'true',
      }),
    ]);
    expect(route.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'unsafe-label',
          label: 'Delete account',
        }),
        // Icon-only control whose ONLY label is its title="Revoke access":
        // proves the label reads `title` (else it'd read "button" and be clicked)
        // AND that `revoke` lives in the shared DANGER list (the old variant-crawler
        // fork lacked it, so it would have been clicked as a benign toggle).
        expect.objectContaining({
          reason: 'unsafe-label',
          label: 'Revoke access',
        }),
        expect.objectContaining({
          reason: 'navigated',
          label: 'Open reports',
          detail: '/ -> /reports',
        }),
        expect.objectContaining({
          reason: 'action-failed',
          label: 'Broken form',
          detail: expect.stringContaining('fixture submit failed'),
        }),
      ]),
    );

    for (const reason of ['aria-expanded', 'tab', 'form-validation', 'select-option']) {
      const variant = route.variants.find((candidate) => candidate.reason === reason);
      expect(variant, `${reason} variant was harvested`).toBeTruthy();
      const findings = await replayComputedMapDiff(page, baseUrl, variant!);
      expect(findings.length, `${reason} replay changes the computed style map`).toBeGreaterThan(0);
    }

    const noopBefore = await captureStyleMap(page, { captureStates: false });
    await page.locator('.noop').click();
    const noopAfter = await captureStyleMap(page, { captureStates: false });
    expect(diffStyleMaps(noopBefore, noopAfter)).toEqual([]);

    await page.goto(baseUrl, { waitUntil: 'load' });
    const reportsBefore = await captureStyleMap(page, { captureStates: false });
    await page.getByLabel('Open reports').click();
    expect(new URL(page.url()).pathname).toBe('/reports');
    const reportsAfter = await captureStyleMap(page, { captureStates: false });
    expect(diffStyleMaps(reportsBefore, reportsAfter).length).toBeGreaterThan(0);
  } finally {
    await ctx.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
