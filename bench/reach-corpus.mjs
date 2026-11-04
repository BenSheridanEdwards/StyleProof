// Reach corpus (#988): on a PR whose spec only opens the healthy state, how many
// of its visual changes does today's diff show — and do the reach joins name the
// rest? J1 runs classifyRuleReach on the captureReach ledger; J2 runs src/script-join.ts; J3 remains a prototype.
//
//   pnpm run bench:reach          # measure (writes bench/reach-corpus.results.json)
//   pnpm run bench:reach:check    # same, exit 1 on any violated expectation
//
// The fixture is the base side. The head side is the base plus every case's
// `edit`, so each seeded change belongs to the case that declares it. The real
// product path runs end to end: esbuild bundles each side with source maps,
// Chromium renders it, captureStyleMap captures it with captureReach and V8 JS
// coverage, and diffStyleMaps compares base and head. Expectations live in
// bench/reach-corpus.json; drift in either direction fails --check, so a fix for a
// documented miss or residual must update the corpus on purpose.
import { chromium } from '@playwright/test';
import esbuild from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { captureStyleMap, trackServedRules, trackScriptReach } from '../dist/capture.js';
import { classifyRuleReach } from '../dist/rule-reach.js';
import { classifyScriptReach } from '../dist/script-join.js';
import { changedScriptRanges } from '../dist/script-join-git.js';
import { diffStyleMaps } from '../dist/diff.js';
import { hasProp, markerOf, onTarget } from './finding-match.mjs';
import { classReach, classVocabulary, diffHunks } from './reach-joins.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS_PATH = path.join(ROOT, 'bench', 'reach-corpus.json');
const RESULTS_PATH = path.join(ROOT, 'bench', 'reach-corpus.results.json');
const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
const FIXTURE = path.join(ROOT, corpus.fixture);
const CHECK = process.argv.includes('--check');
const SIDES = ['base', 'head'];

// ---- write both sides' sources: head = base + every case edit --------------------
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-reach-'));
const src = (side, file = '') => path.join(out, 'src', side, file);
for (const side of SIDES) fs.cpSync(FIXTURE, src(side), { recursive: true });
for (const c of corpus.cases)
  for (const edit of c.edit) {
    const text = fs.readFileSync(src('head', edit.file), 'utf8');
    if (text.split(edit.from).length !== 2)
      throw new Error(`${c.id}: edit "from" must occur exactly once in ${edit.file} — ${JSON.stringify(edit.from)}`);
    fs.writeFileSync(src('head', edit.file), text.replace(edit.from, edit.to));
  }

