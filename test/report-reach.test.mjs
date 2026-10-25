import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { generateStyleMapReport } from '../dist/report.js';
import { makeMap, rmTmp, tmpDirs, writeCapture } from './helpers.mjs';

const rule = (key, hash, extra = {}) => ({ key, hash, sheet: 0, ...extra });
const map = (...rules) => ({
  ...makeMap({ elements: { body: { tag: 'body', style: { color: 'rgb(0, 0, 0)' } } } }),
  reach: { version: 2, sheets: ['/app.css'], rules },
});
const withoutReach = (capture) => {
  const plain = { ...capture };
  delete plain.reach;
  return plain;
};

function fixture(t, base = [map()], head = [map()]) {
  const dirs = tmpDirs();
  t.after(() => rmTmp(dirs.root));
  for (const [dir, captures] of [
    [dirs.beforeDir, base],
    [dirs.afterDir, head],
  ]) {
    fs.mkdirSync(dir, { recursive: true });
    for (const [index, capture] of captures.entries()) {
      writeCapture(dir, `surface-${index}@1280`, capture, null);
    }
  }
  return dirs;
}

function report(dirs, options = {}) {
  const result = generateStyleMapReport({ ...dirs, ...options });
  const md = fs.readFileSync(result.reportMdPath, 'utf8');
  const jsonText = fs.readFileSync(result.reportJsonPath, 'utf8');
  const html = fs.readFileSync(path.join(path.dirname(result.reportMdPath), 'report.html'), 'utf8');
  return { result, md, jsonText, json: JSON.parse(jsonText), html };
}

const strip =
  '**Reach incomplete** — 2 changed CSS rule(s) never rendered. Fix: add a surface or state that renders each rule under **Changed but never rendered**. Render-code reach is not measured yet.';
const intro =
  '_Changed CSS rules no captured state rendered, so the diff above cannot show them. Add a surface or state that renders each one. Source is the served stylesheet; the ledger does not record source maps yet. Reach findings do not change the verdict._';
const table = ['| Rule | Change | Gated by | Source | Why |', '| --- | --- | --- | --- | --- |'];
const darkRule = '@media (prefers-color-scheme: dark) > .panel';

test('unrendered changed CSS rules are listed with their condition and source without changing the verdict', (t) => {
  const side = (hash) => map(rule('.panel--fault', hash), rule(darkRule, hash), rule('.ok', hash, { used: true }));
  const base = side('h1');
  const head = side('h2');
  const reached = report(fixture(t, [base], [head]));
  const plain = report(fixture(t, [withoutReach(base)], [withoutReach(head)]));
  const section = [
    '## Changed but never rendered',
    '',
    intro,
    '',
    ...table,
    '| `.panel--fault` | changed | — | `/app.css` | its selector never matched |',
    '| `@media (prefers-color-scheme: dark) > .panel` | changed | `@media (prefers-color-scheme: dark)` | `/app.css` | never matched while @\u200bmedia (prefers-color-scheme: dark) applied |',
  ].join('\n');
  assert.ok(reached.md.includes(strip), 'the headline area identifies both unrendered changes');
  assert.ok(reached.md.includes(section), 'each rule gets its own reviewable table row');
  assert.doesNotMatch(reached.md, /\| `\.ok` \|/);
  assert.deepEqual(reached.json.reach.counts, { reached: 1, 'never-rendered': 2, 'blind-channel': 0 });
  assert.equal(reached.json.reach.complete, false);
  assert.equal(reached.json.reach.ledger, 'complete');
  assert.equal(reached.json.reach.level, 'warn');
  assert.equal(reached.json.reach.blocking, 0);
  assert.equal(reached.json.reach.rules.length, 3, 'JSON retains reached rules too');
  assert.deepEqual(reached.result.reach, reached.json.reach, 'public API and artifact share the assessment');
  assert.deepEqual(reached.result.comparison, plain.result.comparison);
  assert.deepEqual(reached.result.reportConsistency, plain.result.reportConsistency);
  assert.ok(plain.md.startsWith(reached.md.split('\n\n**Reach incomplete**')[0]), 'headline stays unchanged');
  assert.match(reached.html, /<h2[^>]*>Changed but never rendered<\/h2>/);
  assert.match(reached.html, /<td><code>\.panel--fault<\/code><\/td>/);
});

