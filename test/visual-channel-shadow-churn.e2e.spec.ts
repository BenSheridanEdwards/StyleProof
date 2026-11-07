import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { pairFixture, rmTmp } from './helpers.mjs';
import { generateStyleMapReport } from '../dist/report.js';
import { diffStyleMapsWithEvidence } from '../dist/diff.js';
import { isUnder, type StyleMap } from '../dist/capture.js';
import { STATE_LAYER_NAMES } from '../dist/capture/forced-states.js';
import { captureStyleMap, diffStyleMaps } from '../dist/index.js';
import { assertDeterministicVisualChannels } from '../dist/visual-channels.js';

/** A missed edit must disclose the affected layer, rather than silently looking clean. */
function assertHoverMissExplained(before: StyleMap, after: StyleMap): void {
  const result = diffStyleMapsWithEvidence(before, after);
  const fixture = pairFixture({ surface: 'home@800', before, after });
  try {
    const report = generateStyleMapReport(fixture);
    const md = fs.readFileSync(report.reportMdPath, 'utf8');
    const json = JSON.parse(fs.readFileSync(report.reportJsonPath, 'utf8'));
    const targets = new Set(
      [...Object.entries(before.elements), ...Object.entries(after.elements)]
        .filter(([, element]) => element.tag === 'button')
        .map(([path]) => path),
    );
    expect(targets.size).toBe(20);
    const reported = new Set(
      result.findings.flatMap((finding) =>
        finding.kind === 'state' &&
        finding.state === 'hover' &&
        finding.props.some((prop) => prop.prop === 'animation keyframes (hk)')
          ? [finding.sub]
          : [],
      ),
    );
    const incomplete = before.statesSkipped || after.statesSkipped || json.statesUncertified > 0;
    for (const target of targets) {
      if (reported.has(target)) continue;
      const limited = (result.visualChannels?.limits ?? []).some(
        (limit) => limit.state === 'hover' && (limit.path === target || limit.owner === target),
      );
      const volatile = isUnder(target, [...(before.volatile ?? []), ...(after.volatile ?? [])]);
      expect(incomplete || volatile || limited, JSON.stringify({ target, before, after, report: json })).toBe(true);
    }
    expect(md).toMatch(/not certified/i);
    if (incomplete) expect(md).toMatch(/forced.state.*incomplete/i);
    else expect(md).toMatch(/not compared|live region|volatile/i);
  } finally {
    rmTmp(fixture.root);
  }
}

for (const mode of ['open', 'closed'] as const)
  test(`100ms ${mode} web-component row replacement stays deterministic and detects 20 hover edits`, async ({
    page,
  }) => {
    const maps = [];
    for (const opacity of ['.5', '.5', '.6']) {
      await page.goto('about:blank');
      await page.setContent(
        `<style>@keyframes k{to{opacity:${opacity}}}@keyframes hk{to{opacity:${opacity}}}.k{animation:k 1s linear 100s infinite paused both}button:hover{animation:hk 1s linear 100s infinite paused both}#clock{position:absolute;right:0;top:0}</style><div id=clock></div><div class=k>k</div>${'<button>x</button>'.repeat(20)}`,
      );
      await page.evaluate((mode) => {
        const name = `x-row-${mode}`;
        if (!customElements.get(name))
          customElements.define(
            name,
            class extends HTMLElement {
              constructor() {
                super();
                this.attachShadow({ mode }).innerHTML = '<b>row</b>';
              }
            },
          );
        const clock = document.querySelector('#clock')!;
        clock.replaceChildren(document.createElement(name));
        setInterval(() => clock.replaceChildren(document.createElement(name)), 100);
      }, mode);
      maps.push(await captureStyleMap(page, { captureVisualChannels: true }));
    }
    expect(() => assertDeterministicVisualChannels(maps[0], maps[1], 'component rows')).not.toThrow();
    expect(
      diffStyleMaps(maps[0], maps[1])
        .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
        .filter((p) => p.prop.includes('keyframes')),
    ).toHaveLength(0);
    const edits = diffStyleMaps(maps[1], maps[2]).flatMap((f) => (f.kind === 'dom' ? [] : f.props));
    if (edits.filter((p) => p.prop === 'animation keyframes (hk)').length !== 20)
      assertHoverMissExplained(maps[1], maps[2]);
    expect(edits.filter((p) => p.prop === 'animation keyframes (hk)')).toHaveLength(20);
    expect(edits.filter((p) => p.prop === 'animation keyframes (k)')).toHaveLength(1);
  });

