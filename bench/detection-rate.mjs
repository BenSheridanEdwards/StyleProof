// Detection-rate corpus: does a seeded CSS/DOM change actually surface in the
// computed-style diff — and does a computed-identical change stay silent?
//
//   npm run bench:detection          # measure (writes bench/detection-corpus.results.json)
//   npm run bench:detection:check    # same, exit 1 on any violated expectation
//
// Every case runs the real path — a mutated fixture page rendered in Chromium,
// captured by captureStyleMap, compared by diffStyleMaps — never a synthetic
// detector. Expectations live in bench/detection-corpus.json (single source of
// truth): `detect` = finding must land on the marker element (and name an
// expected prop when declared), `clean` = zero findings, `blind` = a documented
// boundary that must stay zero until the contract grows — either direction of
// drift fails --check.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { captureStyleMap } from '../dist/capture.js';
import { diffContentMaps, diffStyleMaps } from '../dist/diff.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS_PATH = path.join(ROOT, 'bench', 'detection-corpus.json');
const RESULTS_PATH = path.join(ROOT, 'bench', 'detection-corpus.results.json');
const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
const FIXTURE_URL = pathToFileURL(path.join(ROOT, corpus.fixture)).href;
const CHECK = process.argv.includes('--check');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
function caseUrl(c) {
  const params = new URLSearchParams();
  if (c.css) params.set('css', b64(c.css));
  if (c.attr) params.set('attr', c.attr.map(b64).join(':'));
  if (c.text) params.set('text', c.text.map(b64).join(':'));
  return params.size ? `${FIXTURE_URL}?${params}` : FIXTURE_URL;
}

// A finding lands on the target when its class attribute carries the marker.
const markerOf = (sel) => sel.replace(/^\./, '');
const onTarget = (f, marker) => (f.cls ?? '').split(/\s+/).includes(marker);
const hasProp = (f, props) =>
  !props?.length ||
  (f.props ?? []).some((p) => props.some((want) => p.prop === want || p.prop.startsWith(`${want}-`)));

function verdict(c, findings) {
  const marker = c.sel ? markerOf(c.sel) : null;
  const targetFindings = marker ? findings.filter((f) => onTarget(f, marker)) : findings;
  if (c.expect === 'detect') {
    if (!targetFindings.length) return { ok: false, why: 'missed — no finding on the target element' };
    if (!targetFindings.some((f) => hasProp(f, c.props)))
      return {
        ok: false,
        why: `detected but imprecise — target findings lack props ${JSON.stringify(c.props)}`,
      };
    return { ok: true, why: `${targetFindings.length} finding(s) on target` };
  }
  if (!findings.length) return { ok: true, why: 'zero findings' };
  const unexpected = findings[0];
  return {
    ok: false,
    why: `${c.expect === 'clean' ? 'false positive' : 'boundary moved'} — ${unexpected.kind} finding on ${unexpected.cls || unexpected.path}`,
  };
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1280, height: 900 });

// Fixture determinism first: a corpus is only as good as a base that reads
// itself clean. Each capture mode (default + captureText for the advisory text
// layer) gets its own baseline, captured twice, and must self-diff to zero.
const bases = {};
for (const captureText of [false, true]) {
  await page.goto(FIXTURE_URL, { waitUntil: 'load' });
  const a = await captureStyleMap(page, { captureText });
  await page.reload({ waitUntil: 'load' });
  const b = await captureStyleMap(page, { captureText });
  const selfFindings = diffStyleMaps(a, b);
  if (selfFindings.length) {
    console.error(
      `fixture is not deterministic (captureText=${captureText}) — baseline re-capture produced ${selfFindings.length} finding(s); corpus results would be noise`,
    );
    process.exit(2);
  }
  bases[captureText] = a;
}

const results = [];
for (const c of corpus.cases) {
  const captureText = c.captureText ?? false;
  await page.goto(caseUrl(c), { waitUntil: 'load' });
  const map = await captureStyleMap(page, { captureText });
  // captureText cases also run the advisory content diff (diffContentMaps) —
  // the layer styleproof-report renders for text changes. Advisory findings
  // never gate, but the corpus measures whether they surface.
  const findings = [
    ...diffStyleMaps(bases[captureText], map),
    ...(captureText ? diffContentMaps(bases[captureText], map) : []),
  ];
  results.push({ ...c, findings: findings.length, ...verdict(c, findings) });
}
await browser.close();

const by = (expect) => results.filter((r) => r.expect === expect);
const detected = by('detect').filter((r) => r.ok);
const clean = by('clean').filter((r) => r.ok);
const blind = by('blind').filter((r) => r.ok);
const failed = results.filter((r) => !r.ok);
const rate = detected.length / by('detect').length;

const lines = [
  `StyleProof detection corpus — ${results.length} cases on ${path.basename(corpus.fixture)}`,
  ``,
  `  detect  ${detected.length}/${by('detect').length}  (${(rate * 100).toFixed(1)}% — seeded changes surfaced)`,
  `  clean   ${clean.length}/${by('clean').length}  (computed-identical changes stayed silent)`,
  `  blind   ${blind.length}/${by('blind').length}  (documented boundaries held)`,
  ``,
];
for (const r of results) lines.push(`  ${r.ok ? '✓' : '✗'} ${r.id} [${r.category}] ${r.desc} — ${r.why}`);
console.log(lines.join('\n'));

const receipt = {
  generated: new Date().toISOString(),
  fixture: corpus.fixture,
  totals: {
    cases: results.length,
    detected: `${detected.length}/${by('detect').length}`,
    detectionRate: rate,
    clean: `${clean.length}/${by('clean').length}`,
    blind: `${blind.length}/${by('blind').length}`,
    failed: failed.map((r) => r.id),
  },
  cases: results.map(({ id, category, expect, desc, findings, ok, why }) => ({
    id,
    category,
    expect,
    desc,
    findings,
    ok,
    why,
  })),
};
fs.writeFileSync(RESULTS_PATH, JSON.stringify(receipt, null, 2) + '\n');
console.log(`\nreceipt → ${path.relative(ROOT, RESULTS_PATH)}`);

if (CHECK && failed.length) {
  console.error(`\n✗ ${failed.length} case(s) violated their expectation`);
  process.exit(1);
}
