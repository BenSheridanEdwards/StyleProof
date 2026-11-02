import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { captureStyleMap, diffStyleMaps, trackServedRules, type StyleMap } from '../dist/index.js';
import { classifyRuleReach } from '../dist/rule-reach.js';
import { classifyStyleProofVerdict } from '../dist/verdict.js';
import { stampCertifyingFixture } from './certifying-fixture.mjs';
import { mkTmp, rmTmp, spawnSyncToCompletion } from './helpers.mjs';

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
  headHidden: `:root { --warn: rgb(245, 158, 11); }
    .indicator { color: rgb(22, 163, 74); }
    .panel--fault .indicator { color: rgb(245, 158, 11); }
    .fault-badge { color: var(--warn); }
    .link:hover { color: rgb(29, 78, 216); }
    @media (prefers-color-scheme: dark) { .panel { background: rgb(17, 24, 39); } }`,
  head: `:root { --warn: rgb(245, 158, 11); }
    .indicator { color: rgb(22, 163, 74); }
    .panel--fault .indicator { color: rgb(245, 158, 11); }
    .fault-badge { color: var(--warn); }
    .link:hover { color: rgb(124, 58, 237); }
    @media (prefers-color-scheme: dark) { .panel { background: rgb(17, 24, 39); } }`,
};

async function capture(
  page: Page,
  side: keyof typeof CSS,
  fault: boolean,
  fixture: { html?: string; css?: string; ignore?: string[] } = {},
): Promise<StyleMap> {
  await page.unrouteAll();
  await page.route('http://reach.test/**', (route) =>
    new URL(route.request().url()).pathname === '/app.css'
      ? route.fulfill({ contentType: 'text/css', body: fixture.css ?? CSS[side] })
      : route.fulfill({ contentType: 'text/html', body: fixture.html ?? HTML(fault) }),
  );
  const servedRules = await trackServedRules(page);
  try {
    await page.goto(`http://reach.test/?side=${side}&fault=${fault}`, { waitUntil: 'load' });
    return await captureStyleMap(page, { stabilize: false, captureReach: true, servedRules, ignore: fixture.ignore });
  } finally {
    await servedRules.dispose();
  }
}

const statuses = (base: StyleMap[], head: StyleMap[]) =>
  Object.fromEntries(classifyRuleReach(base, head).rules.map((r) => [r.key, r.status]));

test('global relaxed selectors remain reached around framework-ignored elements', async ({ page }) => {
  const selectors = ['*, ::before, ::after', ':focus-visible', '::placeholder', '*::before', 'div:hover', 'div::after'];
  const maps: StyleMap[] = [];
  for (const side of ['base', 'head'] as const) {
    const color = side === 'base' ? 'red' : 'blue';
    maps.push(
      await capture(page, side, false, {
        html: `<!doctype html><html><head><title>Reach</title><link rel="stylesheet" href="/app.css"></head>
        <body><div><a href="#docs">Docs</a><input placeholder="Name"></div>
        <script type="application/json">{}</script><template><div>Template</div></template></body></html>`,
        css: selectors.map((selector) => `${selector} { color: ${color}; }`).join(' '),
      }),
    );
  }
  expect(await page.locator('[data-styleproof-hover-sink]').count()).toBe(1);
  expect(statuses([maps[0]], [maps[1]])).toEqual(
    Object.fromEntries(selectors.map((selector) => [selector, 'reached'])),
  );
});

test('inline-styled scrollers keep resting and forced-state changes reached', async ({ page }) => {
  const html = `<!doctype html><html style="margin:0"><head><link rel="stylesheet" href="/app.css"></head>
    <body style="margin:0"><main style=""><section>
      <div class="scroller" style="overflow-y:auto;max-height:300px!important">
        <a class="link" href="#docs">Docs</a>
        <div class="indicator" style="height:1000px">Content</div>
      </div>
    </section></main></body></html>`;
  const maps: StyleMap[] = [];
  for (const side of ['base', 'head'] as const) {
    const color = side === 'base' ? 'rgb(22, 163, 74)' : 'rgb(245, 158, 11)';
    maps.push(
      await capture(page, side, false, {
        html,
        css: `.indicator { color: ${color}; } .link:hover { color: ${color}; }`,
      }),
    );
  }
  expect(statuses([maps[0]], [maps[1]])).toEqual({
    '.indicator': 'reached',
    '.link:hover': 'reached',
  });
  expect(
    diffStyleMaps(maps[0], maps[1])
      .map((finding) => finding.kind)
      .sort(),
  ).toEqual(['state', 'style']);
  expect(
    await page
      .locator('html, body, main, section, .scroller')
      .evaluateAll((els) => els.map((el) => el.getAttribute('style'))),
  ).toEqual(['margin:0', 'margin:0', '', null, 'overflow-y:auto;max-height:300px!important']);
});

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

