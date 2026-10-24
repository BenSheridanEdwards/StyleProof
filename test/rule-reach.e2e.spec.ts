import { expect, test, type Page } from '@playwright/test';
import { captureStyleMap, diffStyleMaps, trackServedRules, type StyleMap } from '../dist/index.js';
import { classifyRuleReach } from '../dist/rule-reach.js';

// Change Reach J1 (#995), end to end: a PR restyles a fault overlay the spec never opens.
// Base and head capture byte-identically when only the healthy state is captured, so the
// diff is clean. The classifier still names the changed rule as never rendered, and once
// the fault state is captured the change is reached and the diff shows it.

const HTML = (fault: boolean) => `<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body>
  <main>
    <a class="link" href="#docs">Docs</a>
    <div class="panel"><span class="indicator">Probe A</span></div>
    ${fault ? '<div class="panel panel--fault"><span class="fault-badge">Fault</span><span class="indicator">Probe B</span></div>' : ''}
  </main>
</body></html>`;

const CSS = {
  base: `:root { --warn: rgb(22, 163, 74); }
    .indicator { color: rgb(22, 163, 74); }
    .panel--fault .indicator { color: rgb(22, 163, 74); }
    .fault-badge { color: var(--warn); }
    .link:hover { color: rgb(29, 78, 216); }
    @media (prefers-color-scheme: dark) { .panel { background: rgb(31, 41, 55); } }`,
  head: `:root { --warn: rgb(245, 158, 11); }
    .indicator { color: rgb(22, 163, 74); }
    .panel--fault .indicator { color: rgb(245, 158, 11); }
    .fault-badge { color: var(--warn); }
    .link:hover { color: rgb(124, 58, 237); }
    @media (prefers-color-scheme: dark) { .panel { background: rgb(17, 24, 39); } }`,
};

async function capture(page: Page, side: 'base' | 'head', fault: boolean): Promise<StyleMap> {
  await page.unrouteAll();
  await page.route('http://reach.test/**', (route) =>
    new URL(route.request().url()).pathname === '/app.css'
      ? route.fulfill({ contentType: 'text/css', body: CSS[side] })
      : route.fulfill({ contentType: 'text/html', body: HTML(fault) }),
  );
  const servedRules = await trackServedRules(page);
  try {
    await page.goto(`http://reach.test/?side=${side}&fault=${fault}`, { waitUntil: 'load' });
    return await captureStyleMap(page, { stabilize: false, captureReach: true, servedRules });
  } finally {
    await servedRules.dispose();
  }
}

const statuses = (base: StyleMap[], head: StyleMap[]) =>
  Object.fromEntries(classifyRuleReach(base, head).rules.map((r) => [r.key, r.status]));

test('a restyle confined to an uncaptured state is clean in the diff and never-rendered in reach', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const base = await capture(page, 'base', false);
  const head = await capture(page, 'head', false);

  // Today's gate: the :hover change is the only finding; the fault overlay never rendered.
  const findings = diffStyleMaps(base, head);
  expect(findings.map((f) => f.kind)).toEqual(['state']);
  expect(findings[0].cls).toContain('link');

  expect(statuses([base], [head])).toEqual({
    '.link:hover': 'reached',
    '.panel--fault .indicator': 'never-rendered',
    ':root': 'never-rendered', // --warn's only consumer, .fault-badge, never matched
    '@media (prefers-color-scheme: dark) > .panel': 'never-rendered',
  });
  const dark = classifyRuleReach([base], [head]).rules.find((r) => r.key.startsWith('@media'));
  expect(dark?.condition).toBe('@media (prefers-color-scheme: dark)');
});

test('capturing the fault state turns the hidden changes into reached changes the diff shows', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const base = [await capture(page, 'base', false), await capture(page, 'base', true)];
  const head = [await capture(page, 'head', false), await capture(page, 'head', true)];

  const faultFindings = diffStyleMaps(base[1], head[1]).filter((f) => f.kind === 'style');
  expect(faultFindings.map((f) => f.cls).sort()).toEqual(['fault-badge', 'indicator']);

  expect(statuses(base, head)).toEqual({
    '.link:hover': 'reached',
    '.panel--fault .indicator': 'reached',
    ':root': 'reached',
    '@media (prefers-color-scheme: dark) > .panel': 'never-rendered',
  });
});
