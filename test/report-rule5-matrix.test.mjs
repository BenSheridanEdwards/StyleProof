import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateStructuralStyleMapReportForTesting, generateStyleMapReport } from '../dist/report.js';
import { MAP_MANIFEST } from '../dist/map-store.js';
import { fixtureCompatibilityKey, makeMap, mkTmp, rmTmp, solidPng, writeCapture } from './helpers.mjs';
import { runActionComment } from './action-comment-harness.mjs';

// Ben's report rule 5, checked across every report shape the headline and section builders
// produce (QA7/QA8): report.md, report.html and the Action's real PR comment, in review-gate
// and certify mode. The shape list follows the branches of reportHeadline / summaryLines /
// noChangedSurfaceSummary / contentNoteLines / reachHeadlineLines / productStateWarningLines
// and the one-sided, change-section, content-layer and global-chrome section builders.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRUST_STATES = [...fs.readFileSync(path.join(root, 'src/verdict.ts'), 'utf8').matchAll(/\| '([A-Z_]+)'/g)].map(
  (m) => m[1],
);
const CODES = new RegExp(
  [
    ...TRUST_STATES,
    'REPORT_PUBLICATION_FAILED',
    'capture_failed',
    'base-capture-failed',
    '\\bJ2\\b',
    '\\bJ3\\b',
    'Reach (?:in)?complete',
    'warn-only',
    'scriptReach',
    'run-level gap',
    'Product-state identity unproven',
  ].join('|'),
);

// Facts that must be stated at most once per output.
const FACTS = {
  'visible addition/removal': /visible element/gi,
  'approve with the other changes': /with the other changes/gi,
  'not a base recapture failure': /recapture failure|failed base recapture/gi,
  'first adoption': /first[- ]adoption/gi,
  'removal acceptance': /disappearance/gi,
  'cannot certify': /cannot certify/gi,
  'Reach gate': /Reach gate/g,
  'reach could not check': /could not check every changed CSS rule/gi,
  'gates the check': /\bgates? the check\b/gi,
  'global chrome change': /global chrome element/gi,
  'baseline capture failed': /capture failed|failed on the base/gi,
};

const BLACK = 'rgb(0, 0, 0)';
const RED = 'rgb(200, 30, 30)';
const body = { tag: 'body', rect: [0, 0, 1280, 400], style: { color: BLACK } };
const para = { tag: 'p', rect: [20, 100, 300, 20], style: { color: BLACK } };
const promo = { tag: 'div', cls: 'promo', rect: [20, 20, 200, 40], style: { color: BLACK, display: 'block' } };
const promo2 = { tag: 'div', cls: 'promo2', rect: [20, 200, 200, 40], style: { color: BLACK, display: 'block' } };
const title = (color) => ({ tag: 'h1', cls: 'title', text: 'Welcome', rect: [20, 300, 400, 40], style: { color } });
const page = (elements, extra = {}) => ({ ...makeMap({ elements: { body, ...elements } }), ...extra });
const rule = (key, hash, extra = {}) => ({ key, hash, sheet: 0, ...extra });
const reach = (rules, extra = {}) => ({
  reach: { version: 2, scope: 'compared', sheets: ['/app.css'], rules, ...extra },
});
const nav = { tag: 'nav', cls: 'shared', rect: [0, 0, 1280, 40], style: { display: 'block' } };
const navLink = {
  tag: 'a',
  cls: 'cta',
  text: 'Help',
  rect: [10, 10, 60, 20],
  style: { color: BLACK, display: 'inline' },
};
const chromeSurfaces = (withLink) =>
  Object.fromEntries(
    ['home@1280', 'settings@1280'].map((key) => [
      key,
      page({ 'body > nav': nav, ...(withLink ? { 'body > nav > a': navLink } : {}), 'body > p': para }),
    ]),
  );
const age = (text, width) =>
  page(
    {
      'body > span.age:nth-child(1)': {
        tag: 'span',
        cls: 'age',
        rect: [20, 20, width, 16],
        style: { width: `${width}px`, color: BLACK },
        computedValueStyle: { width: 'auto' },
        ownTextLength: text.length,
        text,
      },
    },
    { metadata: { liveText: { freeze: true, selectors: [] } } },
  );
