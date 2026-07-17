/**
 * Pure grouping / classification of diff findings — the report's dedup brain,
 * lifted out of the crop-and-PNG machinery so BOTH the visual report
 * (`report.ts`, which renders screenshots on top) and the terminal differ
 * (`bin/styleproof-diff.mjs`, a leaf that must not pull Playwright-adjacent
 * modules) share ONE implementation. No `fs`, no `pngjs`, no `capture.js`: this
 * is a leaf so a bin can import it directly (#186 — bins import leaves, not the
 * barrel).
 *
 * Implementation is split across cohesive modules; this file re-exports the
 * public surface so existing `dist/change-groups.js` imports keep resolving:
 *   - `prop-summary` — collapse longhands/shorthands (`summarizeProps`)
 *   - `surface-keys` — safe display keys and product-surface base counts
 *   - `findings-clean` — signatures, titles, reflow strip, comparison truth
 *   - `change-chrome` — identical-change grouping + shared-chrome tier
 */

export { isNonValue, summarizeProps, prettyLabel } from './prop-summary.js';

export {
  safeKey,
  surfaceBase,
  surfaceWidth,
  productSurfaceBase,
  pushSurfaceWidth,
  renderSurfaceGroups,
  formatSurfaceList,
  countChangedSurfaceScope,
  countCapturedSurfaceBases,
  formatChangedSurfaceScope,
} from './surface-keys.js';

export {
  groupByPath,
  signatureOf,
  groupTitle,
  derivedLonghandCount,
  cleanFindings,
  assessComparisonTruth,
} from './findings-clean.js';
export type { ComparisonTruth, ComparisonSurface } from './findings-clean.js';

export { groupBySignature, chromePaths, classifyChrome } from './change-chrome.js';
export type { SurfaceFindings, SignatureGroup } from './change-chrome.js';
