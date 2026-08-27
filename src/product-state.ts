import { type ContentChange } from './diff.js';
import { surfaceBase } from './surface-keys.js';

/**
 * When two captures of the same surface are different product states, the
 * certification differ still emits computed-style findings (a mode chip's
 * background, a focus ring on a different button). Those are not a restyle
 * the reviewer should approve. Detect the mismatch from the opt-in content
 * layer; the report then withholds those findings from the style gate.
 *
 * The differ itself stays exact (no tolerance). This is report classification.
 */

export type IncomparableProductState = {
  surfaceBase: string;
  evidence: string[];
};

const WHOLESALE_JACCARD = 0.25;
const MIN_LABEL_TOKENS = 2;
const STRUCTURE_CHURN_FLOOR = 8;

function normalizeLabel(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toUpperCase();
}

function tokens(value: string): string[] {
  return value.split(/[^A-Z0-9]+/).filter((part) => part.length > 0);
}

/** True when both sides are distinct mode-like labels, not a small copy edit. */
export function isWholesaleLabelReplacement(before: string, after: string): boolean {
  const left = normalizeLabel(before);
  const right = normalizeLabel(after);
  if (!left || !right || left === right) return false;
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (leftTokens.length < MIN_LABEL_TOKENS || rightTokens.length < MIN_LABEL_TOKENS) return false;
  const leftSet = new Set(leftTokens);
  let shared = 0;
  for (const token of rightTokens) {
    if (leftSet.has(token)) shared += 1;
  }
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union > 0 && shared / union < WHOLESALE_JACCARD;
}

/** Evidence strings when this surface's content layer is a different product state. */
export function productStateMismatchEvidence(changes: ContentChange[]): string[] {
  const evidence: string[] = [];
  let structureChurn = 0;
  for (const change of changes) {
    if (change.kind === 'text' && isWholesaleLabelReplacement(change.before, change.after)) {
      evidence.push(`\`${change.before}\` vs \`${change.after}\``);
    }
    if (change.kind === 'structure' && (change.change === 'added' || change.change === 'removed')) {
      structureChurn += 1;
    }
  }
  if (structureChurn >= STRUCTURE_CHURN_FLOOR) {
    evidence.push(`${structureChurn} structural add/remove(s)`);
  }
  return evidence;
}

/** Collapse per-width content diffs onto product surface bases. */
export function incomparableProductStates(
  surfaces: { surface: string; changes: ContentChange[] }[],
): IncomparableProductState[] {
  const byBase = new Map<string, string[]>();
  for (const surface of surfaces) {
    const evidence = productStateMismatchEvidence(surface.changes);
    if (evidence.length === 0) continue;
    const base = surfaceBase(surface.surface);
    const existing = byBase.get(base) ?? [];
    for (const item of evidence) {
      if (!existing.includes(item)) existing.push(item);
    }
    byBase.set(base, existing);
  }
  return [...byBase.entries()].map(([name, evidence]) => ({ surfaceBase: name, evidence }));
}

export function incomparableSurfaceBaseSet(states: IncomparableProductState[]): Set<string> {
  return new Set(states.map((state) => state.surfaceBase));
}
