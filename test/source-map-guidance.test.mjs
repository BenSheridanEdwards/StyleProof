import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyScriptReach } from '../dist/script-join.js';
import { publishedReach, reachStripLines, reachSectionLines } from '../dist/report/reach.js';
import { renderReportHtml } from '../dist/report/html.js';
import { budgetScriptReach, reserveScriptNotice } from '../dist/report/script-units.js';

const captured = (scripts) => ({ scriptReach: { version: 1, window: 'navigation', status: 'measured', scripts } });
const mapped = captured([{ url: '/app.js', status: 'mapped', files: [] }]);
const absent = (url = '/assets/app.js') => ({ url, status: 'unmeasured', reason: 'source map absent' });
const gaps = (base, head) => classifyScriptReach(base, head, []).gaps;

for (const [name, url, settings, excluded] of [
  ['Next.js', '/_next/static/chunks/app.js', ['productionBrowserSourceMaps'], ['build.sourcemap']],
  [
    'Next.js with a base path',
    '/preview/_next/static/chunks/app.js',
    ['productionBrowserSourceMaps'],
    ['build.sourcemap'],
  ],
  [
    'Next.js absolute URL',
    'https://app.example.invalid/_next/static/app.js?v=1#x',
    ['productionBrowserSourceMaps'],
    ['build.sourcemap'],
  ],
  [
    'generic URL with a Next path only in its query',
    '/assets/app.js?next=/_next/static/app.js',
    ['build.sourcemap', 'devtool'],
    ['productionBrowserSourceMaps'],
  ],
  [
    'Vite/webpack',
    '/assets/app.js',
    ['build.sourcemap', 'hidden', 'devtool', 'hidden-source-map'],
    ['productionBrowserSourceMaps'],
  ],
]) {
  test(`missing head maps name the ${name} capture setting`, () => {
    const [gap] = gaps([mapped], [captured([absent(url)])]);
    assert.equal(gap.side, 'head');
    assert.equal(gap.reason, 'head script evidence: source map absent (1 script(s))');
    for (const setting of settings) assert.ok(gap.remedy.includes(setting), gap.remedy);
    for (const setting of excluded) assert.ok(!gap.remedy.includes(setting), gap.remedy);
    assert.doesNotMatch(gap.remedy, /styleproof-init/);
    assert.match(gap.remedy, /STYLEPROOF_CAPTURE_SOURCE_MAPS=1/);
  });
}

test('mixed Next.js and other head chunks name both framework settings', () => {
  const [gap] = gaps([mapped], [captured([absent('/_next/static/app.js'), absent('/assets/app.js')])]);
  assert.match(gap.remedy, /productionBrowserSourceMaps/);
  assert.match(gap.remedy, /build.sourcemap/);
  assert.match(gap.remedy, /hidden-source-map/);
});

test('base-only missing maps name the next baseline capture when head maps are measured', () => {
  const [gap] = gaps([captured([absent()])], [mapped]);
  assert.equal(gap.side, 'base');
  assert.match(gap.remedy, /base was captured without source maps/);
  assert.match(gap.remedy, /next normal baseline capture with these source-map settings/);
  assert.doesNotMatch(gap.remedy, /styleproof-init|build.sourcemap|productionBrowserSourceMaps/);
});

for (const [name, head] of [
  ['head also lacks maps', [captured([absent()])]],
  ['head lacks script coverage', [{}]],
  [
    'head has legacy coverage',
    [{ scriptReach: { version: 0, status: 'measured', scripts: [{ url: '/app.js', status: 'mapped' }] } }],
  ],
  [
    'head still has an unmapped vendor chunk',
    [
      captured([
        { url: '/app.js', status: 'mapped', files: [] },
        { ...absent('/vendor.js'), nonAppSourcesOnly: true },
      ]),
    ],
  ],
  ['head coverage is incomplete', [{ scriptReach: { version: 1, status: 'unmeasured', scripts: [] } }]],
]) {
  test(`base map guidance does not promise automatic recovery when ${name}`, () => {
    const gap = gaps([captured([absent()])], head).find((entry) => entry.side === 'base');
    assert.match(gap.remedy, /STYLEPROOF_CAPTURE_SOURCE_MAPS=1/);
    assert.doesNotMatch(gap.remedy, /next normal baseline capture/);
  });
}

const reachFor = (scriptGaps) => ({
  level: 'warn',
  blocking: 0,
  complete: false,
  ledger: 'complete',
  counts: { reached: 0, 'never-rendered': 0, unmeasured: 0, 'blind-channel': 0 },
  rules: [],
  unreadableSheets: 0,
  scripts: [],
  scriptCounts: { reached: 0, 'never-rendered': 0, unmeasured: 0, unknown: 0 },
  classes: [],
  gaps: scriptGaps,
});

for (const available of [0, 2800, 64_000]) {
  test(`the missing-map count survives a ${available}-byte detail budget across both revisions`, () => {
    const original = reachFor(
      gaps(
        [captured([absent('/base-a.js'), absent('/base-b.js')])],
        [captured([absent('/head-a.js'), absent('/head-b.js'), absent('/head-c.js')])],
      ),
    );
    const { reach } = budgetScriptReach(original, reserveScriptNotice(original), available);
    assert.match(reachStripLines(reach).join('\n'), /Source maps absent on 5 script\(s\)/);
  });
}

test('missing-map totals survive truncation when neither preview names missing maps', () => {
  const original = reachFor([
    ...gaps([mapped], [captured([{ url: '/other.js', status: 'unknown', reason: 'map read timed out' }])]),
    ...gaps([mapped], [captured([{ url: '/another.js', status: 'unknown', reason: 'map parse failed' }])]),
    ...gaps([mapped], [captured([absent('/a.js'), absent('/b.js')])]),
  ]);
  const { reach } = budgetScriptReach(original, reserveScriptNotice(original), 0);
  assert.match(reachStripLines(reach).join('\n'), /Source maps absent on 2 script\(s\)/);
});

test('the strip counts distinct missing-map URLs per side and retains remedies in Markdown, HTML and JSON', () => {
  const missing = captured([absent('/assets/app.js'), absent('/assets/lazy.js')]);
  const reach = reachFor(gaps([mapped], [missing, missing]));
  const markdown = [...reachStripLines(reach), ...reachSectionLines(reach)].join('\n');
  assert.match(markdown, /Source maps absent on 2 script\(s\) — see J2 gaps/);
  assert.match(markdown, /J2 script reach \(warn-only\)/);
  assert.match(markdown, /build.sourcemap/);
  const html = renderReportHtml(markdown);
  assert.match(html, /Source maps absent on 2 script\(s\)/);
  assert.match(html, /STYLEPROOF_CAPTURE_SOURCE_MAPS=1/);
  const json = JSON.parse(JSON.stringify(publishedReach(reach)));
  assert.equal(json.gaps[0].reason, 'head script evidence: source map absent (2 script(s))');
  assert.match(json.gaps[0].remedy, /build.sourcemap/);
});

test('unrelated script gaps keep the generic remedy and do not add a missing-map notice', () => {
  const [gap] = gaps(
    [mapped],
    [captured([{ url: '/app.js', status: 'unknown', reason: 'source map read timed out' }])],
  );
  assert.equal(
    gap.remedy,
    'capture both revisions with `captureScriptReach` and source maps, retaining their git SHAs and sourcesContent',
  );
  assert.doesNotMatch(reachStripLines(reachFor([gap])).join('\n'), /Source maps absent/);
});
