import { collectElevatedNavigableChromeAdds, type ElevatedNavigableChrome } from './chrome-navigable-gate.js';
import type { DiffCounts } from './diff.js';
import {
  collectElevatedVisibleStructure,
  combinedStructureElevationCount,
  withElevatedVisibleStructureCounts,
  type ElevatedVisibleStructureResult,
} from './visible-structure-gate.js';

/** Structure changes the verdict treats as reviewable even with the content layer off. */
export type StructureElevation = {
  /** Navigable Global chrome additions (#766). */
  chrome: ElevatedNavigableChrome;
  /** Visible element adds/removes on paired surfaces. */
  visible: ElevatedVisibleStructureResult;
  /** DOM changes the two elevate, each counted once. */
  dom: number;
};

/**
 * Navigable Global chrome (#766) and visible paired-surface add/remove elevate into
 * reviewableCounts even when --include-content is off: structure is always on the maps.
 * Migration mode elevates nothing. The diff CLI and the report share this, so their
 * verdicts agree.
 */
export function collectStructureElevation(opts: {
  beforeDir: string;
  afterDir: string;
  migration: boolean;
  surfacePaths: Map<string, Set<string>>;
  surfaceKeyOf: (captureKey: string) => string | undefined;
}): StructureElevation {
  const { migration, ...dirs } = opts;
  const chrome = migration ? { count: 0, elevated: [] } : collectElevatedNavigableChromeAdds(dirs);
  const visible = migration ? { count: 0, elevated: [] } : collectElevatedVisibleStructure(dirs);
  return {
    chrome,
    visible,
    dom: combinedStructureElevationCount(
      visible,
      chrome.elevated.map((e) => e.change),
    ),
  };
}

/** Count elevated structure as reviewable DOM evidence. */
export function elevateReviewable(
  truth: { reviewableCounts: DiffCounts; hasReviewableEvidence: boolean },
  elevation: StructureElevation,
): { reviewableCounts: DiffCounts; hasReviewableEvidence: boolean } {
  return {
    reviewableCounts: withElevatedVisibleStructureCounts(truth.reviewableCounts, elevation.dom),
    hasReviewableEvidence: truth.hasReviewableEvidence || elevation.dom > 0,
  };
}
