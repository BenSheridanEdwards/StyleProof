// Reach cost (#989): what does recording reach evidence add to a capture?
//
//   node bench/reach-cost.mjs [--runs N] [--target react-table-repeat]   # measure (writes bench/reach-cost.results.json)
//
// Three modes per target, timed from navigation to the end of evidence collection:
//   off    — captureStyleMap alone (today)
//   J1     — plus CSS rule usage (CSS.startRuleUsageTracking → stopRuleUsageTracking)
//   J1+J2  — plus src/ navigation coverage and original-source resolution (no call counts)
// Modes rotate every round so machine drift spreads across all three. Timings are
// only as good as the host: the receipt records its load average, and the numbers
// worth citing come from the quiet CI runner (.github/workflows/reach-cost.yml).
import { chromium } from '@playwright/test';
import esbuild from 'esbuild';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { captureStyleMap, trackScriptReach } from '../dist/capture.js';
import { registerStyleProofSession } from '../dist/capture/script-coverage-ownership.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputArg = process.argv.indexOf('--output');
const RESULTS_PATH =
  outputArg === -1 ? path.join(ROOT, 'bench', 'reach-cost.results.json') : path.resolve(process.argv[outputArg + 1]);
const runsArg = process.argv.indexOf('--runs');
const RUNS = runsArg === -1 ? 7 : Number(process.argv[runsArg + 1]);
if (!Number.isInteger(RUNS) || RUNS < 1) {
  throw new Error(`--runs must be a positive integer, got ${JSON.stringify(process.argv[runsArg + 1])}`);
}
const MODES = ['off', 'J1', 'J1+J2'];
// Proposed in #989, agreed before measuring: overhead of each mode over `off`.
const THRESHOLDS = { J1: 0.05, 'J1+J2': 0.15 };

// The React fixture is bundled the way a production capture build would be.
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-reach-cost-'));
await esbuild.build({
  entryPoints: [path.join(ROOT, 'bench/fixtures/reach-cost/app.jsx')],
  bundle: true,
  minify: true,
  sourcemap: true,
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  outdir: out,
  entryNames: 'app',
  logLevel: 'warning',
});
fs.writeFileSync(
  path.join(out, 'index.html'),
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="app.css"></head>' +
    '<body><div id="root"></div><script src="app.js"></script></body></html>\n',
);

// A real cacheable server is necessary: Playwright routing disables the HTTP cache.
const server = createServer((request, response) => {
  const name = path.basename(new URL(request.url, 'http://fixture.test').pathname) || 'index.html';
  const resource = path.join(out, name);
  if (!fs.existsSync(resource)) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, {
    'cache-control': 'max-age=3600',
    'content-type': name.endsWith('.js')
      ? 'application/javascript'
      : name.endsWith('.css')
        ? 'text/css'
        : name.endsWith('.map')
          ? 'application/json'
          : 'text/html',
  });
  response.end(fs.readFileSync(resource));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const repeatUrl = `http://127.0.0.1:${server.address().port}/`;

const TARGETS = [
  {
    id: 'detection-fixture',
    kind: 'static, CSS-rich',
    url: pathToFileURL(path.join(ROOT, 'bench/detection-fixture.html')).href,
  },
  {
    id: 'example-demo',
    kind: 'static dogfood surface',
    url: pathToFileURL(path.join(ROOT, 'example/demo/index.html')).href,
  },
  { id: 'react-table', kind: 'React, 300 rows', url: pathToFileURL(path.join(out, 'index.html')).href },
  {
    id: 'react-table-repeat',
    kind: 'React, 300 rows, mean of 3 cacheable navigations on one page',
    url: repeatUrl,
    navigations: 3,
  },
];

const targetArg = process.argv.indexOf('--target');
const selectedTargets =
  targetArg === -1 ? TARGETS : TARGETS.filter((target) => target.id === process.argv[targetArg + 1]);
if (!selectedTargets.length) throw new Error('unknown reach-cost target');

async function measure(browser, target, mode) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    const samples = [];
    for (let visit = 0; visit < (target.navigations ?? 1); visit++)
      samples.push(await measureNavigation(page, target, mode));
    const mean = (key) => samples.reduce((sum, sample) => sum + sample[key], 0) / samples.length;
    return { load: mean('load'), total: mean('total'), bytes: samples.at(-1).bytes };
  } finally {
    await page.close();
  }
}

