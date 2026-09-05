#!/usr/bin/env node
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXED_INPUTS = [
  'bench/detection-corpus-v1.json',
  'bench/detection-corpus-v1.manifest.json',
  'bench/detection-corpus-v1.review.md',
  'bench/detection-rate.mjs',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
];

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined)
      throw new Error(
        'usage: detection-rate --corpus FILE --out DIR --scope smoke|pilot [--case ID] [--expect-source-sha SHA]',
      );
    values[key.slice(2)] = value;
  }
  if (!values.corpus || !values.out || !values.scope) throw new Error('missing required benchmark argument');
  if (!['smoke', 'pilot'].includes(values.scope))
    throw new Error('this bounded runner supports only smoke and pilot scopes, not full447');
  if (values['expect-source-sha'] && !/^[0-9a-f]{40}$/.test(values['expect-source-sha']))
    throw new Error('--expect-source-sha must be a full lowercase commit SHA');
  return values;
}
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function namedFileDigest(files, read) {
  const hash = createHash('sha256');
  for (const file of [...files].sort()) {
    hash.update(file);
    hash.update('\0');
    hash.update(read(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}
function trackedSourcePaths() {
  const source = execFileSync('git', ['ls-files', '-z', '--', 'src/**/*.ts', 'src/*.ts'], { cwd: ROOT });
  return [...FIXED_INPUTS, ...source.toString('utf8').split('\0').filter(Boolean)];
}
function assertCleanSource(expectedSha) {
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (!/^[0-9a-f]{40}$/.test(sourceSha) || (expectedSha && sourceSha !== expectedSha))
    throw new Error('benchmark source SHA does not match clean Git HEAD');
  const relevant = trackedSourcePaths();
  execFileSync('git', ['ls-files', '--error-unmatch', '--', ...relevant], { cwd: ROOT, stdio: 'pipe' });
  const dirty = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', ...relevant, 'src'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (dirty.trim()) throw new Error('benchmark source/build inputs must be clean at Git HEAD');
  const sourceDigest = namedFileDigest(relevant, (file) =>
    execFileSync('git', ['show', `HEAD:${file}`], { cwd: ROOT }),
  );
  return { sourceSha, sourceDigest, relevant };
}
function runCleanBuild() {
  execFileSync('npm', ['run', 'clean'], { cwd: ROOT, stdio: 'inherit' });
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
}
function filesRecursively(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? filesRecursively(absolute) : [absolute];
  });
}
function builtClosureDigest() {
  const dist = path.resolve(ROOT, 'dist');
  const files = filesRecursively(dist)
    .filter((file) => file.endsWith('.js'))
    .map((file) => path.relative(ROOT, file).split(path.sep).join('/'));
  if (!files.length) throw new Error('clean build produced no executable JavaScript closure');
  return namedFileDigest(files, (file) => fs.readFileSync(path.resolve(ROOT, file)));
}
function frozenExpectations(corpus) {
  return corpus.cases.map(({ id, class: caseClass, expected }) => ({ id, class: caseClass, expected }));
}
function verifyCorpus(corpusBytes, corpus, manifest) {
  const corpusDigest = sha256(corpusBytes);
  const expectationDigest = sha256(Buffer.from(canonicalJson(frozenExpectations(corpus))));
  const reviewPath = path.resolve(ROOT, manifest.review?.record ?? '');
  const reviewDigest = fs.existsSync(reviewPath) ? sha256(fs.readFileSync(reviewPath)) : null;
  if (manifest.corpusSha256 !== corpusDigest || manifest.expectationSha256 !== expectationDigest)
    throw new Error('corpus or canonical expectation digest does not match frozen manifest');
  if (
    manifest.cardinality !== corpus.cases?.length ||
    corpus.expectations?.expectedCardinality !== corpus.cases?.length
  )
    throw new Error('corpus cardinality conflicts with frozen manifest');
  if (manifest.review?.status !== 'approved-pre-result' || manifest.review?.recordSha256 !== reviewDigest)
    throw new Error('pre-result review record is not bound by the frozen manifest');
  if (corpus.schemaVersion !== 1 || corpus.expectations?.status !== 'frozen-pre-run')
    throw new Error('corpus expectations are not frozen');
  return { corpusDigest, expectationDigest, reviewDigest };
}
function selectCases(corpus, options) {
  const selected = options.case ? corpus.cases.filter((entry) => entry.id === options.case) : corpus.cases;
  if (options.scope === 'smoke' && selected.length !== 1)
    throw new Error('smoke scope requires exactly one known --case');
  if (options.scope === 'pilot' && (options.case || selected.length !== corpus.cases.length))
    throw new Error('pilot scope must execute the exact complete pilot corpus');
  return selected;
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
  return page
    .locator(proof.selector)
    .evaluate(
      (element, descriptor) =>
        element.ownerDocument.defaultView.getComputedStyle(element, descriptor.pseudo)[descriptor.property],
      proof,
    );
}
async function captureProofSide(context, benchmarkCase, side, screenshotPath) {
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 640, height: 360 });
    await page.setContent(documentFor(benchmarkCase[`${side}Css`], benchmarkCase.body), { waitUntil: 'load' });
    const observed = await observeProof(page, benchmarkCase.proof);
    await page.locator(benchmarkCase.proof.selector).screenshot({ path: screenshotPath });
    return observed;
  } finally {
    await page.close();
  }
}
async function captureSensorSide(context, benchmarkCase, side, captureStyleMap) {
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 640, height: 360 });
    await page.setContent(documentFor(benchmarkCase[`${side}Css`], benchmarkCase.body), { waitUntil: 'load' });
    return await captureStyleMap(page, { stabilize: false });
  } finally {
    await page.close();
  }
}
function changedPixelCount(beforePath, afterPath) {
  const before = PNG.sync.read(fs.readFileSync(beforePath));
  const after = PNG.sync.read(fs.readFileSync(afterPath));
  if (before.width !== after.width || before.height !== after.height)
    return Math.max(before.width * before.height, after.width * after.height);
  let changed = 0;
  for (let index = 0; index < before.data.length; index += 4)
    if (before.data.subarray(index, index + 4).some((byte, offset) => byte !== after.data[index + offset])) changed++;
  return changed;
}
function artifactMetadata(root, relative) {
  const bytes = fs.readFileSync(path.resolve(root, relative));
  const image = PNG.sync.read(bytes);
  return { path: relative, sha256: sha256(bytes), width: image.width, height: image.height, bytes: bytes.length };
}
function findingMatches(finding, expected) {
  if (finding.kind !== expected.findingKind || (expected.findingState && finding.state !== expected.findingState))
    return false;
  return (
    !expected.findingProperty ||
    (finding.props?.some((property) => property.prop === expected.findingProperty) ?? false)
  );
}
async function runCase(context, benchmarkCase, outputDirectory, sensor) {
  const caseDirectory = path.join(outputDirectory, 'cases', benchmarkCase.id);
  fs.mkdirSync(caseDirectory, { recursive: true });
  const beforeRelative = `cases/${benchmarkCase.id}/before.png`;
  const afterRelative = `cases/${benchmarkCase.id}/after.png`;
  const beforePath = path.resolve(outputDirectory, beforeRelative);
  const afterPath = path.resolve(outputDirectory, afterRelative);
  const beforeObserved = await captureProofSide(context, benchmarkCase, 'before', beforePath);
  const afterObserved = await captureProofSide(context, benchmarkCase, 'after', afterPath);
  const changedPixels = changedPixelCount(beforePath, afterPath);
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
  const screenshots = [
    artifactMetadata(outputDirectory, beforeRelative),
    artifactMetadata(outputDirectory, afterRelative),
  ];
  if (!renderProven)
    return {
      id: benchmarkCase.id,
      class: benchmarkCase.class,
      outcome: 'invalid',
      renderProof,
      findingCount: 0,
      findings: [],
      screenshots,
    };
  const beforeMap = await captureSensorSide(context, benchmarkCase, 'before', sensor.captureStyleMap);
  const afterMap = await captureSensorSide(context, benchmarkCase, 'after', sensor.captureStyleMap);
  const findings = sensor.diffStyleMaps(beforeMap, afterMap);
  const found = findings.some((finding) => findingMatches(finding, benchmarkCase.expected));
  const outcome = !expectedChange
    ? findings.length
      ? 'no-op-false-positive'
      : 'no-op-true-negative'
    : found
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
async function executeCase(browser, benchmarkCase, outputDirectory, sensor, lifecycle) {
  const context = await browser.newContext({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
  try {
    const settled = await lifecycle.settleBenchmarkTask(async (signal) => {
      signal.addEventListener(
        'abort',
        () => {
          void context.close();
        },
        { once: true },
      );
      return runCase(context, benchmarkCase, outputDirectory, sensor);
    }, 30_000);
    return settled.timedOut
      ? {
          id: benchmarkCase.id,
          class: benchmarkCase.class,
          outcome: 'timeout',
          findingCount: 0,
          findings: [],
          screenshots: [],
          reason: 'benchmark case timed out',
        }
      : settled.value;
  } finally {
    await context.close().catch(() => undefined);
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
  const lines = receipt.cases
    .map(
      (entry) =>
        `- \`${entry.id}\`: **${entry.outcome}**; render proof ${entry.renderProof?.proofMatches ? 'matched' : 'did not match'}; ${entry.findingCount ?? 0} finding(s)`,
    )
    .join('\n');
  return `# StyleProof issue #447 detection benchmark: ${receipt.scope.kind}\n\nDiagnostic ${receipt.scope.kind} only. This is not a full issue #447 run, class-wide recall measurement, or whole-application coverage claim.\n\n- Source SHA: \`${receipt.bindings.sourceSha}\`\n- Corpus: \`${receipt.bindings.corpus.id}@${receipt.bindings.corpus.version}\` (sha256:\`${receipt.bindings.corpus.digest}\`)\n- Frozen expectation digest: sha256:\`${receipt.bindings.corpus.expectationDigest}\`\n- Browser: ${receipt.bindings.browser.name} ${receipt.bindings.browser.version}\n- OS: ${receipt.bindings.runner.osVersion} (${receipt.bindings.runner.osBuild})\n- Clean-build executable closure: sha256:\`${receipt.bindings.sensor.digest}\`\n- Bound source/build-input closure: sha256:\`${receipt.bindings.sensor.sourceDigest}\`\n\n## Exact counts\n\n| requested | executed | valid | detected | missed | unsupported | skipped | timeout | invalid | duplicate | no-op false positives | no-op true negatives |\n|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n| ${counts.requested} | ${counts.executed} | ${counts.valid} | ${counts.detected} | ${counts.missed} | ${counts.unsupported} | ${counts.skipped} | ${counts.timeout} | ${counts.invalid} | ${counts.duplicate} | ${counts.noOpFalsePositives} | ${counts.noOpTrueNegatives} |\n\n## Cases\n\n${lines}\n\n## Excluded / unknown\n\n- Full issue #447 corpus: not run.\n- Unsupported sensor classes and whole-application states: excluded.\n- These observations must not be extrapolated beyond the named corpus and bound environment.\n`;
}
function expectedCases(selected) {
  return selected.map((entry) => ({ id: entry.id, class: entry.class, ...entry.expected }));
}

const options = parseArgs(process.argv.slice(2));
const source = assertCleanSource(options['expect-source-sha']);
const corpusPath = path.resolve(ROOT, options.corpus);
if (corpusPath !== path.resolve(ROOT, 'bench/detection-corpus-v1.json'))
  throw new Error('runner accepts only the reviewed, frozen detection-corpus-v1.json');
const corpusBytes = fs.readFileSync(corpusPath);
const corpus = JSON.parse(corpusBytes.toString('utf8'));
const manifest = JSON.parse(fs.readFileSync(path.resolve(ROOT, 'bench/detection-corpus-v1.manifest.json'), 'utf8'));
const frozen = verifyCorpus(corpusBytes, corpus, manifest);
const selected = selectCases(corpus, options);
runCleanBuild();
const executableDigest = builtClosureDigest();
const sensor = await import(pathToFileURL(path.resolve(ROOT, 'dist/index.js')).href);
const lifecycle = await import(pathToFileURL(path.resolve(ROOT, 'dist/detection-benchmark.js')).href);
lifecycle.assertBenchmarkSourceBinding(ROOT, source.sourceSha, source.relevant);
const publication = lifecycle.createBenchmarkPublication(ROOT, options.out);
let published = false;
try {
  const browser = await chromium.launch();
  const results = [];
  const seen = new Set();
  let browserBinding;
  try {
    browserBinding = { name: browser.browserType().name(), version: browser.version() };
    for (const benchmarkCase of selected) {
      if (seen.has(benchmarkCase.id)) {
        results.push({
          id: benchmarkCase.id,
          class: benchmarkCase.class,
          outcome: 'duplicate',
          findingCount: 0,
          findings: [],
          screenshots: [],
        });
        continue;
      }
      seen.add(benchmarkCase.id);
      if (!lifecycle.isSafeBenchmarkCaseId(benchmarkCase.id)) {
        results.push({
          id: String(benchmarkCase.id),
          class: benchmarkCase.class,
          outcome: 'invalid',
          findingCount: 0,
          findings: [],
          screenshots: [],
          reason: 'unsafe benchmark case ID',
        });
        continue;
      }
      try {
        results.push(await executeCase(browser, benchmarkCase, publication.stagingDirectory, sensor, lifecycle));
      } catch (error) {
        results.push({
          id: benchmarkCase.id,
          class: benchmarkCase.class,
          outcome: 'invalid',
          findingCount: 0,
          findings: [],
          screenshots: [],
          reason: String(error?.message ?? error),
        });
      }
    }
  } finally {
    await browser.close();
  }
  const receipt = {
    schemaVersion: 1,
    benchmark: 'styleproof-detection-rate',
    scope: { kind: options.scope, issue: 447, full447: false },
    bindings: {
      sourceSha: source.sourceSha,
      packageVersion: JSON.parse(fs.readFileSync(path.resolve(ROOT, 'package.json'), 'utf8')).version,
      browser: browserBinding,
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
        contractVersion: 2,
        digest: executableDigest,
        sourceDigest: source.sourceDigest,
        buildCommand: 'npm run clean && npm run build',
      },
      corpus: {
        id: corpus.corpusId,
        version: corpus.corpusVersion,
        digest: frozen.corpusDigest,
        expectationDigest: frozen.expectationDigest,
        reviewDigest: frozen.reviewDigest,
        cardinality: corpus.cases.length,
        manifest: 'bench/detection-corpus-v1.manifest.json',
      },
    },
    counts: countOutcomes(results, selected.length),
    cases: results,
    full447: { status: 'not-run', claimed: false },
  };
  const expectation = {
    sourceSha: source.sourceSha,
    corpusId: corpus.corpusId,
    corpusVersion: corpus.corpusVersion,
    corpusDigest: frozen.corpusDigest,
    expectationDigest: frozen.expectationDigest,
    reviewDigest: frozen.reviewDigest,
    corpusCardinality: corpus.cases.length,
    scopeKind: options.scope,
    requestedCardinality: selected.length,
    sensorDigest: executableDigest,
    sensorSourceDigest: source.sourceDigest,
    artifactRoot: publication.stagingDirectory,
    cases: expectedCases(selected),
  };
  const validation = lifecycle.validateDetectionBenchmarkReceipt(receipt, expectation);
  if (!validation.ok) throw new Error(`generated receipt failed closed: ${validation.reasons.join('; ')}`);
  const finalReceipt = { ...receipt, validation };
  fs.writeFileSync(
    path.join(publication.stagingDirectory, 'receipt.json'),
    `${JSON.stringify(finalReceipt, null, 2)}\n`,
    { flag: 'wx' },
  );
  fs.writeFileSync(path.join(publication.stagingDirectory, 'README.md'), markdown(finalReceipt), { flag: 'wx' });
  lifecycle.publishBenchmark(publication);
  published = true;
  process.stdout.write(
    `${JSON.stringify({ outputDirectory: publication.finalDirectory, counts: receipt.counts, validation }, null, 2)}\n`,
  );
} finally {
  if (!published) lifecycle.discardBenchmark(publication);
}