test('the README hidden restyle fails certify and needs review with the reach gate', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const base = await capture(page, 'base', false);
  const head = await capture(page, 'headHidden', false);
  expect(diffStyleMaps(base, head)).toEqual([]);

  const root = mkTmp('styleproof-reach-gate-');
  try {
    const before = path.join(root, 'before');
    const after = path.join(root, 'after');
    const baseSha = 'a'.repeat(40);
    const headSha = 'b'.repeat(40);
    for (const [dir, map, sha] of [
      [before, base, baseSha],
      [after, head, headSha],
    ] as const) {
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(dir, 'home@900.json.gz'),
        gzipSync(
          JSON.stringify({
            ...map,
            metadata: { ...map.metadata, productState: { id: 'home-ready', revision: 'fixture-v2' } },
          }),
        ),
      );
      stampCertifyingFixture(dir, sha);
    }
    const configPath = path.join(root, 'styleproof.config.json');
    fs.writeFileSync(configPath, JSON.stringify({ changeReach: 'gate' }));
    const args = [
      fileURLToPath(new URL('../bin/styleproof-diff.mjs', import.meta.url)),
      before,
      after,
      '--expected-before-sha',
      baseSha,
      '--expected-after-sha',
      headSha,
      '--json',
      'styleproof-diff.json',
    ];
    const gate = spawnSyncToCompletion(process.execPath, args, { cwd: root, encoding: 'utf8' });
    expect(gate.status, gate.stderr || gate.stdout).toBe(1);
    const receipt = JSON.parse(fs.readFileSync(path.join(root, 'styleproof-diff.json'), 'utf8'));
    expect(receipt.reach.blocking).toBeGreaterThan(0);
    const options = { gateInventoryRemovals: true, baseCaptureFailed: false, changed: true };
    expect(classifyStyleProofVerdict(receipt, { ...options, certifyGate: true }).state).toBe('CERTIFICATION_FAILED');
    expect(classifyStyleProofVerdict(receipt, { ...options, certifyGate: false }).state).toBe('STYLE_REVIEW_REQUIRED');

    fs.unlinkSync(configPath);
    const warn = spawnSyncToCompletion(process.execPath, args, { cwd: root, encoding: 'utf8' });
    expect(warn.status, warn.stderr || warn.stdout).toBe(0);
  } finally {
    rmTmp(root);
  }
});

test('rules matching only ignored, shadow or iframe elements are unmeasured', async ({ page }) => {
  const fixture = (side: 'base' | 'head') => {
    const color = side === 'base' ? 'rgb(22, 163, 74)' : 'rgb(245, 158, 11)';
    return {
      ignore: ['.ads'],
      css: `.visible { color: ${color}; }
        .ads .promo { color: ${color}; }
        .shared { color: ${color}; }`,
      html: `<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body>
        <p class="visible">Visible</p>
        <p class="shared">Shared and compared</p>
        <div class="ads"><span class="promo shared">Ignored</span></div>
        <div id="shadow-host"></div>
        <iframe srcdoc="<style>.frame-copy { color: ${color}; }</style><p class='frame-copy'>Frame</p>"></iframe>
        <script>
          document.getElementById('shadow-host').attachShadow({ mode: 'open' }).innerHTML =
            '<style>.shadow-title { color: ${color}; }</style><p class="shadow-title">Shadow</p>';
        </script>
      </body></html>`,
    };
  };
  // capture() waits for load, including the same-origin srcdoc iframe, before reading either map.
  const base = await capture(page, 'base', false, fixture('base'));
  const head = await capture(page, 'head', false, fixture('head'));

  const findings = diffStyleMaps(base, head);
  expect(findings.map((f) => f.kind)).toEqual(['style', 'style']);
  expect(findings.map((f) => f.cls).sort()).toEqual(['shared', 'visible']);
  expect(statuses([base], [head])).toEqual({
    '.ads .promo': 'unmeasured',
    '.frame-copy': 'unmeasured',
    '.shadow-title': 'unmeasured',
    '.shared': 'reached',
    '.visible': 'reached',
  });
});

for (const opacity of ['1', '.5']) {
  test(`merged opacity declaration reach: ${opacity}`, async ({ page }) => {
    const html =
      '<html><head><link rel="stylesheet" href="/app.css"></head><body><p class="text-red-500">Red</p><p class="text-blue-500">Blue</p></body></html>';
    const colors = [
      ['red', '239 68 68'],
      ['blue', '59 130 246'],
      ['green', '34 197 94'],
    ];
    const baseCSS = colors
      .map(([name, rgb]) => `.text-${name}-500{--tw-text-opacity:1;color:rgb(${rgb}/var(--tw-text-opacity))}`)
      .join('');
    const headCSS =
      colors
        .map(
          ([name, rgb]) =>
            `.text-${name}-500{${name === 'green' ? '--tw-text-opacity:1;' : ''}color:rgb(${rgb}/var(--tw-text-opacity))}`,
        )
        .join('') + `.text-red-500,.text-blue-500{--tw-text-opacity:${opacity}}`;
    const base = await capture(page, 'base', false, { html, css: baseCSS });
    const head = await capture(page, 'head', false, { html, css: headCSS });
    const result = classifyRuleReach([base], [head]);
    if (opacity === '1') {
      expect(diffStyleMaps(base, head)).toEqual([]);
      expect(result.rules.every((r) => r.status === 'reached')).toBe(true);
    } else {
      expect(diffStyleMaps(base, head).length).toBeGreaterThan(0);
      expect(result.rules.find((r) => r.key === '.text-red-500,.text-blue-500')).toMatchObject({
        status: 'never-rendered',
        why: expect.stringContaining('.text-green-500'),
      });
    }
  });
}
