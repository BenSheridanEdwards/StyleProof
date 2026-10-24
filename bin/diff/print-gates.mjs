// styleproof-diff human output, second half: one block per certification gate. Each
// gate printer that decides a verdict returns its failure count (or whether it blocks).
import { findingLabel } from '../../dist/diff.js';
import { liveTextFreezeError } from '../../dist/live-text.js';
import { printSection } from './output.mjs';

/** Returns the inventory gate's failure count: unacknowledged removals plus stale allowances. */
export function printInventoryAudit(audit) {
  if (!audit) return 0;
  const { delta, unexplained, staleAllowances, allowed } = audit;
  if (!delta.added.length && !delta.removed.length && !staleAllowances.length) {
    printSection('📐 Inventory: navigable set unchanged across captured surfaces');
    return 0;
  }
  printSection('📐 Inventory (navigable affordances — route links, tabs, menu items, nav buttons):', [
    ...delta.removed.map((it) =>
      allowed[it.key]
        ? `  removed: ${it.key} ("${it.label}") — acknowledged: ${allowed[it.key]}`
        : `  ✗ REMOVED, unacknowledged: ${it.key} ("${it.label}")`,
    ),
    ...delta.added.map((it) => `  + added: ${it.key} ("${it.label}")`),
    ...staleAllowances.map(
      (k) => `  ✗ stale allowRemoved (key is not actually removed): ${k} — prune it from styleproof.inventory.json`,
    ),
    ...(unexplained.length
      ? [
          `  → ${unexplained.length} unacknowledged removal(s): restore the affordance, or record the decision in styleproof.inventory.json {"<key>":"<why>"}.`,
        ]
      : []),
  ]);
  // A stale allowance blocks like a stale residue acknowledgement: it pre-acknowledges the next removal.
  return unexplained.length + staleAllowances.length;
}

/** Structure changes elevated into the reviewable verdict (see src/structure-elevation.ts). */
export function printStructureElevation(elevation) {
  if (elevation.chrome.count > 0) {
    printSection(
      `🧱 Global chrome navigable addition(s) — ${elevation.chrome.count} shared navigable affordance(s) added across surface bases; reviewable (STYLE_REVIEW_REQUIRED), Approve clears with other reviewable changes (#766).`,
    );
    for (const entry of elevation.chrome.elevated) {
      console.log(`  + ${entry.change.path} (${entry.change.cls || 'no-class'}) on ${entry.bases} surface base(s)`);
    }
  }
  if (elevation.visible.count > 0) {
    printSection(
      `🧱 Visible element addition(s)/removal(s) — ${elevation.visible.count} visible DOM structure change(s) on paired surfaces; reviewable (STYLE_REVIEW_REQUIRED), Approve clears with other reviewable changes.`,
    );
    for (const entry of elevation.visible.elevated) {
      console.log(
        `  ${entry.change.change === 'added' ? '+' : '-'} ${entry.change.path} (${entry.change.cls || 'no-class'}) on ${entry.surface}`,
      );
    }
  }
}

const RESIDUE_NEXT = {
  armed:
    '  → {n} unacknowledged failing endpoint(s): fixture each (page.route / liveStates), acknowledge intentional ones in styleproof.data-residue.json {"<key>":"<why>"}, or opt down with `dataResidue: "warn"` in the capture spec.',
  warn: '  → recorded and warned (dataResidue: "warn" — the opt-out). Remove it to restore the default gate that BLOCKS on these.',
  noLedger:
    '  → recorded and warned — the head bundle carries no coverage ledger (ad-hoc or pre-3.10 capture), so the residue gate cannot arm. A spec-driven capture records the ledger and gates by default.',
};

function residueLine(r, ack, armed) {
  if (ack !== undefined) return `  ${r.surface} · ${r.endpoint} (${r.reason}) — acknowledged: ${ack}`;
  return `  ${armed ? '✗ ' : '⚠ '}${r.surface} · ${r.endpoint} (${r.reason})${armed ? ', unacknowledged' : ''}`;
}

/** Returns the data-residue gate's failure count; 0 unless the gate is armed. */
export function printResidueAudit(audit) {
  if (!audit) return 0;
  const { residue, unacknowledged, staleAcknowledgements, armed, hasLedger, acknowledged } = audit;
  if (!residue.length && !staleAcknowledgements.length) {
    printSection('Failed data request: no API failed during capture');
    return 0;
  }
  const next = RESIDUE_NEXT[armed ? 'armed' : hasLedger ? 'warn' : 'noLedger'];
  printSection('Failed data request (an API failed during capture, so the screenshot is the fallback UI):', [
    ...residue.map((r) => residueLine(r, acknowledged[r.key], armed)),
    ...staleAcknowledgements.map((k) => `  ⚠ stale acknowledgement (endpoint no longer failing/present): ${k}`),
    ...(unacknowledged.length ? [next.replace('{n}', String(unacknowledged.length))] : []),
  ]);
  return armed ? unacknowledged.length + staleAcknowledgements.length : 0;
}

