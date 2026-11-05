/** J2: pure changed-source-range × navigation-window execution join. */
import {
  executionIn,
  indexScriptSources,
  type ScriptExecutionIndex,
  type ScriptSourceEvidence,
} from './script-join-index.js';
import type { StyleMap } from './capture.js';
import type { SourcePosition, SourceSpan } from './script-reach.js';

export type ScriptChange = {
  sourceKey: string;
  side: 'base' | 'head';
  range: SourceSpan;
  /** SHA-256 of the entire git blob, not the changed substring. */
  contentHash: string;
  /** Full JavaScript lines containing the range, starting at range.start.line; token evidence and residual names only. Never persisted. */
  text: string;
  /** The entire changed line, rather than a trimmed token range. */
  changeScope?: 'line';
  /** Retain git-side lines when their captured source-key provenance is unavailable. */
  unmeasuredReason?: string;
};

export type ScriptExecution = 'ran' | 'never-ran' | 'partly-ran' | 'not-loaded' | 'unmeasured';

export type ScriptUnit = Omit<ScriptChange, 'text' | 'contentHash' | 'unmeasuredReason'> & {
  execution: ScriptExecution;
  status: 'reached' | 'never-rendered' | 'unmeasured' | 'unknown';
  why: string;
  level: 'warn';
  /** Names broader evidence when a changed token has no execution start of its own. */
  executionScope?: 'line' | 'preceding-anchor';
};