// ---- build each side: bundled JS + CSS (CSS Modules included) with source maps ----
for (const side of SIDES) {
  await esbuild.build({
    entryPoints: [src(side, 'app.jsx')],
    bundle: true,
    sourcemap: true,
    outdir: path.join(out, side),
    entryNames: 'app',
    jsxFactory: 'h',
    logLevel: 'warning',
  });
  fs.writeFileSync(
    path.join(out, side, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="app.css"></head>' +
      '<body><div id="root"></div><script src="app.js"></script></body></html>\n',
  );
}

const sourceLines = Object.fromEntries(
  SIDES.map((side) => [side, fs.readFileSync(src(side, 'app.jsx'), 'utf8').split('\n')]),
);
const hunks = diffHunks(src('base', 'app.jsx'), src('head', 'app.jsx'));

// ---- capture one side × surface with reach evidence recorded ----------------------
async function capture(browser, side, surface) {
  const page = await browser.newPage({
    viewport: { width: surface.width, height: 800 },
    colorScheme: surface.colorScheme,
  });

  const scriptReach = await trackScriptReach(page, { projectRoot: fs.realpathSync(src(side)) });
  const servedRules = await trackServedRules(page);
  try {
    await page.goto(pathToFileURL(path.join(out, side, 'index.html')).href + surface.query, { waitUntil: 'load' });
    const map = await captureStyleMap(page, { captureReach: true, servedRules, captureScriptReach: true, scriptReach });

    return { map };
  } finally {
    await scriptReach.dispose();
    await servedRules.dispose();
    await page.close();
  }
}

const browser = await chromium.launch();

// Fixture determinism first: the healthy base, captured twice, must self-diff to
// zero AND record identical reach evidence, or every reach verdict could be luck.
{
  const a = await capture(browser, 'base', corpus.surfaces.home);
  const b = await capture(browser, 'base', corpus.surfaces.home);
  const styleDrift = diffStyleMaps(a.map, b.map).length;
  const reachState =
    !a.map.reach || !b.map.reach ? 'missing' : isDeepStrictEqual(a.map.reach, b.map.reach) ? 'stable' : 'drifted';

  const ranA = JSON.stringify(a.map.scriptReach);
  const ranB = JSON.stringify(b.map.scriptReach);

  if (styleDrift || reachState !== 'stable' || !a.map.scriptReach || ranA !== ranB) {
    console.error(
      `fixture is not deterministic — style drift ${styleDrift}, reach ledger ${reachState}, ` +
        `execution ${ranA === ranB ? 'stable' : 'drifted'}; corpus results would be noise`,
    );
    process.exit(2);
  }
}

const caps = { base: {}, head: {} };
for (const side of SIDES)
  for (const [id, surface] of Object.entries(corpus.surfaces)) caps[side][id] = await capture(browser, side, surface);
const browserVersion = browser.version();
await browser.close();
fs.rmSync(out, { recursive: true, force: true });

// ---- one scenario: today's findings plus a reach status per changed unit ----------

/** J2 then J3 for one changed line pair of app.jsx; a removed line is judged on base. */
function jsUnit(baseLine, headLine, pick, vocabulary, pairs) {
  const side = headLine ? 'head' : 'base';
  const line = headLine ?? baseLine;

  const changes = changedScriptRanges(
    `@@ -${baseLine ?? 0},${baseLine ? 1 : 0} +${headLine ?? 0},${headLine ? 1 : 0} @@\n` +
      (baseLine ? `-${sourceLines.base[baseLine - 1]}\n` : '') +
      (headLine ? `+${sourceLines.head[headLine - 1]}\n` : ''),
    { base: sourceLines.base.join('\n'), head: sourceLines.head.join('\n') },
    'app.jsx',
  );

  const script = classifyScriptReach(
    pick('base').map((c) => c.map),
    pick('head').map((c) => c.map),
    changes,
  );

  const evidence = script.units.find((unit) => unit.side === side);
  const J2 = evidence?.execution ?? 'unmeasured';

  const J3 =
    baseLine && headLine
      ? classReach(sourceLines.base[baseLine - 1], sourceLines.head[headLine - 1], vocabulary, pairs).status
      : 'n/a';

  // Token-name deltas are displayed separately and never corroborate src J2.
  const status = evidence?.status ?? 'unmeasured';

  return {
    kind: 'js',
    key: `app.jsx:${line}`,
    text: sourceLines[side][line - 1],
    status,
    joins: { J2 },
    prototypeJ3: J3,
    why: evidence?.why,
  };
}

function evaluate(surfaceIds) {
  const pick = (side) => surfaceIds.map((id) => caps[side][id]);
  const j1 = classifyRuleReach(
    pick('base').map((c) => c.map),
    pick('head').map((c) => c.map),
  );
  const vocabulary = classVocabulary(
    SIDES.flatMap((side) => pick(side).flatMap((c) => (c.map.reach?.rules ?? []).map((r) => r.key))),
  );
  const pairs = surfaceIds.map((id) => ({ base: caps.base[id].map, head: caps.head[id].map }));
  const units = j1.rules.map((r) => ({ kind: 'css', key: r.key, selector: r.key, status: r.status, why: r.why }));
  for (const hunk of hunks)
    for (let i = 0; i < Math.max(hunk.base.length, hunk.head.length); i++)
      units.push(jsUnit(hunk.base[i], hunk.head[i], pick, vocabulary, pairs));
  return {
    findings: pairs.flatMap((p) => diffStyleMaps(p.base, p.head)),
    units,
    ledger: j1.ledger,
    unreadableSheets: j1.unreadableSheets,
  };
}

const matches = (c, u) =>
  u.kind === 'css'
    ? Boolean(c.unit.css) && new RegExp(c.unit.css).test(u.selector)
    : Boolean(c.unit.js) && u.text.includes(c.unit.js);
const worst = (units) =>
  ['never-rendered', 'blind-channel', 'unmeasured', 'unknown'].find((s) => units.some((u) => u.status === s)) ??
  'reached';

const failures = [];
const results = corpus.cases.map((c) => ({ id: c.id, category: c.category, desc: c.desc, scenarios: {} }));
for (const [scenario, surfaceIds] of Object.entries(corpus.scenarios)) {
  const { findings, units, ledger, unreadableSheets } = evaluate(surfaceIds);
  if (ledger !== 'complete')
    failures.push(`${scenario}: J1 ledger ${ledger} (${unreadableSheets} unreadable) — CSS reach is unknown`);
  for (const u of units) {
    const owners = corpus.cases.filter((c) => matches(c, u));
    if (owners.length !== 1)
      failures.push(
        `${scenario}: changed unit ${u.key} matches ${owners.length} cases — every change needs exactly one`,
      );
  }
  corpus.cases.forEach((c, i) => {
    const mine = units.filter((u) => matches(c, u));
    const js = mine.find((u) => u.kind === 'js');
    const got = {
      ...(c.sel && {
        today: findings.some((f) => onTarget(f, markerOf(c.sel)) && hasProp(f, c.props)) ? 'shown' : 'missed',
      }),
      reach: mine.length ? worst(mine) : 'no changed unit',
      ...(js && { joins: js.joins }),
      units: mine.map(
        (u) =>
          `${u.key}: ${u.status}${u.why ? ` (${u.why})` : ''}${u.prototypeJ3 && u.prototypeJ3 !== 'n/a' ? `; J3-prototype ${u.prototypeJ3} (#1001 re-judges per-occurrence provenance)` : ''}`,
      ),
    };
    if (js?.prototypeJ3 && js.prototypeJ3 !== 'n/a') got.prototypeJ3 = js.prototypeJ3;
    const want = c.expect[scenario];
    const wrong = [
      ...(want.today && got.today !== want.today ? [`today ${got.today}, want ${want.today}`] : []),
      ...(got.reach !== want.reach ? [`reach ${got.reach}, want ${want.reach}`] : []),
      ...(want.prototypeJ3 && got.prototypeJ3 !== want.prototypeJ3
        ? [`J3-prototype ${got.prototypeJ3}, want ${want.prototypeJ3}`]
        : []),
      ...Object.entries(want.joins ?? {})
        .filter(([join, status]) => got.joins?.[join] !== status)
        .map(([join, status]) => `${join} ${got.joins?.[join]}, want ${status}`),
    ];
    if (wrong.length) failures.push(`${scenario}: ${c.id} — ${wrong.join('; ')}`);
    results[i].scenarios[scenario] = { ...got, ok: !wrong.length };
  });
}

// ---- summary ------------------------------------------------------------------
const visual = corpus.cases.filter((c) => c.sel);
const tally = (scenario, pred) =>
  visual.filter((c, i) => pred(results[corpus.cases.indexOf(c)].scenarios[scenario], c, i)).length;
const shown = (s) => tally(s, (r) => r.today === 'shown');
const missed = visual.filter((c) => results[corpus.cases.indexOf(c)].scenarios.declared.today === 'missed');
const named = missed.filter((c) => results[corpus.cases.indexOf(c)].scenarios.declared.reach !== 'reached');
const lines = [
  `StyleProof reach corpus — ${corpus.cases.length} changes on ${corpus.fixture} (${visual.length} visual)`,
  ``,
  `  declared spec (${corpus.scenarios.declared.join(', ')}): today's diff shows ${shown('declared')}/${visual.length} visual changes`,
  `  reach joins name ${named.length}/${missed.length} of the misses (${missed.length - named.length} pinned residual)`,
  `  complete spec (${corpus.scenarios.complete.length} surfaces): today's diff shows ${shown('complete')}/${visual.length}`,
  ``,
];
for (const r of results)
  for (const [scenario, s] of Object.entries(r.scenarios))
    lines.push(
      `  ${s.ok ? '✓' : '✗'} ${r.id} [${scenario}] today ${s.today ?? 'n/a'} · reach ${s.reach}` +
        (s.joins ? ` · J2 ${s.joins.J2}` : '') +
        (s.prototypeJ3 ? ` · J3-prototype ${s.prototypeJ3} (#1001: per-occurrence provenance pending)` : ''),
    );
console.log(lines.join('\n'));

const receipt = {
  generated: new Date().toISOString(),
  browser: `chromium ${browserVersion}`,
  fixture: corpus.fixture,
  totals: {
    cases: corpus.cases.length,
    visual: visual.length,
    todayShownDeclared: `${shown('declared')}/${visual.length}`,
    todayShownComplete: `${shown('complete')}/${visual.length}`,
    missesNamedByReach: `${named.length}/${missed.length}`,
    residual: missed.filter((c) => !named.includes(c)).map((c) => c.id),
    failed: failures,
  },
  cases: results,
};
if (!CHECK) {
  fs.writeFileSync(RESULTS_PATH, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`\nreceipt → ${path.relative(ROOT, RESULTS_PATH)}`);
}
if (failures.length) {
  console.error(`\n${failures.length} violated expectation(s):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
