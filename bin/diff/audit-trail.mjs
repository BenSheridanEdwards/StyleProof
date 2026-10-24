// The durable audit trail's trust reasons, baseline source, and exit reason for one styleproof-diff run.

const check = (name, result, detail) => ({ check: name, result, detail });
/** One trust check per evidence class, keyed by the verdict's own status (`other` = failed). */
const TRUST_CHECKS = {
  coverage: {
    complete: (v) => check('coverage', 'complete', `${v.registrySize}/${v.registrySize} expected captured`),
    unasserted: () => check('coverage', 'unknown', 'completeness not asserted'),
    other: (v) => check('coverage', 'failed', `${v?.uncovered?.length ?? 0} uncaptured`),
  },
  determinism: {
    proven: () => check('determinism', 'proven', 'self-check passed'),
    unknown: () => check('determinism', 'unknown', 'determinism basis unknown'),
    other: () => check('determinism', 'failed', 'determinism unproven'),
  },
};
const trustCheck = (name, status, verdict) => (TRUST_CHECKS[name][status] ?? TRUST_CHECKS[name].other)(verdict);
const BASELINE_SOURCES = new Set(['exact-restore', 'ancestor-reuse', 'captured']);

export function trustReasons(run) {
  const reasons = [
    run.sourceBinding.status === 'bound'
      ? check('source-binding', 'bound', 'both SHAs matched')
      : check('source-binding', 'failed', 'source SHAs not verified'),
    trustCheck('coverage', run.coverageVerdict?.basis, run.coverageVerdict),
    trustCheck('determinism', run.determinismVerdict?.status, run.determinismVerdict),
    check('data-residue', run.residueFails ? 'failed' : 'clean', `${run.residueFails} unacknowledged`),
    check(
      'inventory',
      run.invRemovals ? 'failed' : 'clean',
      run.invRemovals ? `${run.invRemovals} unacknowledged removal(s)` : '0 removals',
    ),
  ];
  if (run.total > 0 || run.greenfieldNewSurfaces > 0) {
    reasons.push(
      check('reviewable-changes', 'found', `${run.total} style, ${run.greenfieldNewSurfaces} new surface(s)`),
    );
  }
  if (run.partialBaseline) reasons.push(check('baseline-surface-capture', 'failed', run.baselineAttribution.summary));
  if (run.headOnlyVolatile.length > 0) {
    reasons.push(check('volatility', 'failed', `${run.headOnlyVolatile.length} subtree(s) newly volatile on head`));
  }
  if (run.documentRootVolatile.length > 0) {
    reasons.push(
      check(
        'document-root-volatility',
        'failed',
        `${run.documentRootVolatile.length} document root(s) volatile on head`,
      ),
    );
  }
  if (run.baseOnlyVolatile.length > 0) {
    reasons.push(
      check('base-volatility', 'found', `${run.baseOnlyVolatile.length} subtree(s) volatile on the base only`),
    );
  }
  return reasons;
}

export function baselineSource(baselineProvenance, baseMapCount) {
  if (BASELINE_SOURCES.has(baselineProvenance?.baseline)) return baselineProvenance.baseline;
  return !baselineProvenance && baseMapCount > 0 ? 'captured' : 'none';
}

/** Exit 0 is certification only when certifiesFully; say which diagnostic it is otherwise. */
export function exitReason(exitCode, { certifiesFully, bound, clean }) {
  const reasons = {
    0: certifiesFully
      ? 'certified — no reviewable changes'
      : !bound
        ? 'not certified: unbound — no reviewable changes, but trusted source SHAs were not supplied'
        : 'not certified: diagnostic or advisory — no reviewable changes',
    1: clean ? 'non-certifying evidence' : 'reviewable differences found',
    3: 'new surfaces only — review before baselining',
  };
  return reasons[exitCode] || 'unknown';
}