/** A sibling reorder: raw reviewable evidence that report-only path correspondence collapses. */
function reorder(order) {
  const kinds = {
    button: { tag: 'button', cls: 'action', rect: [10, 10, 80, 24], ownTextLength: 3, style: { color: BLACK } },
    label: { tag: 'span', cls: 'label', rect: [10, 50, 80, 20], ownTextLength: 4, style: { color: BLACK } },
  };
  const elements = {
    body: { tag: 'body', rect: [0, 0, 400, 200], ownTextLength: 0, style: {} },
    'body > div:nth-child(1)': { tag: 'div', cls: 'shell', rect: [0, 0, 200, 100], ownTextLength: 0, style: {} },
  };
  order.forEach((kind, i) => {
    elements[`body > div:nth-child(1) > ${kinds[kind].tag}:nth-child(${i + 1})`] = kinds[kind];
  });
  return makeMap({ elements });
}
const reviewable = () => 'STYLE_REVIEW_REQUIRED';
const certifyFails = (mode) => (mode === 'certify' ? 'CERTIFICATION_FAILED' : 'STYLE_REVIEW_REQUIRED');

/** name → fixture and the trust state the Action's verdict step gives it in each mode. */
const SHAPES = {
  'empty (no changes)': {
    expect: /✓ No reviewable computed-style changes/,
    before: { 'home@1280': page({ 'body > p': para }) },
    after: { 'home@1280': page({ 'body > p': para }) },
    trust: () => 'NO_REVIEWABLE_STYLE_CHANGES',
  },
  'style changes only': {
    expect: /\*\*1 change to review\*\*/,
    before: { 'home@1280': page({ 'body > h1': title(BLACK), 'body > p': para }) },
    after: { 'home@1280': page({ 'body > h1': title(RED), 'body > p': para }) },
    trust: reviewable,
  },
  'structure only (one element)': {
    expect: /1 visible element was added or removed/,
    before: { 'home@1280': page({ 'body > div.promo': promo, 'body > p': para }) },
    after: { 'home@1280': page({ 'body > p': para }) },
    trust: reviewable,
  },
  'structure only (two elements)': {
    expect: /2 visible elements were added or removed/,
    before: { 'home@1280': page({ 'body > div.promo': promo, 'body > div.promo2': promo2, 'body > p': para }) },
    after: { 'home@1280': page({ 'body > p': para }) },
    trust: reviewable,
  },
  'style + structure': {
    expect: /1 visible element was added or removed/,
    before: { 'home@1280': page({ 'body > h1': title(BLACK), 'body > div.promo': promo, 'body > p': para }) },
    after: { 'home@1280': page({ 'body > h1': title(RED), 'body > p': para }) },
    trust: reviewable,
  },
  'new surface': {
    expect: /1 new surface/,
    before: { 'home@1280': page({ 'body > p': para }) },
    after: { 'home@1280': page({ 'body > p': para }), 'pricing@1280': page({ 'body > p': para }) },
    trust: reviewable,
  },
  'removed surface': {
    expect: /1 removed surface/,
    before: { 'home@1280': page({ 'body > p': para }), 'pricing@1280': page({ 'body > p': para }) },
    after: { 'home@1280': page({ 'body > p': para }) },
    trust: reviewable,
  },
  'style + structure + new surface': {
    expect: /1 new surface/,
    before: {
      'home@1280': page({
        'body > h1': title(BLACK),
        'body > div.promo': promo,
        'body > div.promo2': promo2,
        'body > p': para,
      }),
    },
    after: {
      'home@1280': page({ 'body > h1': title(RED), 'body > p': para }),
      'pricing@1280': page({ 'body > p': para }),
    },
    trust: reviewable,
  },
  'base capture failed (named)': {
    expect: /failed to capture on the base/,
    failures: [{ key: 'pricing@1280', reason: 'timeout on base', kind: 'capture' }],
    before: { 'home@1280': page({ 'body > p': para }) },
    after: { 'home@1280': page({ 'body > p': para }), 'pricing@1280': page({ 'body > p': para }) },
    trust: () => 'PARTIAL_BASELINE',
  },
  'base capture failed + style': {
    expect: /failed to capture on the base/,
    failures: [{ key: 'pricing@1280', reason: 'timeout on base', kind: 'capture' }],
    before: { 'home@1280': page({ 'body > h1': title(BLACK), 'body > p': para }) },
    after: {
      'home@1280': page({ 'body > h1': title(RED), 'body > p': para }),
      'pricing@1280': page({ 'body > p': para }),
    },
    trust: () => 'PARTIAL_BASELINE',
  },
  'product-state blocked (structure)': {
    expect: /This compare cannot certify/,
    opts: { requireStateIdentity: true },
    before: { 'home@1280': page({ 'body > div.promo': promo, 'body > p': para }) },
    after: { 'home@1280': page({ 'body > p': para }) },
    trust: () => 'CERTIFICATION_FAILED',
  },
  'product-state blocked (style + structure)': {
    expect: /This compare cannot certify/,
    opts: { requireStateIdentity: true },
    before: { 'home@1280': page({ 'body > h1': title(BLACK), 'body > div.promo': promo, 'body > p': para }) },
    after: { 'home@1280': page({ 'body > h1': title(RED), 'body > p': para }) },
    trust: () => 'CERTIFICATION_FAILED',
  },
  'reach gate holding, no style change': {
    expect: /Reach gate/,
    opts: { changeReach: 'gate' },
    before: { 'home@1280': page({ 'body > p': para }, reach([rule('.unopened', 'h1')])) },
    after: { 'home@1280': page({ 'body > p': para }, reach([rule('.unopened', 'h2')])) },
    trust: certifyFails,
  },
  'reach gate holding, with style changes': {
    expect: /Reach gate/,
    opts: { changeReach: 'gate' },
    before: {
      'home@1280': page(
        { 'body > h1': title(BLACK), 'body > p': para },
        reach([rule('.title', 'h1', { used: true }), rule('.unopened', 'h1')]),
      ),
    },
    after: {
      'home@1280': page(
        { 'body > h1': title(RED), 'body > p': para },
        reach([rule('.title', 'h2', { used: true }), rule('.unopened', 'h2')]),
      ),
    },
    trust: certifyFails,
  },
  'warn-level reach gaps (one side has no served-CSS record)': {
    expect: /could not check every changed CSS rule/,
    before: { 'home@1280': page({ 'body > h1': title(BLACK), 'body > p': para }) },
    after: {
      'home@1280': page(
        { 'body > h1': title(RED), 'body > p': para },
        reach([rule('.title', 'h2', { used: true }), rule('.ignored', 'h2', { outside: true })], { unreadable: 2 }),
      ),
    },
    trust: reviewable,
  },
  'warn-level reach: never matched + unmeasured': {
    expect: /never matched on a captured page/,
    before: {
      'home@1280': page({ 'body > p': para }, reach([rule('.never', 'h1'), rule('.ignored', 'h1', { outside: true })])),
    },
    after: {
      'home@1280': page({ 'body > p': para }, reach([rule('.never', 'h2'), rule('.ignored', 'h2', { outside: true })])),
    },
    trust: () => 'NO_REVIEWABLE_STYLE_CHANGES',
  },
  'global chrome, --include-content on': {
    expect: /## 🧱 Global chrome/,
    opts: { includeContent: true },
    before: chromeSurfaces(false),
    after: chromeSurfaces(true),
    trust: reviewable,
  },
  'global chrome, --include-content off': {
    expect: /visible element was added or removed/,
    before: chromeSurfaces(false),
    after: chromeSurfaces(true),
    trust: reviewable,
  },
  'style + structure + text, --include-content on': {
    expect: /## 📝 Content and structure changes/,
    opts: { includeContent: true },
    before: {
      'home@1280': page({
        'body > h1': title(BLACK),
        'body > div.promo': promo,
        'body > p': { ...para, text: 'Old text' },
      }),
    },
    after: { 'home@1280': page({ 'body > h1': title(RED), 'body > p': { ...para, text: 'New text' } }) },
    trust: reviewable,
  },
  'style + structure + text, --include-content off': {
    expect: /Content\/structure was not evaluated|visible element/,
    before: {
      'home@1280': page({
        'body > h1': title(BLACK),
        'body > div.promo': promo,
        'body > p': { ...para, text: 'Old text' },
      }),
    },
    after: { 'home@1280': page({ 'body > h1': title(RED), 'body > p': { ...para, text: 'New text' } }) },
    trust: reviewable,
  },
  'head-only volatile subtree': {
    expect: /newly volatile on head/,
    before: { 'home@1280': page({ 'body > h1': title(BLACK), 'body > p': para }) },
    after: { 'home@1280': page({ 'body > h1': title(RED), 'body > p': para }, { volatile: ['body > h1'] }) },
    trust: () => 'CERTIFICATION_FAILED',
  },
  'report consistency failure (correspondence collapsed every finding)': {
    expect: /Report consistency failure/,
    // Report-only path correspondence is on in the structural generator (the CLI path aligns this).
    structural: true,
    before: { 's@400': reorder(['button', 'label']) },
    after: { 's@400': reorder(['label', 'button']) },
    trust: () => 'CERTIFICATION_FAILED',
  },
  'migration mode (style changes)': {
    expect: /[Mm]igration/,
    opts: { migration: true },
    modes: ['migration'],
    before: { 'home@1280': page({ 'body > h1': title(BLACK), 'body > p': para }) },
    after: { 'home@1280': page({ 'body > h1': title(RED), 'body > p': para }) },
    trust: reviewable,
  },
  'live-text freeze violated': {
    expect: /Live\/age freeze violated/,
    opts: { includeContent: true },
    before: { 'dashboard@1280': age('open 102.1d', 96) },
    after: { 'dashboard@1280': age('open 103.1d', 104) },
    trust: () => 'CERTIFICATION_FAILED',
  },
};

