export {
  captureStyleMap,
  saveStyleMap,
  loadStyleMap,
  trackInflightRequests,
  trackDataResidue,
  urlMatcher,
} from './capture.js';
export * from './inventory.js';
export * from './data-residue.js';
export { captureUrlToDir, runCaptureUrl, parseCaptureUrlArgs, UsageError } from './capture-url.js';
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
export { loadSetupSteps } from './capture-url.js';
export type {
  StyleMap,
  CaptureOptions,
  CaptureMetadata,
  ElementEntry,
  LiveRegionCandidate,
  CapturedOverlay,
  Rect,
} from './capture.js';
export { defineStyleMapCapture, defineCrawlCapture } from './runner.js';
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
export type { Finding, PropChange, SurfaceDiff, DiffCounts, ContentChange } from './diff.js';
export { generateStyleMapReport, summarizeProps, prettyLabel } from './report.js';
export type { ReportOptions, ReportResult } from './report.js';
export { affectedSurfaces, classifyStyleChange, explainAffectedSurfaces } from './affected-surfaces.js';
export type { ModuleEdge, AffectedSurfacesInput, AffectedSurfaces } from './affected-surfaces.js';
