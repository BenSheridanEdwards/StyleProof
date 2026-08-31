#!/usr/bin/env node
/**
 * Visual diff report: side-by-side before/after crops of every changed
 * region, plus the exact property changes, as markdown ready for a PR
 * comment.
 *
 *   styleproof-report [baseRef] --out <dir> [options]   # cached map store
 *   styleproof-report <beforeDir> <afterDir> --out <dir> [options]
 *
 * Both capture dirs need the .json.gz maps; side-by-side images additionally
 * need the .png screenshots that `defineStyleMapCapture` saves by default.
 * Exit code 0 = no changes, 1 = report generated, 2 = usage error.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateStyleMapReport } from '../dist/report.js';
import { importMapBundleToEvidenceStore } from '../dist/evidence-import.js';
import { serializeReleaseConfidenceManifest } from '../dist/release-confidence-manifest.js';
import { projectReleaseConfidence } from '../dist/release-confidence-project.js';
import { cachedMapsUnavailableMessage, isHelpArg, showHelpAndExit, unknownFlagMessage } from '../dist/cli-errors.js';
import { captureSourceDefaults, consumeCaptureSourceOption } from '../dist/cli-capture-source.js';
import {
  DEFAULT_MAP_STORE_BRANCH,
  DEFAULT_REMOTE,
  assertCompatibleMapDirs,
  captureEvidenceBindingReceipt,
  expectedSourceShaFlagsError,
  cleanupCachedCaptureDirs,
  manifestlessError,
  manifestlessSide,
  readMapManifest,
  resolveCachedCaptureDirs,
} from '../dist/map-store.js';

const COMMAND = 'styleproof-report';

const HELP = `${COMMAND} — reviewable before/after report from two captures

usage: ${COMMAND} [baseRef] [options]
       ${COMMAND} <beforeDir> <afterDir> [options]

options:
  --spec <path>              StyleProof spec used to select compatible cached maps
                             (default: e2e/styleproof.spec.ts)
  --cache-branch <b>         map store branch for default cached-map mode
                             (default: ${DEFAULT_MAP_STORE_BRANCH})
  --remote <name>            git remote for the map store (default: ${DEFAULT_REMOTE})
  --out <dir>               output directory (default: styleproof-report)
  --image-base-url <url>    prefix for image URLs in report.md (default: relative)
  --pad <px>                padding around changed rects when cropping (default: 12)
  --max-crops <n>           max crop regions per surface before collapsing (default: 8)
  --fold-details-at <n>     row count at which a crop's property tables fold under a
                            <details> toggle (default: 0 = always; 'Infinity' = never)
  --min-width <px>          minimum crop width, for context (default: 320)
  --min-height <px>         minimum crop height, for context (default: 180)
  --include-layout-noise    keep size/position-derived longhands (height, width,
                            transform-origin, top…) that a reflow changes up the
                            whole ancestor chain (off by default)
  --include-content         render the opt-in content layer: an advisory section
                            of elements whose text changed, each with a
                            before/after crop. Needs captures taken with
                            captureText:true; never affects the check (off by default)
  --require-state-identity require explicit matching product-state identity for every paired surface
  --expected-before-sha <sha> trusted full base commit SHA; must be paired with --expected-after-sha
  --expected-after-sha <sha>  trusted full head commit SHA; must be paired with --expected-before-sha
  -h, --help                show this help

exit: 0 no changes, 1 report generated, 2 usage error.
`;

const argv = process.argv.slice(2);
const args = [];
const flags = { out: 'styleproof-report', imageBaseUrl: '' };
let pad;
let maxCrops;
let foldDetailsAt;
let minWidth;
let minHeight;
let includeLayoutNoise = false;
let includeContent = false;
let requireStateIdentity = false;
let expectedBeforeSha;
let expectedAfterSha;
let expectedBeforeShaSet = false;
let expectedAfterShaSet = false;
// Repo config is the lowest-precedence default layer (flag > env > file > built-in),
// matching every other CLI — see the identical block in styleproof-diff.
const captureSource = captureSourceDefaults(COMMAND);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const captureSourceIndex = consumeCaptureSourceOption(argv, i, captureSource);
  if (captureSourceIndex !== undefined) {
    i = captureSourceIndex;
    continue;
  }
  if (isHelpArg(a)) showHelpAndExit(HELP);
  else if (a === '--out') flags.out = argv[++i];
  else if (a.startsWith('--out=')) flags.out = a.slice(6);
  else if (a === '--image-base-url') flags.imageBaseUrl = argv[++i];
  else if (a.startsWith('--image-base-url=')) flags.imageBaseUrl = a.slice(17);
  else if (a === '--pad') pad = Number(argv[++i]);
  else if (a.startsWith('--pad=')) pad = Number(a.slice(6));
  else if (a === '--max-crops') maxCrops = Number(argv[++i]);
  else if (a.startsWith('--max-crops=')) maxCrops = Number(a.slice(12));
  else if (a === '--fold-details-at') foldDetailsAt = Number(argv[++i]);
  else if (a.startsWith('--fold-details-at=')) foldDetailsAt = Number(a.slice(18));
  else if (a === '--min-width') minWidth = Number(argv[++i]);
  else if (a.startsWith('--min-width=')) minWidth = Number(a.slice(12));
  else if (a === '--min-height') minHeight = Number(argv[++i]);
  else if (a.startsWith('--min-height=')) minHeight = Number(a.slice(13));
  else if (a === '--include-layout-noise') includeLayoutNoise = true;
  else if (a.startsWith('--include-layout-noise=')) includeLayoutNoise = a.slice(23) !== 'false';
  else if (a === '--include-content') includeContent = true;
  else if (a.startsWith('--include-content=')) includeContent = a.slice(18) !== 'false';
  else if (a === '--require-state-identity') requireStateIdentity = true;
  else if (a.startsWith('--require-state-identity=')) requireStateIdentity = a.slice(25) !== 'false';
  else if (a === '--expected-before-sha') {
    expectedBeforeShaSet = true;
    expectedBeforeSha = argv[++i];
  } else if (a.startsWith('--expected-before-sha=')) {
    expectedBeforeShaSet = true;
    expectedBeforeSha = a.slice(22);
  } else if (a === '--expected-after-sha') {
    expectedAfterShaSet = true;
    expectedAfterSha = argv[++i];
  } else if (a.startsWith('--expected-after-sha=')) {
    expectedAfterShaSet = true;
    expectedAfterSha = a.slice(21);
  } else if (a.startsWith('--')) {
    console.error(unknownFlagMessage(COMMAND, a));
    process.exit(2);
  } else args.push(a);
}
const sourceShaError = expectedSourceShaFlagsError({
  beforeProvided: expectedBeforeShaSet,
  beforeSha: expectedBeforeSha,
  afterProvided: expectedAfterShaSet,
  afterSha: expectedAfterSha,
});
if (sourceShaError) {
  console.error(`${COMMAND}: ${sourceShaError}`);
  process.exit(2);
}
let beforeDir;
let afterDir;
let cacheCapture = null;
if (args.length <= 1) {
  try {
    cacheCapture = resolveCachedCaptureDirs({
      command: COMMAND,
      args,
      spec: captureSource.spec,
      branch: captureSource.cacheBranch,
      remote: captureSource.remote,
      baseUrl: process.env.BASE_URL,
      usage: 'usage: styleproof-report [baseRef] [--out <dir>] [options]',
    });
    beforeDir = cacheCapture.beforeDir;
    afterDir = cacheCapture.afterDir;
  } catch (e) {
    console.error(cachedMapsUnavailableMessage(COMMAND, 'report', e));
    process.exit(2);
  }
} else {
  if (args.length !== 2) {
    console.error('usage: styleproof-report <beforeDir> <afterDir> --out <dir> [options]  (--help for all options)');
    process.exit(2);
  }
  beforeDir = args[0];
  afterDir = args[1];
}
for (const [name, val] of [
  ['--pad', pad],
  ['--max-crops', maxCrops],
  ['--min-width', minWidth],
  ['--min-height', minHeight],
]) {
  if (val !== undefined && !Number.isFinite(val)) {
    console.error(`${name} must be a number`);
    process.exit(2);
  }
}
// foldDetailsAt allows Infinity ("never fold"), so it gets a NaN-only check.
if (foldDetailsAt !== undefined && Number.isNaN(foldDetailsAt)) {
  console.error('--fold-details-at must be a number (or Infinity)');
  process.exit(2);
}

let result;
let sourceBinding;
let releaseConfidenceStoreRoot;
try {
  // v4: refuse a manifest-less side (exit 2 via the catch) — same-environment
  // compatibility can't be verified without a manifest on both sides.
  const manifestless = manifestlessSide(beforeDir, afterDir);
  if (manifestless) throw new Error(manifestlessError(manifestless));
  const initialEvidenceBinding = captureEvidenceBindingReceipt(beforeDir, afterDir);
  sourceBinding = assertCompatibleMapDirs(beforeDir, afterDir, {
    beforeSha: expectedBeforeSha,
    afterSha: expectedAfterSha,
  });
  let releaseConfidenceManifest;
  try {
    const afterManifest = readMapManifest(afterDir);
    if (!afterManifest) throw new Error('missing map manifest');
    releaseConfidenceStoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-report-confidence-'));
    const imported = importMapBundleToEvidenceStore({
      bundleDirectory: afterDir,
      storeRoot: releaseConfidenceStoreRoot,
    });
    releaseConfidenceManifest = projectReleaseConfidence({
      beforeDir,
      afterDir,
      manifestId: `rcm-${afterManifest.sha}`,
      producerVersion: afterManifest.packageVersion,
      releaseScope: 'styleproof-report',
      expectedBeforeSha,
      expectedAfterSha,
      evidence: { storeRoot: releaseConfidenceStoreRoot, capture: imported.capture },
    }).manifest;
  } catch {
    console.error('styleproof-report: release confidence projection failed');
  }
  result = generateStyleMapReport({
    beforeDir,
    afterDir,
    outDir: flags.out,
    imageBaseUrl: flags.imageBaseUrl || undefined,
    pad,
    maxCrops,
    foldDetailsAt,
    minWidth,
    minHeight,
    includeLayoutNoise,
    includeContent,
    requireStateIdentity,
    releaseConfidenceManifest,
  });
  if (releaseConfidenceManifest) {
    fs.writeFileSync(
      path.join(flags.out, 'styleproof-release-confidence.json'),
      serializeReleaseConfidenceManifest(releaseConfidenceManifest),
    );
  }
  const evidenceBinding = captureEvidenceBindingReceipt(beforeDir, afterDir);
  if (JSON.stringify(evidenceBinding) !== JSON.stringify(initialEvidenceBinding)) {
    throw new Error('capture evidence changed while styleproof-report was reading it');
  }
  const reportJson = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
  fs.writeFileSync(
    result.reportJsonPath,
    `${JSON.stringify({ ...reportJson, sourceBinding, evidenceBinding }, null, 2)}\n`,
  );
  if (sourceBinding.status !== 'bound') {
    const markdown = fs.readFileSync(result.reportMdPath, 'utf8');
    const relabeled = markdown.replace(
      /✓ No reviewable computed-style changes/g,
      '⚠ UNVERIFIED DIAGNOSTIC: No reviewable computed-style changes',
    );
    fs.writeFileSync(
      result.reportMdPath,
      relabeled === markdown ? `> ⚠ UNVERIFIED DIAGNOSTIC: source binding was not verified.\n\n${markdown}` : relabeled,
    );
  }
} catch (e) {
  console.error(e.message);
  process.exit(2);
} finally {
  if (releaseConfidenceStoreRoot) fs.rmSync(releaseConfidenceStoreRoot, { recursive: true, force: true });
  cleanupCachedCaptureDirs(cacheCapture);
}

const newNote = result.newSurfaces ? ` (+${result.newSurfaces} new surface(s) with no baseline)` : '';
const consistencyFailed = result.reportConsistency?.ok === false;
const comparisonFailed = result.comparison?.blocksCertification === true;
const releaseConfidenceFailed = result.releaseConfidence?.blocking !== false;
const cleanPrefix = sourceBinding.status === 'bound' ? '✓' : '⚠ UNVERIFIED DIAGNOSTIC:';
if (consistencyFailed) {
  console.log(`⚠ report consistency: ${result.reportConsistency.reason} — not a clean no-change (fail closed)`);
}
console.log(
  result.changedSurfaces === 0
    ? result.newSurfaces === 0
      ? consistencyFailed
        ? '⚠ no presentation changes — report consistency failure written'
        : includeContent
          ? result.contentChanges > 0
            ? `${cleanPrefix} no reviewable computed-style changes — ${result.contentChanges} advisory content/structure change(s) written`
            : `${cleanPrefix} no reviewable computed-style or advisory content/structure changes`
          : `${cleanPrefix} no reviewable computed-style changes — content/structure not evaluated`
      : `ℹ ${result.newSurfaces} new surface(s) with no baseline — report written for review`
    : `✗ ${result.changedSurfaces} changed surface(s), ${result.totalFindings} finding(s)${newNote}`,
);
console.log(`report: ${result.reportMdPath}`);
if (includeContent && result.contentChanges > 0) {
  console.log(`📝 ${result.contentChanges} advisory content change(s) — does not affect the exit code`);
}
// Exit 1 when there is anything to review OR any report-consistency failure (never
// exit 0 for "identical" when certification evidence was hidden by presentation).
process.exit(
  result.changedSurfaces === 0 &&
    result.newSurfaces === 0 &&
    !consistencyFailed &&
    !comparisonFailed &&
    !releaseConfidenceFailed
    ? 0
    : 1,
);
