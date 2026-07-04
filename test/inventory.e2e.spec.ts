import { test, expect } from '@playwright/test';
import { harvestInventory, diffInventory, auditRemovals } from '../dist/index.js';

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
