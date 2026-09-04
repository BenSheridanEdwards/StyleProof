import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COVERAGE_LEDGER } from '../dist/coverage.js';
import { makeMap, mkTmp, rmTmp, writeCapture } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIFF = path.join(ROOT, 'bin/styleproof-diff.mjs');
const REPORT = path.join(ROOT, 'bin/styleproof-report.mjs');
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);

function stampManifest(dir, sha) {
  fs.writeFileSync(
    path.join(dir, 'styleproof-manifest.json'),
    JSON.stringify({
      version: 1,
      packageVersion: 'test',
      sha,
      dirty: false,
      spec: 'e2e/styleproof.spec.ts',
      specHash: '1'.repeat(64),
      platform: process.platform,
      arch: process.arch,
      nodeMajor: process.versions.node.split('.')[0],
      screenshots: true,
      har: false,
      compatibilityKey: '0000000000000000',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  fs.writeFileSync(
    path.join(dir, COVERAGE_LEDGER),
    JSON.stringify({ version: 1, expected: ['home'], exclude: {}, determinism: 'self-checked' }),
  );
}

function fixture({ beforeState, afterState, beforeColor = 'black', afterColor = beforeColor }) {
  const root = mkTmp('styleproof-product-state-cli-');
  const before = path.join(root, 'before');
  const after = path.join(root, 'after');
  const map = (color, productState) => ({
    ...makeMap({
      elements: {
        'body > button:nth-child(1)': { tag: 'button', style: { color } },
      },
    }),
    ...(productState === undefined ? {} : { metadata: { productState } }),
  });
  writeCapture(before, 'home@1280', map(beforeColor, beforeState), null);
  writeCapture(after, 'home@1280', map(afterColor, afterState), null);
  stampManifest(before, BASE_SHA);
  stampManifest(after, HEAD_SHA);
  return { root, before, after };
}

function runDiff(fixture, extra = []) {
  const json = path.join(fixture.root, `diff-${extra.length}.json`);
  const result = spawnSync(
    process.execPath,
    [
      DIFF,
      fixture.before,
      fixture.after,
      '--json',
      json,
      '--expected-before-sha',
      BASE_SHA,
      '--expected-after-sha',
      HEAD_SHA,
      ...extra,
    ],
    { cwd: fixture.root, encoding: 'utf8' },
  );
  return { ...result, json: JSON.parse(fs.readFileSync(json, 'utf8')) };
}

function runDiffRaw(fixture, extra = []) {
  return spawnSync(process.execPath, [DIFF, fixture.before, fixture.after, ...extra], {
    cwd: fixture.root,
    encoding: 'utf8',
  });
}

test('diff CLI labels an unbound clean comparison as diagnostic rather than certified success', () => {
  const capture = fixture({});
  try {
    const result = runDiffRaw(capture);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /UNVERIFIED DIAGNOSTIC/i);
    assert.doesNotMatch(result.stdout, /✓ 0 reviewable computed-style changes/);
  } finally {
    rmTmp(capture.root);
  }
});

test('report CLI labels unbound clean output and durable markdown as unverified diagnostics', () => {
  const capture = fixture({});
  try {
    const out = path.join(capture.root, 'report-unverified');
    const result = spawnSync(process.execPath, [REPORT, capture.before, capture.after, '--out', out], {
      cwd: capture.root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stdout, /UNVERIFIED DIAGNOSTIC/i);
    assert.doesNotMatch(result.stdout, /✓ no reviewable/i);
    const markdown = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
    assert.match(markdown, /UNVERIFIED DIAGNOSTIC/i);
    assert.doesNotMatch(markdown, /✓ No reviewable computed-style changes/);
  } finally {
    rmTmp(capture.root);
  }
});

test('diff CLI binds capture manifests to explicit trusted source SHAs before diffing', () => {
  const capture = fixture({});
  try {
    const matching = runDiffRaw(capture, ['--expected-before-sha', BASE_SHA, '--expected-after-sha', HEAD_SHA]);
    assert.equal(matching.status, 0, matching.stderr || matching.stdout);

    const stale = runDiffRaw(capture, ['--expected-before-sha', BASE_SHA, '--expected-after-sha', 'c'.repeat(40)]);
    assert.equal(stale.status, 2, stale.stderr || stale.stdout);
    assert.match(stale.stderr, /after capture source does not match the trusted SHA/i);

    for (const partial of [
      ['--expected-before-sha', BASE_SHA],
      ['--expected-after-sha', HEAD_SHA],
    ]) {
      const result = runDiffRaw(capture, partial);
      assert.equal(result.status, 2, result.stderr || result.stdout);
      assert.match(result.stderr, /must be supplied together/i);
    }
  } finally {
    rmTmp(capture.root);
  }
});

test('diff and report independently emit the same canonical source-binding receipt', () => {
  const capture = fixture({});
  const out = path.join(capture.root, 'report');
  try {
    const diff = runDiff(capture);
    assert.equal(diff.status, 0, diff.stderr || diff.stdout);
    assert.deepEqual(diff.json.sourceBinding, {
      status: 'bound',
      compatibility: 'matched',
      before: { expected: BASE_SHA, observed: BASE_SHA, result: 'matched' },
      after: { expected: HEAD_SHA, observed: HEAD_SHA, result: 'matched' },
    });
    assert.equal(diff.json.evidenceBinding.version, 1);
    assert.equal(diff.json.evidenceBinding.before.mapCount, 1);
    assert.equal(diff.json.evidenceBinding.after.mapCount, 1);
    assert.match(diff.json.evidenceBinding.before.digest, /^[0-9a-f]{64}$/);

    const reportArgs = [
      REPORT,
      capture.before,
      capture.after,
      '--out',
      out,
      '--expected-before-sha',
      BASE_SHA,
      '--expected-after-sha',
      HEAD_SHA,
    ];
    const report = spawnSync(process.execPath, reportArgs, { cwd: capture.root, encoding: 'utf8' });
    // #475: a fully bound, clean compare is green in BOTH tools. Until the
    // release-confidence layer was deleted, styleproof-diff exited 0 here while
    // styleproof-report exited 1 on the same two directories.
    assert.equal(report.status, 0, report.stderr || report.stdout);
    assert.match(report.stdout, /✓ no reviewable computed-style changes/);
    const reportJson = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
    assert.deepEqual(reportJson.sourceBinding, diff.json.sourceBinding);
    assert.deepEqual(reportJson.evidenceBinding, diff.json.evidenceBinding);

    writeCapture(
      capture.after,
      'home@1280',
      makeMap({ elements: { 'body > button:nth-child(1)': { tag: 'button', style: { color: 'blue' } } } }),
      null,
    );
    const swappedMapOut = path.join(capture.root, 'swapped-map-report');
    const swappedMap = spawnSync(
      process.execPath,
      reportArgs.map((argument) => (argument === out ? swappedMapOut : argument)),
      { cwd: capture.root, encoding: 'utf8' },
    );
    assert.equal(swappedMap.status, 1, swappedMap.stderr || swappedMap.stdout);
    const swappedMapJson = JSON.parse(fs.readFileSync(path.join(swappedMapOut, 'report.json'), 'utf8'));
    assert.notDeepEqual(swappedMapJson.evidenceBinding, diff.json.evidenceBinding);

    for (const partial of [
      ['--expected-before-sha', BASE_SHA],
      ['--expected-after-sha', HEAD_SHA],
      ['--expected-before-sha='],
      ['--expected-after-sha='],
    ]) {
      const partialReport = spawnSync(
        process.execPath,
        [REPORT, capture.before, capture.after, '--out', path.join(capture.root, 'partial-report'), ...partial],
        { cwd: capture.root, encoding: 'utf8' },
      );
      assert.equal(partialReport.status, 2, partialReport.stderr || partialReport.stdout);
      assert.match(partialReport.stderr, /must be supplied together|requires a full lowercase/i);
    }

    stampManifest(capture.after, 'c'.repeat(40));
    const swapped = spawnSync(process.execPath, reportArgs, { cwd: capture.root, encoding: 'utf8' });
    assert.equal(swapped.status, 2, swapped.stderr || swapped.stdout);
    assert.match(swapped.stderr, /after capture source does not match the trusted SHA/i);
  } finally {
    rmTmp(capture.root);
  }
});

test('diff CLI fails closed on malformed manifests and mismatched compatibility contracts', () => {
  const malformed = fixture({});
  try {
    fs.writeFileSync(path.join(malformed.after, 'styleproof-manifest.json'), '{}');
    const result = runDiffRaw(malformed);
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(result.stderr, /invalid styleproof-manifest\.json/i);
  } finally {
    rmTmp(malformed.root);
  }

  const incompatible = fixture({});
  try {
    const afterManifestPath = path.join(incompatible.after, 'styleproof-manifest.json');
    const afterManifest = JSON.parse(fs.readFileSync(afterManifestPath, 'utf8'));
    afterManifest.compatibilityKey = '1111111111111111';
    fs.writeFileSync(afterManifestPath, JSON.stringify(afterManifest));
    const result = runDiffRaw(incompatible);
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(result.stderr, /different capture compatibility/i);
  } finally {
    rmTmp(incompatible.root);
  }
});

test('diff CLI certifies matching explicit identity and emits bounded comparison receipts', () => {
  const state = { id: 'home-ready', revision: 'fixture-v2' };
  const capture = fixture({ beforeState: state, afterState: state });
  const result = runDiff(capture, ['--require-state-identity']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(result.json.comparison, {
    status: 'comparable',
    requireStateIdentity: true,
    blocksCertification: false,
    counts: {
      comparable: 1,
      incomparable: 0,
      unproven: 0,
      notRequired: 0,
      requiredUnproven: 0,
      globalRequiredUnproven: 0,
    },
  });
  assert.deepEqual(result.json.comparability, [
    { surface: 'home@1280', status: 'comparable', required: true, reason: 'explicit-state-match' },
  ]);
  assert.equal(result.json.certifiesFully, true);
  rmTmp(capture.root);
});

test('diff CLI keeps undeclared legacy pairs compatible unless state identity is required', () => {
  const capture = fixture({});
  const legacy = runDiff(capture);
  assert.equal(legacy.status, 0, legacy.stderr || legacy.stdout);
  assert.equal(legacy.json.comparison.status, 'unproven');
  assert.equal(legacy.json.comparison.blocksCertification, false);
  assert.equal(legacy.json.certifiesFully, true);

  const strict = runDiff(capture, ['--require-state-identity']);
  assert.equal(strict.status, 1, strict.stderr || strict.stdout);
  assert.equal(strict.json.comparison.status, 'unproven');
  assert.equal(strict.json.comparison.blocksCertification, true);
  assert.equal(strict.json.comparison.counts.globalRequiredUnproven, 1);
  assert.equal(strict.json.certifiesFully, false);
  assert.match(strict.stdout, /product-state identity unproven|state identity unproven/i);
  rmTmp(capture.root);
});

test('diff CLI makes explicit mismatch non-certifying and never prints it as approval evidence', () => {
  const capture = fixture({
    beforeState: { id: 'home-loading', revision: 'fixture-v2' },
    afterState: { id: 'home-ready', revision: 'fixture-v2' },
    beforeColor: 'black',
    afterColor: 'red',
  });
  const result = runDiff(capture);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.json.counts.style, 1, 'raw detector evidence remains diagnostic');
  assert.equal(result.json.reviewableCounts.style, 0);
  assert.equal(result.json.comparison.status, 'incomparable');
  assert.equal(result.json.comparison.blocksCertification, true);
  assert.equal(result.json.certifiesFully, false);
  assert.match(result.stdout, /incomparable|different declared product states/i);
  assert.doesNotMatch(result.stdout, /body > button/, 'suppressed raw findings must not look approvable');
  rmTmp(capture.root);
});

test('diff CLI makes asymmetric identity required-unproven even without the global flag', () => {
  const capture = fixture({ afterState: { id: 'home-ready', revision: 'fixture-v2' }, afterColor: 'red' });
  const result = runDiff(capture);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.json.comparison.counts.requiredUnproven, 1);
  assert.equal(result.json.reviewableCounts.style, 0);
  assert.equal(result.json.certifiesFully, false);
  rmTmp(capture.root);
});

test('missing consumer-declared state × surface evidence blocks clean diff and report verdicts', () => {
  const capture = fixture({});
  const declaration = {
    surface: 'home',
    productState: { id: 'client:jake:hunter', revision: 'fleet-fixture-v1' },
    owner: 'hud',
    reason: 'Hunter must be visible before the roster is certified.',
  };
  fs.writeFileSync(
    path.join(capture.root, 'styleproof.config.json'),
    JSON.stringify({ requiredStateComparisons: [declaration] }),
  );
  const out = path.join(capture.root, 'required-report');
  try {
    const diff = runDiff(capture);
    assert.equal(diff.status, 1, diff.stderr || diff.stdout);
    assert.equal(diff.json.requiredStateComparisons.blocksCertification, true);
    assert.deepEqual(diff.json.requiredStateComparisons.receipts[0].failures, ['surface-metadata-missing']);
    assert.doesNotMatch(diff.stdout, /✓ 0 reviewable computed-style changes/);

    const report = spawnSync(
      process.execPath,
      [
        REPORT,
        capture.before,
        capture.after,
        '--out',
        out,
        '--expected-before-sha',
        BASE_SHA,
        '--expected-after-sha',
        HEAD_SHA,
      ],
      { cwd: capture.root, encoding: 'utf8' },
    );
    assert.equal(report.status, 1, report.stderr || report.stdout);
    assert.match(report.stdout, /required state comparisons incomplete/i);
    assert.doesNotMatch(report.stdout, /✓ no reviewable/i);
    const reportJson = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
    assert.deepEqual(reportJson.requiredStateComparisons, diff.json.requiredStateComparisons);
    const markdown = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
    assert.match(markdown, /Required state comparisons incomplete/);
    assert.match(markdown, /approval cannot clear this/i);
    assert.match(markdown, /base\/head evidence is missing required surface metadata/i);
  } finally {
    rmTmp(capture.root);
  }
});

test('duplicate JSON and gzip artifacts for one logical capture key fail closed', () => {
  const required = { id: 'ready', revision: 'v1' };
  const capture = fixture({ beforeState: required, afterState: required });
  try {
    for (const dir of [capture.before, capture.after]) {
      fs.writeFileSync(
        path.join(dir, 'home@1280.json'),
        JSON.stringify(makeMap({ metadata: { surfaceKey: 'home', productState: { id: 'other', revision: 'v1' } } })),
      );
    }
    fs.writeFileSync(
      path.join(capture.root, 'styleproof.config.json'),
      JSON.stringify({
        requiredStateComparisons: [{ surface: 'home', productState: required, owner: 'ui', reason: 'required' }],
      }),
    );
    const result = runDiffRaw(capture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /duplicate map artifacts/);
  } finally {
    rmTmp(capture.root);
  }
});

test('public report API loads checked-in required-state policy when the caller supplies no policy argument', () => {
  const capture = fixture({});
  const report = path.join(capture.root, 'report-api');
  try {
    fs.writeFileSync(
      path.join(capture.root, 'styleproof.config.json'),
      JSON.stringify({
        requiredStateComparisons: [
          {
            surface: 'home',
            productState: { id: 'client:jake:hunter', revision: 'fleet-fixture-v1' },
            owner: 'fleet-hud',
            reason: 'Hunter must be visible',
          },
        ],
      }),
    );
    const script = `import { generateStyleMapReport } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'dist/report.js')).href)};
const result = generateStyleMapReport({ beforeDir: ${JSON.stringify(capture.before)}, afterDir: ${JSON.stringify(capture.after)}, outDir: ${JSON.stringify(report)} });
console.log(JSON.stringify(result.requiredStateComparisons));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: capture.root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.blocksCertification, true);
    assert.equal(receipt.status, 'unsatisfied');
    assert.doesNotMatch(
      fs.readFileSync(path.join(report, 'report.md'), 'utf8'),
      /No reviewable computed-style changes/,
    );
  } finally {
    rmTmp(capture.root);
  }
});

test('public report API audits caller-supplied required-state policy instead of silently ignoring it', () => {
  const capture = fixture({});
  const report = path.join(capture.root, 'report-api-explicit');
  const declarations = [
    {
      surface: 'home',
      productState: { id: 'client:jake:hunter', revision: 'fleet-fixture-v1' },
      owner: 'fleet-hud',
      reason: 'Hunter must be visible',
    },
  ];
  try {
    const script = `import { generateStyleMapReport } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'dist/report.js')).href)};
const result = generateStyleMapReport({ beforeDir: ${JSON.stringify(capture.before)}, afterDir: ${JSON.stringify(capture.after)}, outDir: ${JSON.stringify(report)}, requiredStateComparisons: ${JSON.stringify(declarations)} });
console.log(JSON.stringify(result.requiredStateComparisons));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: capture.root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.blocksCertification, true);
    assert.equal(receipt.status, 'unsatisfied');
    assert.deepEqual(receipt.counts, { declared: 1, satisfied: 0, unsatisfied: 1 });
    assert.doesNotMatch(
      fs.readFileSync(path.join(report, 'report.md'), 'utf8'),
      /No reviewable computed-style changes/,
    );
  } finally {
    rmTmp(capture.root);
  }
});