test('gate holds never-rendered changes without claiming a clean computed-style result', (t) => {
  const side = (hash) => map(rule('.panel--fault', hash), rule(darkRule, hash));
  const output = report(fixture(t, [side('h1')], [side('h2')]), { changeReach: 'gate' });
  assert.match(output.md, /✗ \*\*Reach gate\*\* — 2 changed CSS rule\(s\) or reach evidence gap\(s\)/);
  assert.doesNotMatch(output.md, /✓ No reviewable/);
  assert.match(
    output.md,
    /these findings hold the verdict: certify mode fails \(`CERTIFICATION_FAILED`\); review-gate mode needs approval/,
  );
  assert.ok(output.md.includes("Held by `changeReach: 'gate'`."));
  assert.equal(output.json.reach.level, 'gate');
  assert.equal(output.json.reach.blocking, 2);
  assert.deepEqual(output.result.reach, output.json.reach);
});

test('gate holds missing ledgers even when neither side records reach evidence', (t) => {
  const plain = withoutReach(map());
  const output = report(fixture(t, [plain], [plain]), { changeReach: 'gate' });
  assert.equal(output.json.reach?.blocking, 2);
  assert.equal(output.json.reach.level, 'gate');
  assert.equal(output.json.reach.ledger, 'missing');
  assert.deepEqual(
    output.json.reach.gaps.filter((gap) => gap.kind === 'ledger').map((gap) => gap.side),
    ['base', 'head'],
  );
  assert.match(output.md, /missing base ledger/);
  assert.match(output.md, /missing head ledger/);
  assert.ok(output.md.includes('recapture with `captureReach`'));
  assert.doesNotMatch(output.md, /✓ No reviewable/);
});

test('gate keeps unbuilt joins advisory when all changed served rules rendered', (t) => {
  const side = (hash) => map(rule('.ok', hash, { used: true }));
  const output = report(fixture(t, [side('h1')], [side('h2')]), { changeReach: 'gate' });
  assert.equal(output.json.reach.blocking, 0);
  assert.equal(output.json.reach.level, 'gate');
  assert.match(output.md, /✓ No reviewable/);
  assert.match(output.md, /\*\*Reach incomplete\*\*/);
  assert.doesNotMatch(output.md, /Reach gate|Held by|Reach complete/);
  assert.equal(output.json.reach.gaps.length, 3);
  assert.ok(output.json.reach.gaps.every((gap) => gap.kind === 'not-built'));
});

test('gate holds blind-channel changes and incomplete ledger evidence', (t) => {
  const side = (hash) => map(rule('@keyframes pulse', hash), rule('.badge', 'b', { used: true, refs: ['pulse'] }));
  const head = side('k2');
  head.reach.unreadable = 2;
  const output = report(fixture(t, [side('k1')], [head]), { changeReach: 'gate' });
  assert.equal(output.json.reach.blocking, 2);
  assert.equal(output.json.reach.counts['blind-channel'], 1);
  assert.equal(output.json.reach.gaps.filter((gap) => gap.kind === 'ledger').length, 1);
  assert.match(output.md, /changed in a channel computed styles cannot hold/);
  assert.match(output.md, /2 unreadable stylesheet\(s\) on head/);
  assert.doesNotMatch(output.md, /✓ No reviewable/);
});

test('directory reach assessment agrees with the report and does not depend on capture or rule order', async (t) => {
  const { assessReachDirs, assessReachMaps } = await import('../dist/report/reach.js');
  const base = [map(rule('.zeta', 'h1'), rule('.alpha', 'h1')), withoutReach(map())];
  const head = [map(rule('.zeta', 'h2'), rule('.alpha', 'h2')), map()];
  const dirs = fixture(t, base, head);
  const output = report(dirs, { changeReach: 'gate' });
  assert.deepEqual(assessReachDirs(dirs.beforeDir, dirs.afterDir, 'gate'), output.json.reach);
  const reversed = (maps) =>
    [...maps]
      .reverse()
      .map((capture) =>
        capture.reach
          ? { ...capture, reach: { ...capture.reach, rules: [...capture.reach.rules].reverse() } }
          : capture,
      );
  assert.deepEqual(assessReachMaps(reversed(base), reversed(head), 'gate'), output.json.reach);
  assert.equal(output.json.reach.blocking, 1, 'the missing base ledger holds even when changed rules cannot be listed');
});

