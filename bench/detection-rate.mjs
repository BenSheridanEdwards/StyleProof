#!/usr/bin/env node
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { captureStyleMap, diffStyleMaps } from '../dist/index.js';
import {
  assertBenchmarkSourceBinding,
  isSafeBenchmarkCaseId,
  resolveNewBenchmarkOutput,
  validateDetectionBenchmarkReceipt,
} from '../dist/detection-benchmark.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEVANT_PATHS = [
  'bench/detection-corpus-v1.json',
  'bench/detection-corpus-v1.manifest.json',
  'bench/detection-corpus-v1.review.md',
  'bench/detection-rate.mjs',
  'src/capture.ts',
  'src/diff.ts',
  'src/detection-benchmark.ts',
  'package.json',
];

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(
        'usage: detection-rate --corpus FILE --out DIR --scope smoke|pilot [--case ID] [--expect-source-sha SHA]',
      );
    }
    values[key.slice(2)] = value;
  }
  if (!values.corpus || !values.out || !values.scope) throw new Error('missing required benchmark argument');
  if (!['smoke', 'pilot'].includes(values.scope)) {
    throw new Error('this bounded runner supports only smoke and pilot scopes, not full447');
  }
  if (values['expect-source-sha'] && !/^[0-9a-f]{40}$/.test(values['expect-source-sha'])) {
    throw new Error('--expect-source-sha must be a full lowercase commit SHA');
  }
  return values;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function documentFor(css, body) {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;background:rgb(255,255,255);font-family:Arial,sans-serif}' +
    `main{padding:24px}${css}</style></head><body>${body}</body></html>`
  );
}

async function observeProof(page, proof) {
  if (proof.action === 'hover') await page.locator(proof.actionSelector).hover();
  return page.locator(proof.selector).evaluate((element, descriptor) => {
    const style = element.ownerDocument.defaultView.getComputedStyle(element, descriptor.pseudo);
    return style[descriptor.property];
  }, proof);
}

async function captureProofSide(browser, benchmarkCase, side, screenshotPath) {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
  try {
    await page.setContent(documentFor(benchmarkCase[`${side}Css`], benchmarkCase.body), { waitUntil: 'load' });
    const observed = await observeProof(page, benchmarkCase.proof);
    await page.locator(benchmarkCase.proof.selector).screenshot({ path: screenshotPath });
    return observed;
  } finally {
    await page.close();
  }
}