test('public report API rejects sparse supplied policy before creating output', () => {
  const capture = fixture({});
  const report = path.join(capture.root, 'report-api-sparse');
  try {
    const script = `import { generateStyleMapReport } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'dist/report.js')).href)};
const policy = new Array(1);
generateStyleMapReport({ beforeDir: ${JSON.stringify(capture.before)}, afterDir: ${JSON.stringify(capture.after)}, outDir: ${JSON.stringify(report)}, requiredStateComparisons: policy });`;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: capture.root,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /arrays must be dense/);
    assert.equal(fs.existsSync(report), false);
  } finally {
    rmTmp(capture.root);
  }
});

test('diff and report require and honor explicit package policy when invoked from a monorepo root', () => {
  const capture = fixture({});
  const workspace = mkTmp('styleproof-monorepo-');
  const packageRoot = path.join(workspace, 'packages', 'app');
  fs.mkdirSync(path.dirname(packageRoot), { recursive: true });
  fs.renameSync(capture.root, packageRoot);
  capture.root = packageRoot;
  capture.before = path.join(packageRoot, 'before');
  capture.after = path.join(packageRoot, 'after');
  const declaration = {
    surface: 'home',
    productState: { id: 'client:jake:hunter', revision: 'fleet-fixture-v1' },
    owner: 'fleet-hud',
    reason: 'Hunter must be visible before roster certification.',
  };
  fs.writeFileSync(
    path.join(packageRoot, 'styleproof.config.json'),
    JSON.stringify({ requiredStateComparisons: [declaration] }),
  );
  const json = path.join(workspace, 'diff.json');
  const out = path.join(workspace, 'report');
  try {
    const implicit = spawnSync(process.execPath, [DIFF, capture.before, capture.after], {
      cwd: workspace,
      encoding: 'utf8',
    });
    assert.equal(implicit.status, 2);
    assert.match(implicit.stderr, /requires an explicit --config-root/);
    assert.doesNotMatch(implicit.stdout, /✓|certifiesFully/);

    const diff = spawnSync(
      process.execPath,
      [
        DIFF,
        capture.before,
        capture.after,
        '--config-root',
        packageRoot,
        '--json',
        json,
        '--expected-before-sha',
        BASE_SHA,
        '--expected-after-sha',
        HEAD_SHA,
      ],
      { cwd: workspace, encoding: 'utf8' },
    );
    assert.equal(diff.status, 1, diff.stderr || diff.stdout);
    assert.equal(JSON.parse(fs.readFileSync(json, 'utf8')).requiredStateComparisons.blocksCertification, true);
    const report = spawnSync(
      process.execPath,
      [
        REPORT,
        capture.before,
        capture.after,
        '--config-root',
        packageRoot,
        '--out',
        out,
        '--expected-before-sha',
        BASE_SHA,
        '--expected-after-sha',
        HEAD_SHA,
      ],
      { cwd: workspace, encoding: 'utf8' },
    );
    assert.equal(report.status, 1, report.stderr || report.stdout);
    assert.match(report.stdout, /required state comparisons incomplete/i);
    assert.doesNotMatch(report.stdout, /✓ no reviewable/i);
  } finally {
    rmTmp(workspace);
  }
});

test('an explicitly missing config root is a usage error, never empty policy', () => {
  const root = mkTmp('styleproof-missing-config-root-');
  const capture = fixture({
    beforeState: { name: 'ready', revision: 'v1' },
    afterState: { name: 'ready', revision: 'v1' },
  });
  const missingRoot = path.join(root, 'packages', 'missing');

  for (const [bin, extra] of [
    [DIFF, ['--json']],
    [REPORT, ['--out', path.join(root, 'report')]],
  ]) {
    const result = spawnSync(
      process.execPath,
      [bin, capture.before, capture.after, '--config-root', missingRoot, ...extra],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 2, `${bin}: ${result.stdout} ${result.stderr}`);
    assert.match(result.stderr, /explicit config root has no styleproof\.config\.json/i);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /certifiesFully|no reviewable computed-style changes/i);
  }
});
