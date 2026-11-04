/** J2: pure changed-source-range × navigation-window execution join. */
import type { StyleMap } from './capture.js';
import type { CompactSourceSpan, ScriptSourceReach, SourcePosition, SourceSpan } from './script-reach.js';

export type ScriptChange = {
  sourceKey: string;
  side: 'base' | 'head';
  range: SourceSpan;
  /** SHA-256 of the entire git blob, not the changed substring. */
  contentHash: string;
  /** Changed source lines, used only to name conservative residuals. Never persisted by the join. */
  text: string;
};

export type ScriptExecution = 'ran' | 'never-ran' | 'partly-ran' | 'not-loaded' | 'unmeasured';

export type ScriptUnit = Omit<ScriptChange, 'text' | 'contentHash'> & {
  execution: ScriptExecution;
  status: 'reached' | 'never-rendered' | 'unmeasured' | 'unknown';
  why: string;
  level: 'warn';
};

export type ScriptJoinGap = {
  join: 'J2';
  status: 'unmeasured';
  kind: 'execution';
  side?: 'base' | 'head';
  reason: string;
  remedy: string;
};

/** A later J3 can supply the same contract; token names and hunk membership are never proof. */
export type SourceCorroboration = {
  join: 'J1' | 'J3';
  status: string;
  sourceKey: string;
  side: 'base' | 'head';
  range: SourceSpan;
};

export type ScriptJoinResult = { units: ScriptUnit[]; gaps: ScriptJoinGap[] };

