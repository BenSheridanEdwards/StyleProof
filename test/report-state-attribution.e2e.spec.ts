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
import { attributionCheck, elementsIn } from './state-attribution-oracle.mjs';
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

// QA13's live shapes (check/round-13/qa/site-break): two `input.opt` controls restyling different
// properties of one paragraph (QA13-01), `input.pickr` and `select.pickr` sharing a noun (QA13-02),
// and two `input.tick` controls making one identical change (main's ×2 block). Then QA14-01's live
// shapes (check/round-14/qa/site-r14): four `input.pair` in two identical pairs, and three
// `input.chip` restyling one property each. Main cannot tell those owners apart, so each owner path
// is its own clause named as main names it, with nothing invented ("one … another").
const LIVE_QA13_HTML = `<section class="row"><input type="checkbox" id="news" class="opt"><input type="checkbox" id="gift" class="opt"><p class="summary">Your choices</p></section>
<section class="row"><input type="text" class="pickr"><select class="pickr"><option>One</option></select><p class="note">Pick note</p></section>
<section class="row"><input type="checkbox" id="one" class="tick"><input type="checkbox" id="two" class="tick"><p class="shared">Shared change</p></section>
<section class="row"><input type="checkbox" id="pa" class="pair"><input type="checkbox" id="pb" class="pair"><input type="checkbox" id="pc" class="pair"><input type="checkbox" id="pd" class="pair"><p class="pairs">Two pairs</p></section>
<section class="row"><input type="checkbox" id="qx" class="chip"><input type="checkbox" id="qy" class="chip"><input type="checkbox" id="qz" class="chip"><p class="chips">Chip result</p></section>
<section class="row"><input type="checkbox" class="opt3"><input type="checkbox" class="opt3"><label class="tag">Badge</label></section>
<section class="row"><input type="checkbox" class="pick"><input type="checkbox" class="pick"><a class="pill" href="#pill">Pill</a></section>
<section class="row"><input type="checkbox" class="duo"><input type="checkbox" class="duo"><label class="pill2">Pill two</label></section>
<section class="row"><input type="checkbox" class="twin"><input type="checkbox" class="twin"><a class="twinlink" href="#twin">Twin</a></section>
<section class="row"><input type="checkbox" class="ringon"><span class="ring">Ring</span></section>
<section class="row"><input type="checkbox" class="rg"><input type="checkbox" class="rg"><span class="ring2">Ring two</span></section>`;
const liveQa13Css = (head: boolean) => {
  const [red, yellow] = head ? ['rgb(160, 40, 40)', 'rgb(255, 224, 138)'] : ['rgb(20, 120, 60)', 'rgb(200, 220, 255)'];
  return [
    '.summary, .note, .shared, .pairs, .chips { padding: 2px 6px; color: rgb(34, 34, 34); background: rgb(240, 240, 240); }',
    '.pairs, .chips { border: 2px solid rgb(200, 200, 200); }',
    `#news:checked ~ .summary { color: ${red}; }`,
    `#gift:checked ~ .summary { background: ${yellow}; }`,
    `input.pickr:focus ~ .note { color: ${red}; }`,
    `select.pickr:focus ~ .note { background: ${yellow}; }`,
    `.tick:checked ~ .shared { color: ${red}; }`,
    `#pa:checked ~ .pairs, #pb:checked ~ .pairs { color: ${red}; }`,
    `#pc:checked ~ .pairs, #pd:checked ~ .pairs { background: ${yellow}; }`,
    `#qx:checked ~ .chips { color: ${red}; }`,
    `#qy:checked ~ .chips { background: ${yellow}; }`,
    `#qz:checked ~ .chips { border-color: ${head ? 'rgb(0, 160, 80)' : 'rgb(0, 0, 0)'}; }`,
    // QA16 (check/round-16/qa/site-r16): a visible border that turns red with the text, and an own
    // hover beside two controls' hovers.
    '.tag, .pill { display: inline-block; padding: 4px 10px; color: rgb(20, 120, 60); background: #fff; border: 2px solid rgb(20, 120, 60); }',
    `.opt3:nth-of-type(1):checked ~ .tag { color: ${red}; border-color: ${red}; }`,
    `.opt3:nth-of-type(2):checked ~ .tag { color: ${red}; }`,
    `.pill:hover, .pick:nth-of-type(1):hover ~ .pill { color: ${red}; }`,
    `.pick:nth-of-type(2):hover ~ .pill { background-color: ${yellow}; }`,
    // QA17 (check/round-17/qa/site-r17, site-r17c): two controls with overlapping changes on a
    // bordered pill; an own hover beside two identical controls; a drawn outline that follows the
    // text colour, from one control and from one of two.
    '.pill2 { display: inline-block; padding: 4px 10px; color: rgb(20, 120, 60); background: #fff; border: 2px solid rgb(20, 120, 60); }',
    `.duo:nth-of-type(1):checked ~ .pill2 { color: ${red}; border-color: ${red}; }`,
    `.duo:nth-of-type(2):checked ~ .pill2 { color: ${red}; background-color: ${yellow}; }`,
    `.twinlink:hover, .twin:hover ~ .twinlink { background-color: ${yellow}; }`,
    '.ring, .ring2 { display: inline-block; padding: 4px 10px; color: rgb(20, 120, 60); outline: 3px solid; outline-offset: 2px; }',
    '.ring2 { outline-color: rgb(20, 120, 60); }',
    `.ringon:checked ~ .ring { color: ${red}; }`,
    `.rg:nth-of-type(1):checked ~ .ring2 { color: ${red}; outline-color: ${red}; }`,
    `.rg:nth-of-type(2):checked ~ .ring2 { color: ${red}; }`,
  ];
};

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
${LIVE_QA13_HTML}
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
    ...liveQa13Css(head),
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
    const section = (title: string) => md.split('\n### ').find((s) => s.startsWith(title)) ?? '';
    // The CPO's round-18 fallback: one clause per owner path, named as main names it (two `input.opt`
    // read alike, nothing invented), identical owners of one selector as main's ×N, the own state its
    // own clause, no counted wording and no tail; drawn borders and outlines named (QA17-01…04).
    const line = (title: string) =>
      section(title)
        .split('\n')
        .find((l) => /^(?:On|The) /.test(l)) ?? '';
    expect(line('Summary')).toMatch(
      /the text colour changes from [^,]+ to [^,]+ when `input\.opt` is checked, and the background changes from [^,.]+ to [^,.]+ when `input\.opt` is checked\./,
    );
    expect(line('Summary')).not.toMatch(/border/);
    expect(line('Pairs')).toMatch(
      /the text colour changes from [^,]+ to [^,]+ when `input\.pair` ×2 is checked, and the background changes from [^,.]+ to [^,.]+ when `input\.pair` ×2 is checked\./,
    );
    expect(line('Chips')).toMatch(
      /the text colour changes from [^,]+ to [^,]+ when `input\.chip` is checked, the background changes from [^,]+ to [^,]+ when `input\.chip` is checked, and the border colour changes from [^,.]+ to [^,.]+ when `input\.chip` is checked\./,
    );
    expect(line('Tag')).toMatch(
      /the border colour changes from [^,]+ to [^,]+ and text colour from [^,]+ to [^,]+ when `input\.opt3` is checked, and the text colour changes from [^,.]+ to [^,.]+ when `input\.opt3` is checked\./,
    );
    expect(line('Pill link')).toMatch(
      /the text colour changes from [^,]+ to [^,]+ when hovered, the text colour changes from [^,]+ to [^,]+ when `input\.pick` is hovered, and the background changes from [^,.]+ to [^,.]+ when `input\.pick` is hovered\./,
    );
    expect(line('Pill2')).toMatch(
      /the border colour changes from [^,]+ to [^,]+ and text colour from [^,]+ to [^,]+ when `input\.duo` is checked, and the background changes from [^,]+ to [^,]+ and text colour from [^,.]+ to [^,.]+ when `input\.duo` is checked\./,
    );
    expect(line('Twin link')).toMatch(
      /the background changes from [^,]+ to [^,]+ when hovered, and the background changes from [^,.]+ to [^,.]+ when `input\.twin` ×2 is hovered\./,
    );
    expect(line('Ring')).toMatch(
      /the text colour changes from [^,]+ to [^,]+ and outline colour from [^,.]+ to [^,.]+ when the ringon is checked\./,
    );
    expect(line('Ring2')).toMatch(
      /the text colour changes from [^,]+ to [^,]+ and outline colour from [^,]+ to [^,]+ when `input\.rg` is checked, and the text colour changes from [^,.]+ to [^,.]+ when `input\.rg` is checked\./,
    );
    expect(md).not.toMatch(/one of the \d+|either of the|any of the|each changes|also change|and \d+ more/);
    expect(md).not.toMatch(/when (?:one|another) `input\.(?:opt|pair|chip)` is/);
    expect(section('Note')).toMatch(
      /when `input\.pickr` is focused, and the background .* when `select\.pickr` is focused/,
    );
    expect(line('Shared')).toMatch(/when `input\.tick` ×2 is checked/);
    const elements = elementsIn(path.join(root, 'base'), path.join(root, 'head'));
    const problems = attributionCheck(md, json, 'report.md', elements);
    for (const approved of [false, true]) {
      const comment = await runActionComment({
        reportDir: outDir,
        mode: 'review-gate',
        trustState: 'STYLE_REVIEW_REQUIRED',
        approved,
      });
      problems.push(...attributionCheck(comment, json, `comment${approved ? ' (approved)' : ''}`, elements));
    }
    expect(problems).toEqual([]);
  } finally {
    rmTmp(root);
  }
});
