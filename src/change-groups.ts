/**
 * Pure grouping / classification of diff findings, shared by the visual report
 * and the terminal differ. A leaf (no `fs`, no `pngjs`, no `capture.js`) so a
 * bin can import it directly. Implementation lives in `prop-summary`,
 * `surface-keys`, `findings-clean` and `change-chrome`; this file re-exports the
 * public surface so `dist/change-groups.js` imports keep resolving.
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
  cleanFindingsForDisplay,
  isGeometryOnlyGroup,
  assessComparisonTruth,
  rawFindingsExplainedByLiveText,
} from './findings-clean.js';
export type { ComparisonTruth, ComparisonSurface } from './findings-clean.js';

export { groupBySignature, chromePaths, classifyChrome } from './change-chrome.js';
export type { SurfaceFindings, SignatureGroup } from './change-chrome.js';