async function measureNavigation(page, target, mode) {
  const scriptReach = mode === 'J1+J2' ? await trackScriptReach(page) : undefined;
  const cdp = registerStyleProofSession(await page.context().newCDPSession(page));
  if (mode !== 'off') {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    await cdp.send('CSS.startRuleUsageTracking');
  }
  const start = performance.now();
  await page.goto(target.url, { waitUntil: 'load' });
  const loaded = performance.now();
  const map = await captureStyleMap(page, { captureScriptReach: mode === 'J1+J2', scriptReach });
  const bytes = { J1: 0, J2: 0 };
  if (mode !== 'off') bytes.J1 = JSON.stringify((await cdp.send('CSS.stopRuleUsageTracking')).ruleUsage).length;
  if (scriptReach) {
    if (
      target.id.startsWith('react-table') &&
      (map.scriptReach?.status !== 'measured' || !map.scriptReach?.scripts.some((script) => script.status === 'mapped'))
    ) {
      throw new Error('React cost target did not resolve app-source coverage');
    }
    bytes.J2 = JSON.stringify(map.scriptReach).length;
  }
  const done = performance.now();
  await cdp.detach();
  return { load: loaded - start, total: done - start, bytes };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const round = (n) => Math.round(n * 10) / 10;

const loadavgStart = os.loadavg();
const browser = await chromium.launch();
const samples = Object.fromEntries(selectedTargets.map((t) => [t.id, Object.fromEntries(MODES.map((m) => [m, []]))]));
for (const target of selectedTargets) for (const mode of MODES) await measure(browser, target, mode); // warm-up, discarded
for (let r = 0; r < RUNS; r++)
  for (const target of selectedTargets)
    for (const mode of [...MODES.slice(r % MODES.length), ...MODES.slice(0, r % MODES.length)])
      samples[target.id][mode].push(await measure(browser, target, mode));
const browserVersion = browser.version();
await browser.close();
await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
fs.rmSync(out, { recursive: true, force: true });

const targets = selectedTargets.map((t) => {
  const s = samples[t.id];
  const off = median(s.off.map((x) => x.total));
  const modes = Object.fromEntries(
    MODES.map((m) => [
      m,
      {
        medianLoadMs: round(median(s[m].map((x) => x.load))),
        medianTotalMs: round(median(s[m].map((x) => x.total))),
        minTotalMs: round(Math.min(...s[m].map((x) => x.total))),
        maxTotalMs: round(Math.max(...s[m].map((x) => x.total))),
        rawEvidenceBytes: s[m][0].bytes,
      },
    ]),
  );
  const overhead = Object.fromEntries(
    Object.keys(THRESHOLDS).map((m) => [m, round(((median(s[m].map((x) => x.total)) - off) / off) * 100)]),
  );
  return { id: t.id, kind: t.kind, modes, overheadPct: overhead };
});
const verdict = Object.fromEntries(
  Object.entries(THRESHOLDS).map(([m, limit]) => [
    m,
    targets.every((t) => t.overheadPct[m] <= limit * 100) ? 'within threshold' : 'over threshold',
  ]),
);

const lines = [`StyleProof reach cost — ${RUNS} run(s) per mode, chromium ${browserVersion}`, ``];
for (const t of targets) {
  lines.push(`  ${t.id} (${t.kind})`);
  for (const m of MODES)
    lines.push(
      `    ${m.padEnd(6)} median ${String(t.modes[m].medianTotalMs).padStart(7)} ms` +
        ` (load ${t.modes[m].medianLoadMs} ms, range ${t.modes[m].minTotalMs}–${t.modes[m].maxTotalMs})` +
        (m === 'off' ? '' : `  overhead ${t.overheadPct[m]}%`),
    );
}
lines.push(
  ``,
  `  J1 ≤ ${THRESHOLDS.J1 * 100}%: ${verdict.J1}`,
  `  J1+J2 ≤ ${THRESHOLDS['J1+J2'] * 100}%: ${verdict['J1+J2']}`,
);
lines.push(
  `  host load average ${loadavgStart.map(round).join(' / ')} at start, ${os.loadavg().map(round).join(' / ')} at end`,
);
console.log(lines.join('\n'));

const receipt = {
  generated: new Date().toISOString(),
  host: {
    platform: `${os.platform()} ${os.arch()}`,
    cpus: os.cpus().length,
    loadavgStart: loadavgStart.map(round),
    loadavgEnd: os.loadavg().map(round),
    ci: process.env.GITHUB_ACTIONS === 'true',
  },
  scriptEvidence: 'src/ original-source ranges (J2 bytes use the legacy rawEvidenceBytes field)',
  node: process.version,
  browser: `chromium ${browserVersion}`,
  runs: RUNS,
  thresholds: {
    J1: `≤ ${THRESHOLDS.J1 * 100}%`,
    'J1+J2': `≤ ${THRESHOLDS['J1+J2'] * 100}%`,
    basis: 'median total vs off',
  },
  verdict,
  targets,
};
fs.writeFileSync(RESULTS_PATH, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`\nreceipt → ${path.relative(ROOT, RESULTS_PATH)}`);