export type ScriptJoinGap = {
  join: 'J2';
  status: 'unmeasured';
  kind: 'execution';
  side?: 'base' | 'head';
  reason: string;
  remedy: string;
  paths?: string[];
  /** Full path count, also retained when presentation detail is truncated. */
  pathCount?: number;
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

export function compareSourceKeys(a: string, b: string): number {
  if (a === b) return 0;

  const left = Array.from(a),
    right = Array.from(b);

  const index = left.findIndex((character, i) => character !== right[i]);

  return index < 0 ? left.length - right.length : left[index].codePointAt(0)! - (right[index]?.codePointAt(0) ?? -1);
}

const comparePosition = (a: SourcePosition, b: SourcePosition): number => a.line - b.line || a.column - b.column;
const equalPosition = (a: SourcePosition, b: SourcePosition): boolean => comparePosition(a, b) === 0;

export function compareScriptRanges(
  a: Pick<ScriptChange, 'sourceKey' | 'side' | 'range'>,
  b: Pick<ScriptChange, 'sourceKey' | 'side' | 'range'>,
): number {
  return (
    compareSourceKeys(a.sourceKey, b.sourceKey) ||
    compareSourceKeys(a.side, b.side) ||
    comparePosition(a.range.start, b.range.start) ||
    comparePosition(a.range.end, b.range.end)
  );
}

type EvidenceSide = {
  files: Map<string, ScriptExecutionIndex>;
  reasons: string[];
  gaps: ScriptJoinGap[];
  missing: number;
};

function mappedFiles(
  reach: NonNullable<StyleMap['scriptReach']>,
  files: Map<string, ScriptSourceEvidence[]>,
  reasons: string[],
): void {
  for (const script of reach.scripts) {
    if (script.nonAppSourcesOnly && script.status === 'unmeasured' && script.reason === 'no mapped app sources')
      continue;
    if (script.status !== 'mapped') {
      reasons.push(script.reason ?? 'source map unavailable');
      continue;
    }

    for (const file of script.files ?? []) {
      if (!file.sourceKey) reasons.push('project-relative sourceKey absent');
      else files.set(file.sourceKey, [...(files.get(file.sourceKey) ?? []), { ...file, scriptUrl: script.url }]);
    }
  }
}

function evidenceSide(maps: readonly StyleMap[], side: 'base' | 'head'): EvidenceSide {
  const files = new Map<string, ScriptSourceEvidence[]>();
  const reasons: string[] = [];
  const gaps: ScriptJoinGap[] = [];
  const missing = maps.filter((map) => map.scriptReach?.version !== 1).length;

  const absent = !maps.length ? 1 : missing;

  if (absent)
    gaps.push(
      scriptJoinGap(
        `missing ${side} scriptReach coverage on ${missing || 'all'} capture(s); enable captureScriptReach`,
        side,
      ),
    );

  for (const map of maps) {
    const reach = map.scriptReach;

    if (!reach) continue;
    if (reach.projectRootIssue) reasons.push(reach.projectRootIssue);

    if (reach.status !== 'measured') {
      reasons.push(reach.reason ?? 'script coverage unavailable');
      continue;
    }

    mappedFiles(reach, files, reasons);
  }

  const sortedReasons = [...new Set(reasons)].sort(compareSourceKeys);

  for (const reason of sortedReasons) gaps.push(scriptJoinGap(`${side} script evidence: ${reason}`, side));

  return {
    files: new Map([...files].map(([key, sources]) => [key, indexScriptSources(sources)])),
    reasons: sortedReasons,
    gaps,
    missing: absent,
  };
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

function residualReason(text: string): string {
  const continuation = '; J2 block-entry limit: code after a throwing expression is not proved';
  if (text.length > 128)
    return '; J2 residual naming skipped for source lines over 128 UTF-16 code units' + continuation;
  const limits = residuals(text);
  const named = limits.length ? `; J2 block-entry residual: ${limits.join('; ')}` : '';
  return named + (limits.includes('code after a throwing expression') ? '' : continuation);
}

function emptyLine(change: ScriptChange): boolean {
  return change.changeScope === 'line' && change.text.length === 0;
}

function contentHashIssue(file: ScriptExecutionIndex, contentHash: string): string | undefined {
  if (file.hashes.has(undefined)) return 'captured sourcesContent content hash absent';
  if (file.hashes.size !== 1 || !file.hashes.has(contentHash))
    return 'content-hash mismatch between git blob and captured sourcesContent';
}

function classifyRange(change: ScriptChange, side: EvidenceSide, proofs: readonly SourceCorroboration[]): ScriptUnit {
  const { text, contentHash, unmeasuredReason, ...identity } = change;

  let scope: 'range' | 'line' | 'preceding-anchor' = 'range';

  const unit = (execution: ScriptExecution, status: ScriptUnit['status'], why: string): ScriptUnit => {
    const entry: ScriptUnit = { ...identity, execution, status, why, level: 'warn' };

    if (scope === 'line') {
      entry.executionScope = 'line';
      entry.why += '; line-scope evidence (column-zero source map)';
    }
    if (scope === 'preceding-anchor') {
      entry.executionScope = scope;
      entry.why += '; preceding-anchor evidence (nearest mapped start at or before the changed range)';
    }

    return entry;
  };

  if (unmeasuredReason) return unit('unmeasured', 'unmeasured', unmeasuredReason);
  const file = side.files.get(change.sourceKey);

  if (emptyLine(change)) return unit('unmeasured', 'unmeasured', 'no anchors on an empty line');

  if (!file) {
    if (side.missing) return unit('unmeasured', 'unmeasured', 'unmeasured: script coverage missing on this side');

    return side.reasons.length
      ? unit('unmeasured', 'unmeasured', side.reasons.join('; '))
      : unit('not-loaded', 'unmeasured', 'not loaded: changed file is in no capture source on this side');
  }

  const issue = contentHashIssue(file, contentHash);
  if (issue) return unit('unmeasured', 'unmeasured', issue);
  const measured = executionIn(change.range, file, text);
  const execution = measured.execution;
  scope = measured.scope;

  if (execution === 'unmeasured')
    return unit(
      execution,
      'unmeasured',
      measured.why ?? 'no mapped execution anchor inside or at or before the changed range',
    );

  if (execution === 'never-ran' || execution === 'partly-ran')
    return unit(
      execution,
      'never-rendered',
      [execution === 'never-ran' ? 'changed expression never ran' : 'changed expression only partly ran', measured.why]
        .filter(Boolean)
        .join('; '),
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
  return unit(execution, 'unknown', `value; rendering not proved${residualReason(text)}`);
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
    units: changes
      .filter((change) => comparePosition(change.range.start, change.range.end) < 0 || emptyLine(change))
      .sort(compareScriptRanges)
      .map((change) => classifyRange(change, sides[change.side], proofs)),
    gaps: [...sides.base.gaps, ...sides.head.gaps],
  };
}
