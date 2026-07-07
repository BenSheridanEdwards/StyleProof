import { test, expect } from '@playwright/test';
import { harvestInventory, diffInventory, auditRemovals, captureStyleMap, auditRunInventory } from '../dist/index.js';

// Proves the in-page harvest end-to-end: run harvestInventory against two
// real rendered pages (a nav that drops an item between them) and confirm the diff
// catches the removal — the exact IA regression the certification diff is blind to.
const nav = (labels: string[], extra = ''): string =>
  'data:text/html,' +
  encodeURIComponent(
    `<!doctype html><html><body><nav>${labels
      .map((l) => `<button>${l}</button>`)
      .join('')}</nav>${extra}</body></html>`,
  );

test('harvest + diff catches a nav item removed between two rendered pages', async ({ page }) => {
  await page.goto(nav(['AGENTS', 'MODEL CONFIG', 'FAULTS', 'SKILLS']));
  const base = await harvestInventory(page);

  await page.goto(nav(['AGENTS', 'TEAMS', 'FAULTS', 'SKILLS']));
  const head = await harvestInventory(page);

  expect(base.map((i) => i.key)).toContain('nav-button:model-config');

  const delta = diffInventory(base, head);
  expect(delta.removed.map((i) => i.key)).toEqual(['nav-button:model-config']);
  expect(delta.added.map((i) => i.key)).toEqual(['nav-button:teams']);
  expect(auditRemovals(delta, {}).unexplained.length).toBe(1);
  expect(auditRemovals(delta, { 'nav-button:model-config': 'intentional' }).unexplained.length).toBe(0);
});

test('harvest reads role=tab and internal route links, keyed stably (real origin)', async ({ page }) => {
  // A real http origin (route-mocked) so relative hrefs resolve — data: URLs can't.
  await page.route('http://sp.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body>
        <div role="tablist"><button role="tab">Agents</button><button role="tab">Model Config</button></div>
        <nav><a href="/settings">Settings</a><a href="https://example.com/ext">External</a></nav>
      </body></html>`,
    }),
  );
  await page.goto('http://sp.test/');
  const keys = (await harvestInventory(page)).map((i) => i.key);
  expect(keys).toContain('tab:model-config'); // role=tab → slug
  expect(keys).toContain('route:/settings'); // internal link → path
  expect(keys).not.toContain('route:https://example.com/ext'); // cross-origin dropped
});

test('harvest reads an SVG <a> nav link (case-insensitive tag + xlink:href fallback)', async ({ page }) => {
  // SVG anchors report tagName `a` (lowercase) — the HTML-only `tagName === 'A'`
  // check missed them, so an SVG nav link never entered the inventory and its
  // removal never gated. An SVG 2 `href` and a legacy `xlink:href` must both resolve.
  await page.route('http://sp.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body>
        <svg width="200" height="40" viewBox="0 0 200 40">
          <a href="/reports"><text x="10" y="20">Reports</text></a>
          <a xlink:href="/billing"><text x="110" y="20">Billing</text></a>
        </svg>
      </body></html>`,
    }),
  );
  await page.goto('http://sp.test/');
  const keys = (await harvestInventory(page)).map((i) => i.key);
  expect(keys).toContain('route:/reports'); // SVG 2 href
  expect(keys).toContain('route:/billing'); // legacy xlink:href fallback
});

test('captureStyleMap({inventory:true}) stores map.inventory; auditRunInventory gates a removal', async ({ page }) => {
  await page.goto(nav(['AGENTS', 'MODEL CONFIG', 'FAULTS', 'SKILLS']));
  const base = await captureStyleMap(page, { inventory: true });
  await page.goto(nav(['AGENTS', 'TEAMS', 'FAULTS', 'SKILLS'])); // MODEL CONFIG dropped (a cutover)
  const head = await captureStyleMap(page, { inventory: true });

  expect(base.inventory?.map((i) => i.key)).toContain('nav-button:model-config');
  expect((await captureStyleMap(page)).inventory).toBeUndefined(); // opt-in — default off, nothing harvested

  const audit = auditRunInventory([base], [head], {});
  expect(audit.unexplained.map((i) => i.key)).toEqual(['nav-button:model-config']); // the gate would FAIL
  expect(audit.delta.added.map((i) => i.key)).toEqual(['nav-button:teams']);
  // acknowledging it clears the gate — a decision on the record
  expect(auditRunInventory([base], [head], { 'nav-button:model-config': 'moved to dossier' }).unexplained).toHaveLength(
    0,
  );
});
