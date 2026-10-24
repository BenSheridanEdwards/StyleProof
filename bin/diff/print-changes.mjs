// styleproof-diff human output, first half: baseline notes, product-state comparability,
// one-sided surfaces, and the changed surfaces grouped the way the report groups them.
import { findingLabel } from '../../dist/diff.js';
import {
  chromeSpanLabel,
  classifyChrome,
  cleanFindingsForDisplay,
  countCapturedSurfaceBases,
  countChangedSurfaceScope,
  derivedLonghandCount,
  formatSurfaceList,
  groupByPath,
  groupBySignature,
  groupTitle,
  summarizeProps,
} from '../../dist/change-groups.js';
import { plural, printSection } from './output.mjs';

export function printBaselineNotes({ baselineFailures, baselineAttribution, undeclaredOnBase }) {
  if (baselineFailures.length > 0) {
    printSection(`⚠ ${baselineFailures.length} baseline capture failure(s): ${baselineAttribution.summary}`, [
      '  Failure details remain in the local capture manifest and are not echoed from untrusted artifacts.',
    ]);
  }
  if (undeclaredOnBase.length) {
    printSection(
      `ℹ ${undeclaredOnBase.length} base capture attempt(s) not counted as baseline failures — the base commit never declared: ${undeclaredOnBase.join(', ')}`,
    );
  }
}

function comparabilityHeadline({ comparison, legacyPairAudit, declaredLegacyPairs }) {
  const c = comparison.counts;
  if (comparison.status === 'comparable')
    return `✓ product-state identity comparable on ${c.comparable} paired capture(s)`;
  if (comparison.status === 'not-required')
    return 'ℹ product-state comparison not required — no paired capture obligation';
  if (!comparison.blocksCertification) {
    return declaredLegacyPairs
      ? `⚠ product-state identity unproven on ${legacyPairAudit.declared.length} declared legacy pair(s) — ` +
          'on the record, advisory, not certified. Stamp productState {id, revision} to certify.'
      : `⚠ product-state identity unproven on ${c.unproven} legacy paired capture(s) — ` +
          'legacy compatibility mode keeps the existing verdict, but this is not proof of same product state. ' +
          'Pass --require-state-identity to make it non-certifying, or declare known pairs in styleproof.product-state.json.';
  }
  const reasons = [
    [c.incomparable, 'explicit mismatch(es)'],
    [c.requiredUnproven, 'required-unproven pair(s)'],
    [c.globalRequiredUnproven, 'globally-required legacy pair(s)'],
    [legacyPairAudit.armed ? legacyPairAudit.undeclared.length : 0, 'undeclared legacy pair(s)'],
  ]
    .filter(([n]) => n)
    .map(([n, what]) => `${n} ${what}`);
  return `✗ product-state identity ${comparison.status.toUpperCase()} — ${reasons.join(', ')}. Raw style deltas remain diagnostic only; they are not approval evidence.`;
}

function obligationLines({ legacyPairAudit, criticalAudit, criticalObligations }) {
  const lines = [];
  if (legacyPairAudit.armed) {
    for (const key of legacyPairAudit.undeclared)
      lines.push(
        `undeclared legacy pair: ${key} — stamp productState {id, revision}, or record it in styleproof.product-state.json {"<surface>":"<why>"}.`,
      );
    for (const key of legacyPairAudit.staleAcknowledgements)
      lines.push(`stale legacy-pair declaration: ${key} — prune it from styleproof.product-state.json`);
  }
  if (criticalAudit.armed) {
    const meta = (key) => {
      const record = criticalObligations[key];
      return `owner ${record?.owner ?? 'unknown'}: ${record?.reason ?? 'no reason recorded'}`;
    };
    for (const key of criticalAudit.failing)
      lines.push(
        `critical obligation ${key} is not certifying — ${meta(key)}. Stamp matching productState {id, revision} to certify.`,
      );
    for (const key of criticalAudit.unresolved)
      lines.push(
        `unresolved critical obligation ${key} — no paired surface evidence (lost capture, removed surface, or unknown ID). ${meta(key)}.`,
      );
    for (const key of criticalAudit.contradictory)
      lines.push(
        `contradictory critical obligation ${key} — declared critical and coverage-excluded. A state cannot both certify and opt out.`,
      );
  }
  return lines.map((line) => `  ✗ ${line}`);
}

/** The product-state comparability headline, then one ✗ line per failing declared obligation. */
export function printComparability(input) {
  printSection(comparabilityHeadline(input), obligationLines(input));
}

