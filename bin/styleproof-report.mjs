#!/usr/bin/env node
// Visual diff report: side-by-side before/after crops of every changed region plus
// the exact property changes, as markdown ready for a PR comment.
// Exit 0 = no changes, 1 = report generated, 2 = usage error.
import fs from 'node:fs';
import { generateStyleMapReport } from '../dist/report.js';
import { defineCli, number } from './cli.mjs';
import { compareFlags, coverageExclusions, resolveCompareInputs, withCaptureDirs } from './compare.mjs';

const NAME = 'styleproof-report';
const cli = defineCli({
  name: NAME,
  alias: 'report',
  usage: [`${NAME} [baseRef] [options]`, `${NAME} <beforeDir> <afterDir> [options]`],
  positionals: true,
  flags: {
    ...compareFlags(),
    out: { value: 'dir', help: 'output directory', default: 'styleproof-report' },
    'image-base-url': { value: 'url', help: 'prefix for image URLs in report.md (default: relative)' },
    pad: { value: 'px', help: 'padding around changed rects when cropping (default: 12)' },
    'max-crops': { value: 'n', help: 'max crop regions per surface before collapsing (default: 8)' },
    'fold-details-at': {
      value: 'n',
      help: "row count at which a crop's property tables fold under a <details> toggle (default: 0 = always; 'Infinity' = never)",
    },
    'min-width': { value: 'px', help: 'minimum crop width, for context (default: 320)' },
    'min-height': { value: 'px', help: 'minimum crop height, for context (default: 180)' },
    'include-layout-noise': {
      help: 'keep size/position-derived longhands (height, width, transform-origin, top…) that a reflow changes up the whole ancestor chain',
    },
    'include-content': {
      help: 'render the opt-in content layer: an advisory section of elements whose text changed, each with a before/after crop. Needs captures taken with captureText:true; never affects the check',
    },
  },
  notes: ['exit: 0 no changes, 1 report generated, 2 usage error.'],
});

const { opts, args } = cli.parse();
const inputs = resolveCompareInputs(NAME, {
  opts,
  args,
  purpose: 'report',
  usage: `usage: ${NAME} [baseRef] [--out <dir>] [options]`,
});
const foldDetailsAt = opts['fold-details-at'] === undefined ? undefined : Number(opts['fold-details-at']);
if (Number.isNaN(foldDetailsAt)) {
  console.error('--fold-details-at must be a number (or Infinity)');
  process.exit(2);
}
const numeric = (flag) => number(NAME, flag, opts[flag]);
const migration = Boolean(opts.migration);
const includeContent = Boolean(opts['include-content']);

const { result, sourceBinding, evidenceBinding } = withCaptureDirs(NAME, inputs, () => ({
  result: generateStyleMapReport({
    beforeDir: inputs.beforeDir,
    afterDir: inputs.afterDir,
    outDir: opts.out,
    imageBaseUrl: opts['image-base-url'] || undefined,
    pad: numeric('pad'),
    maxCrops: numeric('max-crops'),
    foldDetailsAt,
    minWidth: numeric('min-width'),
    minHeight: numeric('min-height'),
    includeLayoutNoise: Boolean(opts['include-layout-noise']),
    includeContent,
    requireStateIdentity: inputs.requireStateIdentity,
    migration,
    legacyPairDeclarations: inputs.legacyPairDeclarations,
    legacyPairsArmed: inputs.legacyPairsArmed,
    criticalObligations: inputs.criticalObligations,
    criticalStatesArmed: inputs.criticalStatesArmed,
    coverageExclusions: inputs.criticalStatesArmed ? Object.keys(coverageExclusions(inputs.afterDir)) : [],
  }),
}));

const reportJson = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));
fs.writeFileSync(
  result.reportJsonPath,
  `${JSON.stringify({ ...reportJson, ...(migration ? { migration: true } : {}), sourceBinding, evidenceBinding }, null, 2)}\n`,
);
// An unverified source binding is a diagnostic, never a certification.
const sourceBindingFailed = sourceBinding.status !== 'bound';
if (sourceBindingFailed) {
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

const consistencyFailed = result.reportConsistency?.ok === false;
const { changedSurfaces, oneSidedSurfaces, newSurfaces, totalFindings, contentChanges } = result;

function summaryLine() {
  if (changedSurfaces > 0) {
    const newNote = newSurfaces ? ` (+${newSurfaces} new surface(s) with no baseline)` : '';
    return `✗ ${changedSurfaces} changed surface(s), ${totalFindings} finding(s)${newNote}`;
  }
  if (oneSidedSurfaces > 0) {
    return newSurfaces > 0
      ? `ℹ ${newSurfaces} new surface(s) with no baseline — report written for review`
      : `⚠ ${oneSidedSurfaces} removed or baseline-repair-debt surface(s) — report written for review`;
  }
  if (consistencyFailed) return '⚠ no presentation changes — report consistency failure written';
  const prefix = sourceBindingFailed ? '⚠ UNVERIFIED DIAGNOSTIC:' : '✓';
  if (!includeContent) return `${prefix} no reviewable computed-style changes — content/structure not evaluated`;
  if (contentChanges > 0) {
    return `${prefix} no reviewable computed-style changes — ${contentChanges} advisory content/structure change(s) written`;
  }
  return `${prefix} no reviewable computed-style or advisory content/structure changes`;
}

if (consistencyFailed) {
  console.log(`⚠ report consistency: ${result.reportConsistency.reason} — not a clean no-change (fail closed)`);
}
console.log(summaryLine());
console.log(`report: ${result.reportMdPath}`);
if (includeContent && contentChanges > 0) {
  console.log(`📝 ${contentChanges} advisory content change(s) — does not affect the exit code`);
}

// Exit 1 when there is anything to review or any evidence that cannot certify.
const armedFailure = (audit, keys) => Boolean(audit?.armed) && keys.some((key) => (audit[key]?.length ?? 0) > 0);
const clean =
  changedSurfaces === 0 &&
  oneSidedSurfaces === 0 &&
  !consistencyFailed &&
  result.comparison?.blocksCertification !== true &&
  !armedFailure(result.legacyPairs, ['undeclared', 'staleAcknowledgements']) &&
  !armedFailure(result.criticalStates, ['failing', 'unresolved', 'contradictory']) &&
  !sourceBindingFailed;
process.exit(clean ? 0 : 1);