/** Coverage and determinism share one shape: proven / unknown (diagnostic escape) / failed. Returns "blocks". */
function printVerdict(status, allowUnasserted, { ok, unknown, okLine, unknownDiagnostic, unknownRefuse, failedLines }) {
  if (status === ok) {
    console.log(okLine);
    return false;
  }
  if (status === unknown) {
    console.log(allowUnasserted ? unknownDiagnostic : unknownRefuse);
    return !allowUnasserted;
  }
  console.log(failedLines);
  return true;
}

export function printCoverageVerdict(v, allowUnasserted) {
  const stale = (v.staleExclusions ?? [])
    .map((k) => `\n  ⚠ stale exclude (not in the registry): ${k} — prune it from the spec`)
    .join('');
  const uncovered = v.uncovered ?? [];
  return printVerdict(v.basis, allowUnasserted, {
    ok: 'complete',
    unknown: 'unasserted',
    okLine: `\n✓ coverage complete — all ${v.registrySize} registered surface(s) captured or explicitly excluded${stale}`,
    unknownDiagnostic:
      '\n⚠ completeness NOT asserted — diagnostic mode (--allow-unasserted): comparing captured surfaces only.\n' +
      '  This run does NOT certify fully. Declare `expected` for certifying captures.',
    unknownRefuse:
      '\n✗ completeness NOT asserted — refusing certification. A filtered, crawl, or registry-less\n' +
      '  capture cannot share exit 0 with a complete asserted capture. Declare `expected`, or pass\n' +
      '  --allow-unasserted for an explicit diagnostic comparison (certifiesFully: false).',
    failedLines:
      `\n✗ coverage INCOMPLETE — ${uncovered.length} registered surface(s) not captured (of ${v.registrySize}):` +
      uncovered.map((k) => `\n  ✗ missing: ${k}`).join('') +
      "\n  → capture each (or move it to `exclude` with a reason). A green can't certify what was never captured.",
  });
}

export function printDeterminismVerdict(v, allowUnasserted) {
  return printVerdict(v.status, allowUnasserted, {
    ok: 'proven',
    unknown: 'unknown',
    okLine: `\n✓ determinism proven — base ${v.base}, head ${v.head}`,
    unknownDiagnostic:
      '\n⚠ determinism basis unknown — diagnostic mode (--allow-unasserted): comparing as-is.\n' +
      '  This run does NOT certify fully. Spec-driven captures self-check and record the basis.',
    unknownRefuse:
      '\n✗ determinism basis unknown — refusing certification. A side carries no proven determinism\n' +
      '  ledger (filtered map, ad-hoc capture, or pre-ledger bundle). Spec-driven styleproof-map\n' +
      '  self-checks and records it; pass --allow-unasserted only for explicit diagnostic compares.',
    failedLines:
      `\n✗ determinism NOT proven — base ${v.base}, head ${v.head}. An unproven capture can drift, so a clean\n` +
      '  diff might be two matching NONDETERMINISTIC reads. Enable selfCheck (default) or replay a recorded HAR.',
  });
}

function pixelLayerLines(surface, layer) {
  if (layer.status === 'missing-both') {
    return [`  ${surface}: ✗ no screenshot on either side — nothing compared, surface uncertified`];
  }
  if (layer.status !== 'compared') {
    return [
      `  ${surface} [${layer.layer}]: ✗ screenshot ${layer.status.replace('-', ' on the ')} side — layer uncertified`,
    ];
  }
  const lines = layer.comparison.regions.map((region) => {
    const [x, y, w, h] = region.rect;
    const who = region.elements.length
      ? region.elements.map((e) => findingLabel(e.path, e.cls)).join(', ')
      : 'no captured element under the region';
    return `  ${surface} [${layer.layer}]: ${w}×${h} at ${x},${y} (${region.changedPixels} px) — ${who}`;
  });
  const mismatch = layer.comparison.sizeMismatch;
  if (mismatch) {
    lines.push(
      `    screenshot size ${mismatch.before[0]}×${mismatch.before[1]} → ${mismatch.after[0]}×${mismatch.after[1]}`,
    );
  }
  return lines;
}