function manifest(dir, sha, failures) {
  fs.writeFileSync(
    path.join(dir, MAP_MANIFEST),
    JSON.stringify({
      version: 1,
      packageVersion: '9.0.0',
      sha,
      dirty: false,
      spec: 'test.spec.ts',
      specHash: 'a'.repeat(64),
      platform: 'linux',
      arch: 'x64',
      nodeMajor: '22',
      screenshots: true,
      har: false,
      compatibilityKey: fixtureCompatibilityKey('rule5-matrix'),
      createdAt: '2026-01-01T00:00:00.000Z',
      ...(failures.length ? { surfaceCaptureFailures: failures } : {}),
    }),
  );
}

const visibleMd = (md) =>
  md
    .split('\n')
    .filter((line) => !line.startsWith('<!-- '))
    .join('\n');
const htmlText = (html) =>
  html
    .replace(/data:[^"')\s]+/g, '')
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<svg[\s\S]*?<\/svg>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<nav class="toc"[\s\S]*?<\/nav>/g, '')
    // Inline tags join their text; block tags end a line.
    .replace(/<\/?(?:strong|code|em|a|span|i|b|sub|small)\b[^>]*>/g, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ');
const commentText = (body) =>
  body
    .split('\n')
    .filter((line) => !line.startsWith('<!-- '))
    .join('\n');

/** Sentences and clauses, numbers folded, tables and short labels skipped. */
function clauses(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*\|/.test(line))
    .join('\n')
    .split(/(?<=[.;:!?])\s+|\n| — /)
    .map((c) => c.replace(/[`*_]/g, '').replace(/\d+/g, 'N').replace(/\s+/g, ' ').trim().toLowerCase())
    .filter((c) => c.length > 25);
}

function problems(name, text, { approvalBox }) {
  const out = [];
  for (const [fact, re] of Object.entries(FACTS)) {
    const n = text.match(re)?.length ?? 0;
    if (n > 1) out.push(`${name}: "${fact}" said ${n} times`);
  }
  const seen = new Map();
  for (const c of clauses(text)) seen.set(c, (seen.get(c) ?? 0) + 1);
  for (const [c, n] of seen) if (n > 1) out.push(`${name}: clause repeated ${n}×: "${c.slice(0, 100)}"`);
  const code = text.match(CODES);
  if (code) out.push(`${name}: internal code ${code[0]}`);
  const approveLines = text
    .split('\n')
    .filter((line) => /\bapprov(?:e|ing)\b/i.test(line) && !/cannot|can't|never/i.test(line));
  const allowed = approvalBox ? approveLines.filter((line) => !/Approve all changes/.test(line)) : approveLines;
  if (!approvalBox && allowed.length)
    out.push(`${name}: says approve with no approval box: "${allowed[0].slice(0, 120)}"`);
  if (approvalBox && allowed.length)
    out.push(`${name}: report text tells the reader to approve: "${allowed[0].slice(0, 120)}"`);
  return out;
}

/** The comment must not point at content it does not carry. */
function danglingReferences(comment) {
  const out = [];
  if (/\bbelow\b/i.test(comment))
    out.push(`comment: says "below": "${comment.match(/[^\n]*\bbelow\b[^\n]*/i)[0].slice(0, 120)}"`);
  for (const [, heading] of comment.matchAll(/\b(?:see|under) \*\*([^*]+)\*\*/gi)) {
    if (!new RegExp(`^#{2,3} .*${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm').test(comment)) {
      out.push(`comment: refers to "${heading}", which the comment does not carry`);
    }
  }
  // The report part of the comment (before the link) carries no horizontal rule of its own.
  if (/^---$/m.test(comment)) out.push('comment: a stray --- rule above the report link');
  return out;
}

/** The summary line's counts against report.json. */
function countProblems(md, json) {
  const out0 = [];
  // QA8-04: with a served-CSS record missing, no output (report.json included) claims zero changed rules.
  if (
    (json.reach?.gaps ?? []).some((gap) => gap.kind === 'ledger') &&
    (json.reach.counts || json.reach.rules?.length === 0)
  ) {
    out0.push('report.json claims rule counts though a served-CSS record is missing');
  }
  if (/\b0 changed CSS rules?\b/.test(md) && (json.reach?.gaps ?? []).some((gap) => gap.kind === 'ledger')) {
    out0.push('summary claims 0 changed CSS rules though a served-CSS record is missing');
  }
  return [...out0, ...countLineProblems(md, json)];
}

function countLineProblems(md, json) {
  const line = visibleMd(md).match(
    /\*\*(\d+) changes? to review\*\*(?:[^\n]*?: (\d+) elements?(?:, (\d+) changed CSS rules?)?)?/,
  );
  if (!line) return [];
  const out = [];
  const sections = (json.surfaces ?? []).reduce((n, s) => n + (s.regions ? Math.max(1, s.regions.length) : 1), 0);
  if (Number(line[1]) !== sections) out.push(`summary says ${line[1]} changes, report.json has ${sections}`);
  if (line[2] !== undefined) {
    const elements = (json.surfaces ?? [])
      .flatMap((s) => s.regions ?? [])
      .reduce((n, r) => n + r.paths.filter((p) => p !== '(surface)').length, 0);
    if (Number(line[2]) !== elements) out.push(`summary says ${line[2]} elements, report.json has ${elements}`);
  }
  if (line[3] !== undefined) {
    const ledgerGap = (json.reach?.gaps ?? []).some((gap) => gap.kind === 'ledger');
    if (ledgerGap) out.push(`summary counts ${line[3]} changed CSS rules though a served-CSS record is missing`);
    else if (Number(line[3]) !== json.reach.rules.length)
      out.push(`summary says ${line[3]} rules, report.json has ${json.reach.rules.length}`);
  }
  return out;
}

for (const [shape, spec] of Object.entries(SHAPES)) {
  test(`rule 5 holds for: ${shape}`, async (t) => {
    const dir = mkTmp('styleproof-rule5-');
    t.after(() => rmTmp(dir));
    for (const [side, captures] of [
      ['before', spec.before],
      ['after', spec.after],
    ]) {
      const sideDir = path.join(dir, side);
      fs.mkdirSync(sideDir, { recursive: true });
      for (const [key, capture] of Object.entries(captures)) writeCapture(sideDir, key, capture, solidPng(1280, 400));
      if (spec.failures)
        manifest(sideDir, side === 'before' ? 'b'.repeat(40) : 'c'.repeat(40), side === 'before' ? spec.failures : []);
    }
    const outDir = path.join(dir, 'report');
    (spec.structural ? generateStructuralStyleMapReportForTesting : generateStyleMapReport)({
      beforeDir: path.join(dir, 'before'),
      afterDir: path.join(dir, 'after'),
      outDir,
      ...(spec.opts ?? {}),
    });
    const md = fs.readFileSync(path.join(outDir, 'report.md'), 'utf8');
    const html = fs.readFileSync(path.join(outDir, 'report.html'), 'utf8');
    const json = JSON.parse(fs.readFileSync(path.join(outDir, 'report.json'), 'utf8'));
    assert.match(visibleMd(md), spec.expect, `${shape}: the fixture reaches its branch`);
    const found = [
      ...problems('report.md', visibleMd(md), { approvalBox: false }),
      ...problems('report.html', htmlText(html), { approvalBox: false }),
      ...countProblems(md, json),
    ];
    for (const mode of spec.modes ?? ['review-gate', 'certify']) {
      const body = await runActionComment({ reportDir: outDir, mode, trustState: spec.trust(mode) });
      const approvalBox = body.includes('- [ ] **Approve all changes**');
      // The whole comment (summary and footer) states each fact once; only the footer may
      // say "Approve", and only next to the box. The Action's own box line is not report text.
      const whole = commentText(body).replace(/^\s*- \[[ xX]\] \*\*Approve all changes\*\*.*$/m, '');
      const [report, footer = ''] = whole.split('\n### 📊');
      found.push(
        ...problems(`comment (${mode})`, whole, { approvalBox: true }).filter((p) => !p.includes('tells the reader')),
        ...problems(`comment report part (${mode})`, report, { approvalBox: false }).filter((p) =>
          p.includes('approve'),
        ),
        ...danglingReferences(report).map((p) => `${p} (${mode})`),
      );
      if (!approvalBox && /\bapprov(?:e|ing)\b/i.test(footer.replace(/[^\n]*(?:cannot|can't|never)[^\n]*/gi, ''))) {
        found.push(`comment (${mode}): footer says approve with no box`);
      }
      // The footer alone may tell the reader to approve, and only with a box to tick.
      if (!approvalBox && /Tick \*\*Approve all changes\*\*/.test(body))
        found.push(`comment (${mode}): approve guidance with no box`);
    }
    assert.deepEqual(found, [], `${shape}:\n${found.join('\n')}`);
  });
}