export function scriptJoinGap(reason: string, side?: 'base' | 'head'): ScriptJoinGap {
  const gap: ScriptJoinGap = {
    join: 'J2',
    status: 'unmeasured',
    kind: 'execution',
    reason,
    remedy:
      'capture both revisions with `captureScriptReach` and source maps, retaining their git SHAs and sourcesContent',
  };

  if (side) gap.side = side;

  return gap;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const comparePosition = (a: SourcePosition, b: SourcePosition): number => a.line - b.line || a.column - b.column;
const equalPosition = (a: SourcePosition, b: SourcePosition): boolean => comparePosition(a, b) === 0;

export function compareScriptRanges(
  a: Pick<ScriptChange, 'sourceKey' | 'side' | 'range'>,
  b: Pick<ScriptChange, 'sourceKey' | 'side' | 'range'>,
): number {
  return (
    compareText(a.sourceKey, b.sourceKey) ||
    compareText(a.side, b.side) ||
    comparePosition(a.range.start, b.range.start) ||
    comparePosition(a.range.end, b.range.end)
  );
}

function spanOf(tuple: CompactSourceSpan): SourceSpan {
  return { start: { line: tuple[0], column: tuple[1] }, end: { line: tuple[0], column: tuple[2] } };
}

function containsPoint(range: SourceSpan, point: SourcePosition): boolean {
  return comparePosition(range.start, point) <= 0 && comparePosition(point, range.end) < 0;
}

function overlaps(range: SourceSpan, span: SourceSpan): boolean {
  return equalPosition(span.start, span.end)
    ? containsPoint(range, span.start)
    : comparePosition(range.start, span.end) < 0 && comparePosition(span.start, range.end) < 0;
}

type EvidenceSide = { files: Map<string, ScriptSourceReach[]>; reasons: string[]; gaps: ScriptJoinGap[] };

function mappedFiles(
  reach: NonNullable<StyleMap['scriptReach']>,
  files: Map<string, ScriptSourceReach[]>,
  reasons: string[],
): void {
  for (const script of reach.scripts) {
    if (script.status !== 'mapped') {
      reasons.push(script.reason ?? 'source map unavailable');
      continue;
    }

    for (const file of script.files ?? []) {
      if (!file.sourceKey) reasons.push('project-relative sourceKey absent');
      else files.set(file.sourceKey, [...(files.get(file.sourceKey) ?? []), file]);
    }
  }
}

function evidenceSide(maps: readonly StyleMap[], side: 'base' | 'head'): EvidenceSide {
  const files = new Map<string, ScriptSourceReach[]>();
  const reasons: string[] = [];
  const gaps: ScriptJoinGap[] = [];
  const missing = maps.filter((map) => map.scriptReach?.version !== 1).length;

  if (!maps.length || missing)
    gaps.push(
      scriptJoinGap(
        `missing ${side} scriptReach coverage on ${missing || 'all'} capture(s); enable captureScriptReach`,
        side,
      ),
    );

  for (const map of maps) {
    const reach = map.scriptReach;

    if (!reach) continue;

    if (reach.status !== 'measured') {
      reasons.push(reach.reason ?? 'script coverage unavailable');
      continue;
    }

    mappedFiles(reach, files, reasons);
  }

  const sortedReasons = [...new Set(reasons)].sort();

  for (const reason of sortedReasons) gaps.push(scriptJoinGap(`${side} script evidence: ${reason}`, side));

  return { files, reasons: sortedReasons, gaps };
}

/** Executed extents are deliberately discarded. Negative/mixed extents remain spans. */
function executionIn(range: SourceSpan, files: ScriptSourceReach[]): ScriptExecution {
  const positive = files.flatMap((file) => file.executed.map(spanOf).map((span) => span.start));
  const ran = positive.some((point) => containsPoint(range, point));
  const negatives = files.flatMap((file) => [...file.unexecuted, ...file.mixed].map(spanOf));

  // Across surfaces, entry of this same original start witnesses a formerly idle block.
  const idle = negatives.some(
    (span) => overlaps(range, span) && !positive.some((point) => equalPosition(point, span.start)),
  );

  const mixed = files.some((file) => file.mixed.some((tuple) => overlaps(range, spanOf(tuple))));

  return idle || mixed ? (ran || mixed ? 'partly-ran' : 'never-ran') : ran ? 'ran' : 'unmeasured';
}

/** Detection only names limits; absence of these spellings never supplies rendering proof. */
function residuals(text: string): string[] {
  return [
    ...(/\bfunction\b[^]*?\([^]*?=|\([^)]*=.*\)\s*=>/.test(text) ? ['default parameter values'] : []),
    ...(/(?:\b(?:const|let|var)\s+)?[[{][^]*?\w\s*=[^]*?[\]}]\s*=/.test(text) ? ['destructuring defaults'] : []),
    ...(/(?:\|\||&&|\?\?)=/.test(text) ? ['logical assignment RHS'] : []),
    ...(/\?\./.test(text) ? ['later links of a short-circuited optional chain'] : []),
    ...(/\b[\w$]+\s*\([^]*?\)[^]*?;[^]*?\S/.test(text) ? ['code after a throwing expression'] : []),
  ];
}

function classifyRange(change: ScriptChange, side: EvidenceSide, proofs: readonly SourceCorroboration[]): ScriptUnit {
  const { text, contentHash, ...identity } = change;

  const unit = (execution: ScriptExecution, status: ScriptUnit['status'], why: string): ScriptUnit => ({
    ...identity,
    execution,
    status,
    why,
    level: 'warn',
  });

  const files = side.files.get(change.sourceKey) ?? [];

  if (!files.length)
    return side.reasons.length
      ? unit('unmeasured', 'unmeasured', side.reasons.join('; '))
      : unit('not-loaded', 'unmeasured', 'not loaded: changed file is in no capture source on this side');

  if (files.some((file) => !file.contentHash))
    return unit('unmeasured', 'unmeasured', 'captured sourcesContent content hash absent');

  if (files.some((file) => file.contentHash !== contentHash))
    return unit('unmeasured', 'unmeasured', 'content-hash mismatch between git blob and captured sourcesContent');
  const execution = executionIn(change.range, files);

  if (execution === 'unmeasured')
    return unit(execution, 'unmeasured', 'no mapped execution anchor or span inside the changed range');

  if (execution === 'never-ran' || execution === 'partly-ran')
    return unit(
      execution,
      'never-rendered',
      execution === 'never-ran' ? 'changed expression never ran' : 'changed expression only partly ran',
    );

  const corroborated = proofs.some(
    (proof) =>
      (proof.join === 'J1' || proof.join === 'J3') &&
      proof.status === 'reached' &&
      proof.sourceKey === change.sourceKey &&
      proof.side === change.side &&
      equalPosition(proof.range.start, change.range.start) &&
      equalPosition(proof.range.end, change.range.end),
  );

  if (corroborated)
    return unit(execution, 'reached', 'rendering corroborated by a reached J1/J3 unit from this exact source range');
  const limits = residuals(text);

  return unit(
    execution,
    'unknown',
    `value; rendering not proved${limits.length ? `; J2 block-entry residual: ${limits.join('; ')}` : ''}`,
  );
}

/** All findings are advisory at either changeReach level; this join never edits another gate. */
export function classifyScriptReach(
  base: readonly StyleMap[],
  head: readonly StyleMap[],
  changes: readonly ScriptChange[],
  proofs: readonly SourceCorroboration[] = [],
): ScriptJoinResult {
  const sides = { base: evidenceSide(base, 'base'), head: evidenceSide(head, 'head') };

  return {
    units: [...changes].sort(compareScriptRanges).map((change) => classifyRange(change, sides[change.side], proofs)),
    gaps: [...sides.base.gaps, ...sides.head.gaps],
  };
}