test('fully reached changed served rules add no section but still disclose the three unbuilt joins', (t) => {
  const output = report(fixture(t, [map(rule('.ok', 'h1', { used: true }))], [map(rule('.ok', 'h2', { used: true }))]));
  assert.doesNotMatch(output.md, /## Changed but never rendered|Reach evidence gaps|Reach complete|\d+%/);
  assert.match(
    output.md,
    /\*\*Reach incomplete\*\* — every changed served CSS rule rendered \(1\); render-code reach and the changed-stylesheet join are not measured yet\./,
  );
  assert.equal(output.json.reach.complete, false);
  assert.deepEqual(output.json.reach.counts, { reached: 1, 'never-rendered': 0, 'blind-channel': 0 });
  assert.deepEqual(output.json.reach.gaps, [
    {
      join: 'J1',
      status: 'unknown',
      kind: 'not-built',
      reason:
        'changed stylesheets in the pull request are not yet joined with the sheets captures served; a changed sheet no capture served cannot be listed',
      remedy: 'none yet: a later Change Reach phase (#934) adds it',
    },
    {
      join: 'J2',
      status: 'unmeasured',
      kind: 'not-built',
      reason: 'render-code coverage is not recorded yet',
      remedy: 'none yet: a later Change Reach phase (#934) adds it',
    },
    {
      join: 'J3',
      status: 'unmeasured',
      kind: 'not-built',
      reason: 'class-list deltas are not recorded yet',
      remedy: 'none yet: a later Change Reach phase (#934) adds it',
    },
  ]);
});

test('an empty changed-rule list cannot claim reach is complete', (t) => {
  const output = report(fixture(t));
  assert.match(output.md, /every changed served CSS rule rendered \(0\)/);
  assert.doesNotMatch(output.md, /Reach complete|## Changed but never rendered/);
  assert.equal(output.json.reach.complete, false);
  assert.deepEqual(output.json.reach.rules, []);
});

test('captures without any reach ledger preserve all report bytes and omit the public reach field', (t) => {
  const clean = makeMap({ elements: { body: { tag: 'body', style: { color: 'rgb(0, 0, 0)' } } } });
  const original = report(fixture(t, [clean], [clean]));
  const removed = report(fixture(t, [withoutReach(map())], [withoutReach(map())]));
  assert.equal(removed.md, original.md);
  assert.equal(removed.jsonText, original.jsonText);
  assert.equal(removed.html, original.html);
  assert.equal(Object.hasOwn(removed.json, 'reach'), false);
  assert.equal(Object.hasOwn(removed.result, 'reach'), false);
  assert.doesNotMatch(removed.md, /Reach/);
});

test('missing and pre-version-2 ledgers name the affected side and the recapture remedy', (t) => {
  const old = map(rule('.fault', 'h1'));
  delete old.reach.version;
  const output = report(fixture(t, [withoutReach(map()), old], [map(rule('.fault', 'h2')), map()]));
  assert.ok(
    output.md.includes(
      '- base: missing base ledger on 2 capture(s); changed rules cannot be listed — recapture with `captureReach`',
    ),
  );
  assert.match(output.md, /\*\*Reach incomplete\*\* — base: missing base ledger on 2 capture\(s\)/);
  assert.match(output.md, /Reach evidence gaps/);
  assert.equal(output.json.reach.ledger, 'missing');
  assert.deepEqual(output.json.reach.rules, []);
  assert.equal(output.json.reach.complete, false);
  assert.deepEqual(output.json.reach.gaps[0], {
    join: 'J1',
    status: 'unknown',
    side: 'base',
    kind: 'ledger',
    reason: 'missing base ledger on 2 capture(s); changed rules cannot be listed',
    remedy: 'recapture with `captureReach`',
  });
});

test('missing captures produce an explicit reach gap and an empty head still refuses a report', async (t) => {
  const { assessReach } = await import('../dist/report/reach.js');
  const { createMapLoader } = await import('../dist/report/shared.js');
  for (const side of ['base', 'head']) {
    const dirs = fixture(t, side === 'base' ? [] : [map()], side === 'head' ? [] : [map()]);
    const reach = assessReach({ ...dirs, load: createMapLoader() });
    assert.equal(reach.ledger, 'missing');
    assert.equal(reach.complete, false);
    assert.deepEqual(reach.gaps[0], {
      join: 'J1',
      status: 'unknown',
      side,
      kind: 'ledger',
      reason: `no ${side} captures; changed rules cannot be listed`,
      remedy: 'capture both sides with `captureReach`',
    });
    if (side === 'head') {
      assert.throws(() => report(dirs), /head map missing: the head capture produced zero surfaces/);
      assert.equal(fs.existsSync(path.join(dirs.outDir, 'report.md')), false);
    } else {
      const output = report(dirs);
      assert.ok(
        output.md.includes(
          '- base: no base captures; changed rules cannot be listed — capture both sides with `captureReach`',
        ),
      );
      assert.deepEqual(output.json.reach, reach);
    }
  }
});

test('an unreadable stylesheet ledger keeps known rules and names the unknown head evidence', (t) => {
  const head = map(rule('.fault', 'h2'));
  head.reach.unreadable = 2;
  const output = report(fixture(t, [map(rule('.fault', 'h1'))], [head]));
  assert.match(output.md, /head: 2 unreadable stylesheet\(s\) on head; changed rules there cannot be listed/);
  assert.match(output.md, /make the stylesheets readable \(same-origin or CORS\) and recapture/);
  assert.ok(output.md.includes('| `.fault` | changed |'));
  assert.equal(output.json.reach.ledger, 'partial');
  assert.equal(output.json.reach.unreadableSheets, 2);
  assert.equal(output.json.reach.complete, false);
  assert.equal(output.json.reach.gaps[0].side, 'head');
});

test('rendered references to changed animation bodies appear in the blind-channel table', (t) => {
  const side = (hash) => map(rule('@keyframes pulse', hash), rule('.badge', 'b', { used: true, refs: ['pulse'] }));
  const output = report(fixture(t, [side('k1')], [side('k2')]));
  assert.ok(
    output.md.includes(
      '**Changed in a channel computed styles cannot hold** (`@keyframes`, `@font-face`, `@property`)',
    ),
  );
  assert.ok(
    output.md.includes('| `@keyframes pulse` | changed | — | `/app.css` | referenced by .badge, which rendered |'),
  );
  assert.match(output.md, /\*\*Reach incomplete\*\* — 1 changed in a channel computed styles cannot hold/);
  assert.doesNotMatch(output.md, /Fix: \./);
  assert.ok(output.md.includes('review the changes under **Changed in a channel computed styles cannot hold**'));
  assert.deepEqual(output.json.reach.counts, { reached: 0, 'never-rendered': 0, 'blind-channel': 1 });
  assert.equal(output.json.reach.complete, false);
});

test('added and removed unrendered rules identify the kind of change', (t) => {
  const output = report(fixture(t, [map(rule('.gone', 'h1'))], [map(rule('.new', 'h2'))]));
  assert.ok(output.md.includes('| `.gone` | removed |'));
  assert.ok(output.md.includes('| `.new` | added |'));
  assert.deepEqual(
    output.json.reach.rules.map(({ key, change }) => [key, change]),
    [
      ['.gone', 'removed'],
      ['.new', 'added'],
    ],
  );
});

test('hostile rule keys, conditions, sheets and reasons stay inside their table cells', (t) => {
  const consumer = '.a[data-x="|<!--`"]';
  const condition = '@media (theme: "|<!--`")';
  const key = `${condition} > ${consumer}`;
  const side = (hash, value) => {
    const capture = map(
      rule(':root', hash, { used: true, vars: { '--warn': value } }),
      rule(key, hash, { uses: ['--warn'] }),
    );
    capture.reach.sheets = ['/x|y.css\n<!--[link](https://evil.example)'];
    return capture;
  };
  const output = report(fixture(t, [side('h1', 'green')], [side('h2', 'amber')]));
  const rows = output.md.split('\n').filter((line) => line.startsWith('| ') && line.includes('/x'));
  assert.equal(rows.length, 2);
  for (const row of rows)
    assert.equal((row.match(/(?<!\\)\|/g) ?? []).length, 6, 'five cells plus the outer delimiters');
  assert.doesNotMatch(output.md, /<!--/);
  assert.ok(output.md.includes('\\|'), 'pipes are escaped');
  assert.ok(output.md.includes('\\`'), 'the consumer in the reason cannot open a code span');
  assert.doesNotMatch(output.html, /href="https:\/\/evil\.example|<!--\[/);
  assert.equal(
    output.json.reach.rules.find((r) => r.key === key).sheet,
    '/x|y.css\n<!--[link](https://evil.example)',
    'JSON preserves evidence verbatim',
  );
});

test('capture write order and rule order do not change Markdown, HTML or JSON bytes', (t) => {
  const dirs = fixture(t, [], []);
  const captures = [
    ['zeta@1280', [rule('.zeta', '1'), rule('.same', '1', { used: true })]],
    ['alpha@1280', [rule('.alpha', '1'), rule('.same', '1', { used: true })]],
  ];
  const write = (entries) => {
    for (const [key, rules] of entries) {
      writeCapture(dirs.beforeDir, key, map(...rules), null);
      writeCapture(dirs.afterDir, key, map(...rules.map((r) => ({ ...r, hash: '2' }))), null);
    }
  };
  write(captures);
  const first = report(dirs);
  fs.rmSync(dirs.beforeDir, { recursive: true });
  fs.rmSync(dirs.afterDir, { recursive: true });
  write([...captures].reverse().map(([key, rules]) => [key, [...rules].reverse()]));
  const reversed = report(dirs);
  assert.equal(reversed.md, first.md);
  assert.equal(reversed.jsonText, first.jsonText);
  assert.equal(reversed.html, first.html);
  assert.ok(first.json.reach, 'determinism includes reach evidence');
});

test('a bounded report summarizes unrendered rules without losing the full JSON evidence', (t) => {
  const rules = Array.from({ length: 100 }, (_, index) => rule(`.fault-${index}`, 'h1'));
  const output = report(fixture(t, [map(...rules)], [map(...rules.map((r) => ({ ...r, hash: 'h2' })))]), {
    maxReportBytes: 5000,
  });
  assert.ok(
    output.md.includes(
      '- Changed but never rendered: 100 rule(s), 0 blind-channel, 0 evidence gap(s); full list in report.json under `reach`',
    ),
  );
  assert.match(output.md, /summarized to keep this report renderable/);
  assert.ok(Buffer.byteLength(output.md, 'utf8') <= 5000);
  assert.equal(output.json.reach.rules.length, 100);
  assert.equal(output.json.reach.counts['never-rendered'], 100);
});

test('a byte budget too small to show reach status refuses to write a misleading report', (t) => {
  for (const maxReportBytes of [400, 500]) {
    const dirs = fixture(t, [map(rule('.fault', 'h1'))], [map(rule('.fault', 'h2'))]);
    assert.throws(
      () => report(dirs, { maxReportBytes }),
      /report byte budget cannot show reach status; increase maxReportBytes/,
    );
    for (const extension of ['md', 'html', 'json']) {
      assert.equal(fs.existsSync(path.join(dirs.outDir, `report.${extension}`)), false);
    }
  }
});

test('a restyle beside an unrendered rule cannot also say Nothing else', (t) => {
  const head = map(rule('.fault', 'h2'));
  head.elements.body.style.color = 'rgb(255, 0, 0)';
  const output = report(fixture(t, [map(rule('.fault', 'h1'))], [head]));
  assert.ok(output.md.includes('## Changed but never rendered'));
  assert.doesNotMatch(output.md, /Nothing else/);
});

test('the reach strip names completeness without percentages and rejects any evidence gap', async () => {
  const { reachStripLines } = await import('../dist/report/reach.js');
  const reach = {
    complete: true,
    ledger: 'complete',
    counts: { reached: 0, 'never-rendered': 0, 'blind-channel': 0 },
    rules: [],
    unreadableSheets: 0,
    gaps: [],
  };
  const complete = reachStripLines(reach).join('\n');
  assert.match(complete, /\*\*Reach complete\*\*/);
  assert.doesNotMatch(complete, /%/);
  const incomplete = reachStripLines({
    ...reach,
    complete: false,
    gaps: [
      {
        join: 'J2',
        status: 'unmeasured',
        kind: 'not-built',
        reason: 'render-code coverage is not recorded yet',
        remedy: 'none yet: a later Change Reach phase (#934) adds it',
      },
    ],
  }).join('\n');
  assert.match(incomplete, /\*\*Reach incomplete\*\*/);
  assert.doesNotMatch(incomplete, /Reach complete|%/);
  for (const conflicting of [
    {
      ...reach,
      gaps: [{ join: 'J2', status: 'unmeasured', kind: 'not-built', reason: 'unmeasured', remedy: 'recapture' }],
    },
    {
      ...reach,
      counts: { reached: 0, 'never-rendered': 1, 'blind-channel': 0 },
      rules: [{ key: '.fault', change: 'changed', status: 'never-rendered', why: 'its selector never matched' }],
    },
    { ...reach, ledger: 'missing' },
  ]) {
    assert.match(
      reachStripLines(conflicting).join('\n'),
      /\*\*Reach incomplete\*\*/,
      'a stale complete flag cannot override missing evidence',
    );
  }
});
