/**
 * QA12-01 on a live Chromium capture: one page holds every combination of one or two controls, the
 * same or different states, and the label's own hover or not. The capture records, per finding,
 * which control's state was forced; the report (and the PR comment, approved or not) must name
 * exactly that control for each state, through the same oracle as the unit matrix.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { captureStyleMap } from '../dist/index.js';
import { captureStateLayerScreenshots } from '../dist/capture.js';
import { writeCaptureManifest } from '../dist/map-store.js';
import { generateStyleMapReport } from '../dist/report.js';
import { mkTmp, rmTmp, writeCapture } from './helpers.mjs';
import { attributionCheck } from './state-attribution-oracle.mjs';
import { runActionComment } from './action-comment-harness.mjs';

type Control = { word: string; tag: 'input' | 'button'; state: 'checked' | 'hover' | 'focus'; prop: string };
type Group = { controls: Control[]; ownHover: boolean };

// Each control's class (and a button's text) is one distinct word, so the sentence's noun names it.
const WORDS =
  'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(
    ' ',
  );
const PROPS = ['color', 'background-color', 'outline-color'];
const CONFIGS: Array<Array<[Control['tag'], Control['state']]>> = [
  [['input', 'checked']],
  [['input', 'hover']],
  [
    ['input', 'checked'],
    ['button', 'focus'],
  ],
  [
    ['input', 'checked'],
    ['input', 'checked'],
  ],
  [
    ['input', 'hover'],
    ['button', 'focus'],
  ],
  [
    ['input', 'checked'],
    ['input', 'hover'],
  ],
];
const GROUPS: Group[] = [];
let next = 0;
for (const config of CONFIGS)
  for (const ownHover of [false, true])
    GROUPS.push({
      ownHover,
      controls: config.map(([tag, state], i) => ({ word: WORDS[next++], tag, state, prop: PROPS[i] })),
    });

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"></head><body>
${GROUPS.map(
  (g, n) =>
    `<div class="row">${g.controls
      .map((c) =>
        c.tag === 'input'
          ? `<input type="checkbox" class="${c.word}">`
          : `<button type="button" class="${c.word}">${c.word}</button>`,
      )
      .join('')}<label class="target${n}">Choice ${n}</label></div>`,
).join('\n')}
</body></html>`;

const css = (head: boolean) =>
  [
    'body { margin: 0; font-family: sans-serif; } .row { display: flex; gap: 8px; padding: 6px 12px; } label { padding: 2px 6px; }',
    ...GROUPS.flatMap((g, n) => [
      ...g.controls.map(
        (c) => `.${c.word}:${c.state} ~ .target${n} { ${c.prop}: ${head ? 'rgb(160, 40, 40)' : 'rgb(20, 120, 60)'}; }`,
      ),
      ...(g.ownHover ? [`.target${n}:hover { font-weight: ${head ? 700 : 400}; }`] : []),
    ]),
  ].join('\n');

test('every captured state names the control the capture recorded for it (QA12-01)', async ({ page }) => {
  test.setTimeout(120_000);
  const root = mkTmp('styleproof-attribution-e2e-');
  try {
    await page.setViewportSize({ width: 900, height: 700 });
    for (const side of ['base', 'head'] as const) {
      await page.unroute('http://controls.test/**');
      await page.route('http://controls.test/**', (route) =>
        route.request().url().endsWith('/styles.css')
          ? route.fulfill({ contentType: 'text/css', body: css(side === 'head') })
          : route.fulfill({ contentType: 'text/html', body: html }),
      );
      await page.goto('http://controls.test/', { waitUntil: 'load' });
      const map = await captureStyleMap(page);
      const dir = path.join(root, side);
      writeCapture(dir, 'controls@900', map, await page.screenshot({ type: 'png', fullPage: true }));
      await captureStateLayerScreenshots(page, path.join(dir, 'controls@900'));
      writeCaptureManifest({ dir, screenshots: true });
    }
    const outDir = path.join(root, 'report');
    const result = generateStyleMapReport({
      beforeDir: path.join(root, 'base'),
      afterDir: path.join(root, 'head'),
      outDir,
    });
    const md = fs.readFileSync(result.reportMdPath, 'utf8');
    const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
    const states = json.surfaces
      .flatMap((s: { findings?: Array<{ kind: string }> }) => s.findings ?? [])
      .filter((f: { kind: string }) => f.kind === 'state');
    // The capture recorded a control-driven finding for every control in every group.
    for (const g of GROUPS)
      for (const c of g.controls)
        expect(
          states.some((f: { cls?: string }) => f.cls === c.word),
          `${c.word}:${c.state} was captured`,
        ).toBe(true);
    const problems = attributionCheck(md, json, 'report.md');
    for (const approved of [false, true]) {
      const comment = await runActionComment({
        reportDir: outDir,
        mode: 'review-gate',
        trustState: 'STYLE_REVIEW_REQUIRED',
        approved,
      });
      problems.push(...attributionCheck(comment, json, `comment${approved ? ' (approved)' : ''}`));
    }
    expect(problems).toEqual([]);
  } finally {
    rmTmp(root);
  }
});