/** The opt-in --pixels gate: every changed region, attributed to the elements under it. */
export function printPixelGate({ surfaces, regions, uncompared }) {
  const flagged = surfaces.filter((s) => s.regionCount > 0 || s.uncompared.length > 0);
  if (!surfaces.length) {
    printSection('✗ pixel gate: no paired capture to compare — nothing certified');
  } else if (!flagged.length) {
    printSection(
      `🖼 pixel gate: 0 changed region(s) across ${surfaces.length} paired capture(s), every screenshot layer compared`,
    );
  } else {
    printSection(
      `🖼 pixel gate: ${regions} changed region(s) in ${flagged.filter((s) => s.regionCount > 0).length} surface(s)` +
        (uncompared ? `, ${uncompared} uncertified layer(s)` : ''),
      flagged.flatMap((s) => s.layers.flatMap((layer) => pixelLayerLines(s.surface, layer))),
    );
  }
}

/** A freeze violation goes to stderr; declared live text that only drifted stays an advisory line. */
export function printLiveText(liveTextAudit, freezeViolated) {
  if (freezeViolated) {
    console.error(liveTextFreezeError(liveTextAudit));
  } else if (liveTextAudit?.declared && liveTextAudit.livePaths.length) {
    printSection(
      `⏱ live/age/clock text: ${liveTextAudit.livePaths.length} declared live-text change(s) kept advisory — not a stylesheet regression`,
    );
  }
}

/** Up to `max` volatile subtrees, one line each, then a count of the rest. */
function volatileLines(entries, mark, max) {
  return [
    ...entries.slice(0, max).map((v) => `  ${mark} ${v.surface}: ${v.path}`),
    ...(entries.length > max ? [`  ... and ${entries.length - max} more`] : []),
  ];
}

/** What the comparison could not see: volatile subtrees, skipped forced states, unrenderable raw deltas. */
export function printUncomparedWarnings({
  volatile,
  headOnlyVolatile,
  documentRootVolatile,
  baseOnlyVolatile,
  statesUncertified,
  rawOnlyNoReviewable,
  max,
}) {
  if (volatile > 0) {
    printSection(
      `⚠ ${volatile} auto-detected volatile subtree(s) excluded from the comparison (still mutating at capture\n` +
        '  settle) — changes inside them are NOT certified. Fixture the region, or `ignore` it deliberately.',
    );
  }
  if (headOnlyVolatile.length > 0) {
    printSection(
      `✗ ${headOnlyVolatile.length} subtree(s) newly volatile on head — still mutating at capture settle on the head but\n` +
        '  settled and compared on the base, so they were excluded and whatever changed inside them is NOT certified:',
      [
        ...volatileLines(headOnlyVolatile, '✗', max),
        '  → stop the head-side churn (a timer, stream, or animation the PR added), fixture it, or `ignore` the region on both sides.',
      ],
    );
  }
  if (documentRootVolatile.length > 0) {
    printSection(
      `✗ ${documentRootVolatile.length} document root(s) volatile on head — html or body was still mutating at capture settle,\n` +
        '  so the whole page under it was excluded and NOT certified:',
      [
        ...volatileLines(documentRootVolatile, '✗', max),
        '  → fixture the churning region, or `ignore` it so the rest of the page is compared.',
      ],
    );
  }
  if (baseOnlyVolatile.length > 0) {
    printSection(
      `⚠ ${baseOnlyVolatile.length} subtree(s) volatile on the base only — still mutating at capture settle on the base but\n` +
        '  settled on the head, so they were excluded and whatever the head renders inside them is NOT checked (review required):',
      [
        ...volatileLines(baseOnlyVolatile, '⚠', max),
        '  → review the head rendering there and approve, or fixture the base-side churn so the next baseline compares it.',
      ],
    );
  }
  if (statesUncertified > 0) {
    printSection(
      `⚠ forced-state layer uncertified on ${statesUncertified} surface(s): at least one capture skipped or did not support it, so\n` +
        '  :hover/:focus/:active differences there were not fully compared.',
    );
  }
  if (rawOnlyNoReviewable) {
    printSection(
      '⚠ report consistency: raw certification delta(s) have no reviewable rendering — the visual ' +
        'report would show nothing for a gating change. Failing closed as a certification inconsistency ' +
        '(not STYLE_REVIEW_REQUIRED, not a base recapture failure). Re-run with styleproof-report --include-layout-noise to inspect.',
    );
  }
}