async function captureSensorSide(browser, benchmarkCase, side) {
  // A fresh page proves that the oracle's hover/focus/pointer state cannot leak
  // into the sensor. captureStyleMap must force its own interaction layers.
  const page = await browser.newPage({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
  try {
    await page.setContent(documentFor(benchmarkCase[`${side}Css`], benchmarkCase.body), { waitUntil: 'load' });
    return await captureStyleMap(page, { stabilize: false });
  } finally {
    await page.close();
  }
}

function changedPixelCount(beforePath, afterPath) {
  const before = PNG.sync.read(fs.readFileSync(beforePath));
  const after = PNG.sync.read(fs.readFileSync(afterPath));
  if (before.width !== after.width || before.height !== after.height) {
    return Math.max(before.width * before.height, after.width * after.height);
  }
  let changed = 0;
  for (let index = 0; index < before.data.length; index += 4) {
    if (
      before.data[index] !== after.data[index] ||
      before.data[index + 1] !== after.data[index + 1] ||
      before.data[index + 2] !== after.data[index + 2] ||
      before.data[index + 3] !== after.data[index + 3]
    ) {
      changed++;
    }
  }
  return changed;
}

function findingMatches(finding, expected) {
  if (finding.kind !== expected.findingKind) return false;
  if (expected.findingState && finding.state !== expected.findingState) return false;
  if (!expected.findingProperty) return true;
  return finding.props?.some((property) => property.prop === expected.findingProperty) ?? false;
}

async function runCase(browser, benchmarkCase, outputDirectory) {
  if (!isSafeBenchmarkCaseId(benchmarkCase.id)) throw new Error('unsafe benchmark case ID');
  const caseDirectory = path.join(outputDirectory, 'cases', benchmarkCase.id);
  fs.mkdirSync(caseDirectory, { recursive: true });
  const beforeScreenshot = path.join(caseDirectory, 'before.png');
  const afterScreenshot = path.join(caseDirectory, 'after.png');
  const beforeObserved = await captureProofSide(browser, benchmarkCase, 'before', beforeScreenshot);
  const afterObserved = await captureProofSide(browser, benchmarkCase, 'after', afterScreenshot);
  const changedPixels = changedPixelCount(beforeScreenshot, afterScreenshot);
  const expectedChange = benchmarkCase.expected.renderChanged;
  const observedPropertyChange = beforeObserved !== afterObserved;
  const observedPixelChange = changedPixels > 0;
  const propertyMatches = beforeObserved === benchmarkCase.proof.before && afterObserved === benchmarkCase.proof.after;
  const renderProven =
    propertyMatches && observedPropertyChange === expectedChange && observedPixelChange === expectedChange;
  const renderProof = {
    expectedChange,
    observedPropertyChange,
    observedPixelChange,
    changedPixels,
    propertyMatches,
    proofMatches: renderProven,
    before: beforeObserved,
    after: afterObserved,
  };
  const screenshots = [`cases/${benchmarkCase.id}/before.png`, `cases/${benchmarkCase.id}/after.png`];
  if (!renderProven) {
    return {
      id: benchmarkCase.id,
      class: benchmarkCase.class,
      outcome: 'invalid',
      renderProof,
      findingCount: 0,
      screenshots,
    };
  }

  // Scoring starts only after the separate DOM-property + scoped-pixel oracle
  // has proved the frozen intended render expectation.
  const beforeMap = await captureSensorSide(browser, benchmarkCase, 'before');
  const afterMap = await captureSensorSide(browser, benchmarkCase, 'after');
  const findings = diffStyleMaps(beforeMap, afterMap);
  const intendedFindingDetected = findings.some((finding) => findingMatches(finding, benchmarkCase.expected));
  const outcome = !expectedChange
    ? findings.length === 0
      ? 'no-op-true-negative'
      : 'no-op-false-positive'
    : intendedFindingDetected
      ? 'detected'
      : 'missed';
  return {
    id: benchmarkCase.id,
    class: benchmarkCase.class,
    outcome,
    renderProof,
    findingCount: findings.length,
    findings,
    screenshots,
  };
}

async function withTimeout(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('benchmark case timed out')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function countOutcomes(cases, requested) {
  const outcome = (name) => cases.filter((entry) => entry.outcome === name).length;
  const counts = {
    requested,
    executed: 0,
    valid: 0,
    detected: outcome('detected'),
    missed: outcome('missed'),
    unsupported: outcome('unsupported'),
    skipped: outcome('skipped'),
    timeout: outcome('timeout'),
    invalid: outcome('invalid'),
    duplicate: outcome('duplicate'),
    noOpFalsePositives: outcome('no-op-false-positive'),
    noOpTrueNegatives: outcome('no-op-true-negative'),
  };
  counts.valid = counts.detected + counts.missed + counts.noOpFalsePositives + counts.noOpTrueNegatives;
  counts.executed = counts.valid + counts.unsupported + counts.timeout + counts.invalid;
  return counts;
}

function macosValue(flag, fallback) {
  if (process.platform !== 'darwin') return fallback;
  try {
    return execFileSync('sw_vers', [flag], { encoding: 'utf8' }).trim();
  } catch {
    return fallback;
  }
}

function markdown(receipt) {
  const counts = receipt.counts;
  const caseLines = receipt.cases
    .map(
      (entry) =>
        `- \`${entry.id}\`: **${entry.outcome}**; independent render proof ${entry.renderProof?.proofMatches ? 'matched' : 'did not match'} (${entry.renderProof?.changedPixels ?? 0} changed pixel(s)); ${entry.findingCount ?? 0} finding(s); screenshots: ${entry.screenshots?.join(', ') ?? 'none'}`,
    )
    .join('\n');
  return `# StyleProof issue #447 detection benchmark — ${receipt.scope.kind}

Diagnostic ${receipt.scope.kind} only. This is not a full issue #447 run, class-wide recall measurement, or whole-application coverage claim.

- Source SHA: \`${receipt.bindings.sourceSha}\`
- Corpus: \`${receipt.bindings.corpus.id}@${receipt.bindings.corpus.version}\` (sha256:\`${receipt.bindings.corpus.digest}\`)
- Browser: ${receipt.bindings.browser.name} ${receipt.bindings.browser.version}
- OS: ${receipt.bindings.runner.osVersion} (${receipt.bindings.runner.osBuild})
- Sensor executable: \`${receipt.bindings.sensor.name}@${receipt.bindings.sensor.contractVersion}\` (sha256:\`${receipt.bindings.sensor.digest}\`)
- Sensor source digest: sha256:\`${receipt.bindings.sensor.sourceDigest}\`

## Exact counts

| requested | executed | valid | detected | missed | unsupported | skipped | timeout | invalid | duplicate | no-op false positives | no-op true negatives |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ${counts.requested} | ${counts.executed} | ${counts.valid} | ${counts.detected} | ${counts.missed} | ${counts.unsupported} | ${counts.skipped} | ${counts.timeout} | ${counts.invalid} | ${counts.duplicate} | ${counts.noOpFalsePositives} | ${counts.noOpTrueNegatives} |

## Cases

${caseLines}

## Excluded / unknown

- Full issue #447 corpus: not run.
- Unsupported sensor classes and whole-application states: excluded.
- These observations must not be extrapolated beyond the named corpus and bound environment.
`;
}

const options = parseArgs(process.argv.slice(2));
const sourceBinding = assertBenchmarkSourceBinding(ROOT, options['expect-source-sha'], RELEVANT_PATHS);
const corpusPath = path.resolve(ROOT, options.corpus);
if (corpusPath !== path.resolve(ROOT, 'bench/detection-corpus-v1.json')) {
  throw new Error('runner accepts only the reviewed, frozen detection-corpus-v1.json');
}
const outputDirectory = resolveNewBenchmarkOutput(ROOT, options.out);
const corpusBytes = fs.readFileSync(corpusPath);
const corpus = JSON.parse(corpusBytes.toString('utf8'));
const manifest = JSON.parse(fs.readFileSync(path.resolve(ROOT, 'bench/detection-corpus-v1.manifest.json'), 'utf8'));
const corpusDigest = sha256(corpusBytes);
if (manifest.corpusSha256 !== corpusDigest || manifest.review?.status !== 'approved-pre-result') {
  throw new Error('corpus digest or pre-result review does not match the frozen manifest');
}
if (corpus.schemaVersion !== 1 || corpus.expectations?.status !== 'frozen-pre-run') {
  throw new Error('corpus expectations are not frozen');
}
if (corpus.expectations.expectedCardinality !== corpus.cases?.length) {
  throw new Error('corpus cardinality conflicts with frozen expectations');
}
const selected = options.case ? corpus.cases.filter((entry) => entry.id === options.case) : corpus.cases;
if (options.scope === 'smoke' && selected.length !== 1) throw new Error('smoke scope requires exactly one --case');
if (options.scope === 'pilot' && (options.case || selected.length !== corpus.cases.length)) {
  throw new Error('pilot scope must execute the exact complete pilot corpus');
}
fs.mkdirSync(outputDirectory, { recursive: true });
const browser = await chromium.launch();
const results = [];
const seen = new Set();
try {
  for (const benchmarkCase of selected) {
    if (seen.has(benchmarkCase.id)) {
      results.push({
        id: benchmarkCase.id,
        class: benchmarkCase.class,
        outcome: 'duplicate',
        findingCount: 0,
        screenshots: [],
      });
      continue;
    }
    seen.add(benchmarkCase.id);
    if (!isSafeBenchmarkCaseId(benchmarkCase.id)) {
      results.push({
        id: String(benchmarkCase.id),
        class: benchmarkCase.class,
        outcome: 'invalid',
        findingCount: 0,
        screenshots: [],
        reason: 'unsafe benchmark case ID',
      });
      continue;
    }
    if (benchmarkCase.class === 'cross-element-state' && browser.browserType().name() !== 'chromium') {
      results.push({
        id: benchmarkCase.id,
        class: benchmarkCase.class,
        outcome: 'unsupported',
        findingCount: 0,
        screenshots: [],
      });
      continue;
    }
    try {
      results.push(await withTimeout(runCase(browser, benchmarkCase, outputDirectory), 30_000));
    } catch (error) {
      results.push({
        id: benchmarkCase.id,
        class: benchmarkCase.class,
        outcome: error?.message === 'benchmark case timed out' ? 'timeout' : 'invalid',
        findingCount: 0,
        screenshots: [],
        reason: String(error?.message ?? error),
      });
    }
  }
  const executableDigest = sha256(
    Buffer.concat([
      fs.readFileSync(path.resolve(ROOT, 'dist/capture.js')),
      fs.readFileSync(path.resolve(ROOT, 'dist/diff.js')),
    ]),
  );
  const sourceDigest = sha256(
    Buffer.concat([
      fs.readFileSync(path.resolve(ROOT, 'src/capture.ts')),
      fs.readFileSync(path.resolve(ROOT, 'src/diff.ts')),
    ]),
  );
  const receipt = {
    schemaVersion: 1,
    benchmark: 'styleproof-detection-rate',
    scope: { kind: options.scope, issue: 447, full447: false },
    bindings: {
      sourceSha: sourceBinding.sourceSha,
      packageVersion: JSON.parse(fs.readFileSync(path.resolve(ROOT, 'package.json'), 'utf8')).version,
      browser: { name: browser.browserType().name(), version: browser.version() },
      runner: {
        node: process.version,
        platform: process.platform,
        release: os.release(),
        arch: process.arch,
        osVersion: macosValue('-productVersion', os.version()),
        osBuild: macosValue('-buildVersion', os.release()),
      },
      sensor: {
        name: 'captureStyleMap+diffStyleMaps',
        contractVersion: 1,
        digest: executableDigest,
        sourceDigest,
        buildCommand: 'npm run build',
      },
      corpus: {
        id: corpus.corpusId,
        version: corpus.corpusVersion,
        digest: corpusDigest,
        cardinality: corpus.cases.length,
        manifest: 'bench/detection-corpus-v1.manifest.json',
      },
    },
    counts: countOutcomes(results, selected.length),
    cases: results,
    full447: { status: 'not-run', claimed: false },
  };
  const expectation = {
    sourceSha: sourceBinding.sourceSha,
    corpusId: corpus.corpusId,
    corpusVersion: corpus.corpusVersion,
    corpusDigest,
    corpusCardinality: corpus.cases.length,
    scopeKind: options.scope,
    requestedCardinality: selected.length,
    cases: selected.map((entry) => ({ id: entry.id, renderChanged: entry.expected.renderChanged })),
  };
  const validation = validateDetectionBenchmarkReceipt(receipt, expectation);
  const finalReceipt = { ...receipt, validation };
  fs.writeFileSync(path.join(outputDirectory, 'receipt.json'), `${JSON.stringify(finalReceipt, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDirectory, 'README.md'), markdown(finalReceipt));
  if (!validation.ok) throw new Error(`generated receipt failed closed: ${validation.reasons.join('; ')}`);
  process.stdout.write(`${JSON.stringify({ outputDirectory, counts: receipt.counts, validation }, null, 2)}\n`);
} finally {
  await browser.close();
}
