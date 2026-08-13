// Side effect first: under STYLEPROOF_FREEZE_SPEC_CLOCK=1 (set by styleproof-map)
// this pins the spec process's Date before the importing spec evaluates its own
// module-level fixture constants — see src/spec-clock.ts for why.
import './spec-clock.js';

export {
  DEFAULT_CLOCK_TIME,
  realNow,
  resolveSpecClockFreeze,
  installFrozenSpecClock,
  restoreRealSpecClock,
  frozenSpecClockInstant,
} from './spec-clock.js';
export {
  captureStyleMap,
  saveStyleMap,
  loadStyleMap,
  trackInflightRequests,
  trackDataResidue,
  urlMatcher,
  captureStateLayerScreenshots,
  captureSurfaceScreenshots,
  STATE_LAYER_NAMES,
} from './capture.js';
export * from './inventory.js';
export * from './data-residue.js';
export {
  captureUrlToDir,
  runCaptureUrl,
  parseCaptureUrlArgs,
  loadAuthBoundaryExclude,
  UsageError,
} from './capture-url.js';
export type { CaptureUrlOptions, CaptureUrlResult } from './capture-url.js';
export { crawlAndCapture, CRAWL_DEFAULTS } from './crawl-surfaces.js';
export type {
  SurfaceCrawlOptions,
  CrawlReport,
  CrawlCoverage,
  CrawledSurface,
  CrawlStep,
  SetupStep,
} from './crawl-surfaces.js';
export {
  resolveCrawlConfidence,
  normalizeAuthBoundaryExclude,
  authBoundaryKey,
  mergeAuthBoundaryObservations,
  redactedRoutePath,
  shouldRetainAuthRedirects,
  cliSafeLine,
  crawlCaptureExitCode,
} from './crawl-confidence.js';
export type {
  CrawlConfidence,
  CrawlConfidenceStatus,
  AuthBoundaryObservation,
  AuthBoundaryExclude,
} from './crawl-confidence.js';
export { loadSetupSteps } from './capture-url.js';
export type {
  StyleMap,
  CaptureOptions,
  CaptureMetadata,
  StateRecipeCaptureProvenance,
  ElementEntry,
  LiveRegionCandidate,
  CapturedOverlay,
  Rect,
} from './capture.js';
export { defineStyleMapCapture, defineCrawlCapture, isSelfCheckCaptureFailure } from './runner.js';
export type {
  Surface,
  SurfaceLiveState,
  SurfaceVariant,
  PopupCaptureOptions,
  DefineOptions,
  CrawlOptions,
} from './runner.js';
export { coverageGaps } from './coverage.js';
export type { CoverageGaps } from './coverage.js';
export { detectViewportWidths, mediaTextWidthBoundaries, widthsFromBoundaries } from './breakpoints.js';
export { discoverNextRoutes } from './routes.js';
export type { DiscoveredRoute } from './routes.js';
export { discoverComponentFiles, componentCatalogSurfaces } from './components.js';
export type {
  DiscoveredComponent,
  DiscoverComponentFilesOptions,
  ComponentCatalogSurfaceOptions,
} from './components.js';
export {
  validateComponentManifest,
  isSerializableManifestValue,
  slugManifestSegment,
  componentManifestSurfaceKey,
  componentManifestCatalogPath,
  componentManifestToDiscovered,
  componentManifestCatalogSurfaces,
  ComponentManifestError,
} from './component-manifest.js';
export type {
  ManifestJsonPrimitive,
  ManifestJsonValue,
  ComponentManifestVariant,
  ComponentManifestComponent,
  ComponentManifestExclusion,
  ComponentManifest,
  ValidateComponentManifestOptions,
  ComponentManifestSurfaceKeyInput,
  ComponentManifestCatalogPathOptions,
  ComponentManifestCatalogSurfaceOptions,
} from './component-manifest.js';
export { selectCrawlLinks, defaultLinkKey, crawlCoverageGaps, crawlCoverageError } from './crawl.js';
export type { CrawlLink, LinkMatch, SelectLinksOptions, CrawlCoverageGaps } from './crawl.js';
export { harvestStyleVariants } from './variant-crawler.js';
export type {
  HarvestAction,
  HarvestedLiveState,
  HarvestedRoute,
  HarvestedVariant,
  HarvestRoute,
  HarvestSkip,
  VariantHarvest,
  VariantHarvestOptions,
} from './variant-crawler.js';
export { diffStyleMaps, diffStyleMapDirs, diffContentMaps, diffContentDirs, findingLabel } from './diff.js';
export type { Finding, PropChange, SurfaceDiff, DiffCounts, ContentChange, DiffStyleOptions } from './diff.js';
export { generateStyleMapReport, summarizeProps, prettyLabel, assessComparisonTruth } from './report.js';
export type { ReportOptions, ReportResult, ComparisonTruth } from './report.js';
export { affectedSurfaces, classifyStyleChange, explainAffectedSurfaces } from './affected-surfaces.js';
export type { ModuleEdge, AffectedSurfacesInput, AffectedSurfaces } from './affected-surfaces.js';

export { classifyAuthBoundary, isAuthPath } from './auth-boundary.js';
export type { AuthBoundaryMetadata, AuthBoundaryDiagnostic } from './auth-boundary.js';

export { classifyIncompleteUi } from './incomplete-ui.js';
export type { IncompleteUiMetadata, IncompleteUiDiagnostic } from './incomplete-ui.js';

export {
  ALLOWED_PRESS_KEYS,
  validateStateRecipe,
  parseStateRecipes,
  stateRecipeKey,
  classifyStateRecipe,
  applyStateRecipe,
  stateRecipeGo,
  isAllowedPressKey,
  isUnsafeStateLabel,
  StateRecipeError,
} from './state-recipes.js';
export type {
  StateRecipeAction,
  AllowedPressKey,
  StateRecipe,
  AppliedStateRecipe,
  StateRecipeSkip,
  StateRecipeSkipReason,
} from './state-recipes.js';