test('one failed resting boundary proof keeps all later state evidence unknown', async ({ page }) => {
  const context = page.context(),
    native = context.newCDPSession.bind(context);
  let failed = false;
  context.newCDPSession = async (...args) => {
    const client = await native(...args),
      send = client.send.bind(client);
    client.send = async (method, params) => {
      if (!failed && method === 'DOM.getDocument' && (params as { depth?: number })?.depth === -1) {
        failed = true;
        throw new Error('deliberate one-read boundary failure');
      }
      return send(method, params);
    };
    return client;
  };
  try {
    await page.setContent(
      '<style>@keyframes k{to{opacity:.5}}.k{animation:k 1s linear 100s paused both}button:hover{animation:k 1s linear 100s paused both}</style><div class=k>x</div><button>x</button>',
    );
    const map = await captureStyleMap(page, { captureVisualChannels: true });
    expect(failed).toBe(true);
    expect(Object.values(map.visualChannels!.keyframes).every((model) => model.status === 'unknown')).toBe(true);
  } finally {
    context.newCDPSession = native;
  }
});

test('a static closed root with an unsized known raster preserves a real body edit', async ({ page }) => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  await page.route('http://media.test/**', (route) =>
    route.fulfill({
      contentType: route.request().url().endsWith('.png') ? 'image/png' : 'text/html',
      body: route.request().url().endsWith('.png') ? png : '<html></html>',
    }),
  );
  const maps = [];
  for (const opacity of ['.5', '.6']) {
    await page.goto('http://media.test/');
    await page.setContent(
      `<style>@keyframes k{to{opacity:${opacity}}}.k{animation:k 1s linear 100s paused both}</style><div class=k>x</div><x-icon></x-icon>`,
    );
    await page.evaluate(() => {
      document.querySelector('x-icon')!.attachShadow({ mode: 'closed' }).innerHTML = '<img src="/pixel.png">';
    });
    await page.waitForLoadState('networkidle');
    maps.push(await captureStyleMap(page, { captureVisualChannels: true, captureStates: false }));
  }
  expect(Object.values(maps[0].visualChannels!.keyframes).every((m) => m.status === 'known')).toBe(true);
  expect(
    diffStyleMaps(maps[0], maps[1])
      .flatMap((f) => (f.kind === 'dom' ? [] : f.props))
      .filter((p) => p.prop.includes('keyframes')),
  ).toHaveLength(1);
});

test('an uncaptured hover edit explicitly leaves the native forced-state layer uncertified', async ({ page }) => {
  const maps = [];
  for (const opacity of ['.5', '.6']) {
    await page.goto('about:blank');
    await page.setContent(
      `<style>@keyframes k{to{opacity:.5}}@keyframes hk{to{opacity:${opacity}}}.k{animation:k 1s linear 100s paused both}button:hover{animation:hk 1s linear 100s paused both}</style><div class=k>x</div>${'<button>x</button>'.repeat(20)}`,
    );
    maps.push(await captureStyleMap(page, { captureVisualChannels: true, captureStates: false }));
  }
  expect(diffStyleMaps(maps[0], maps[1])).toEqual([]);
  expect(maps.every((map) => map.statesSkipped)).toBe(true);
  assertHoverMissExplained(maps[0], maps[1]);
  const falselyComplete = maps.map((map) => {
    const copy = structuredClone(map);
    delete copy.statesSkipped;
    copy.stateLayers = [...STATE_LAYER_NAMES];
    copy.volatile = ['body > #unrelated-clock'];
    return copy;
  });
  expect(() => assertHoverMissExplained(falselyComplete[0], falselyComplete[1])).toThrow();
});