// One-sided surfaces keep their own line. A baseline-capture failure is repair debt,
// not first adoption; only an unexplained after-only surface is NEW.
const ONE_SIDED = {
  removed: (s) => `${s}: ✗ REMOVED surface — captured only in the before set; the head no longer renders it`,
  'baseline-repair-debt': (s, sha) =>
    `${s}: ✗ baseline repair debt — captured only in the after set because ${s} failed${sha ? ` at ${sha}` : ''}; not a base recapture failure — repair that surface on the named SHA`,
  'genuinely-new': (s) =>
    `${s}: new surface — captured only in the after set, no baseline to compare; review before baselining`,
};

export function printOneSidedSurfaces(surfaces, baselineFailures) {
  for (const sd of surfaces) {
    if (sd.missing) printSection(ONE_SIDED[sd.classification](sd.surface, baselineFailures[0]?.sha));
  }
}

// One finding's lines: a heading, then its summarised property deltas. `inventory` =
// one-sided added path: head-side values with no baseline, never before → after restyles.
function findingLines(f, inventory = false) {
  if (f.kind === 'dom') return [];
  const rows = summarizeProps(f.props);
  if (!rows.length) return [];
  const head =
    f.kind === 'state'
      ? `  [:${f.state}] ${findingLabel(f.path, f.cls)}${f.sub !== f.path ? ` ⇒ ${f.sub}` : ''}`
      : `  ${findingLabel(f.path, f.cls)}${f.pseudo || ''}`;
  const note = inventory ? '  (head-side inventory — no baseline)' : '';
  return [
    head + note,
    ...rows.map((p) => (inventory ? `    ${p.prop}: ${p.after}` : `    ${p.prop}: ${p.before} → ${p.after}`)),
  ];
}

function elementLines(findings) {
  const lines = [];
  for (const group of groupByPath(findings)) {
    const dom = group.find((f) => f.kind === 'dom');
    if (dom) {
      lines.push(
        dom.change === 'retagged'
          ? `  DOM retagged: ${dom.path} ${dom.detail ?? ''}`
          : `  DOM ${dom.change}: ${findingLabel(dom.path, dom.cls)}`,
      );
    }
    for (const f of group) lines.push(...findingLines(f, dom?.change === 'added'));
  }
  return lines;
}

function printGroup(cg, max) {
  const lines = elementLines(cg.findings);
  const derived = derivedLonghandCount(cg.rep.raw) - derivedLonghandCount(cg.findings);
  const foldNote = derived > 0 ? ` (+${plural(derived, 'derived longhand')})` : '';
  const others = cg.surfaces.length - 1;
  const scope =
    others > 0
      ? `${cg.rep.surface} (+${plural(others, 'more surface')}: ${formatSurfaceList(cg.surfaces)})`
      : cg.rep.surface;
  printSection(`${scope}: ${groupTitle(cg.findings)}${foldNote}`, lines.slice(0, max));
  if (lines.length > max) console.log(`  ... and ${lines.length - max} more lines (re-run with --max ${lines.length})`);
}

/**
 * The changed surfaces, grouped the way the report does, so an identical change across N
 * surfaces prints once (with the count). Raw findings ride along to report the fold.
 * A change that rode the shared frame gets one Global chrome banner and prints first.
 */
export function printChangeGroups({
  surfaces,
  displayComparability,
  requireStateIdentity,
  surfacePaths,
  surfaceKeyOf,
  max,
}) {
  const nonCertifying = (receipt) =>
    receipt?.status === 'incomparable' ||
    (receipt?.status === 'unproven' && (receipt.required || requireStateIdentity));
  const preparedForGrouping = surfaces
    .filter((sd) => !sd.missing && !nonCertifying(displayComparability.find((entry) => entry.surface === sd.surface)))
    .map((sd) => ({ surface: sd.surface, findings: cleanFindingsForDisplay(sd.findings), raw: sd.findings }))
    .filter((p) => p.findings.length > 0);
  const { chrome, rest } = classifyChrome(groupBySignature(preparedForGrouping), surfacePaths, surfaceKeyOf);
  if (chrome.length) {
    const bases = countCapturedSurfaceBases([...surfacePaths.keys()], surfaceKeyOf);
    const span = chromeSpanLabel(countChangedSurfaceScope(chrome, surfaceKeyOf).bases, bases);
    printSection(
      `🧱 Global chrome change(s) — across ${span} captured surface base(s): ${chrome.length} change(s) rode the shared frame (a persistent nav, header, or footer).`,
    );
  }
  for (const cg of [...chrome, ...rest]) printGroup(cg, max);
}
