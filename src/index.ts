export { captureStyleMap, saveStyleMap, loadStyleMap, trackInflightRequests } from './capture.js';
export type { StyleMap, CaptureOptions, CaptureMetadata, ElementEntry, LiveRegionCandidate, Rect } from './capture.js';
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
export { selectCrawlLinks, defaultLinkKey } from './crawl.js';
export type { CrawlLink, LinkMatch, SelectLinksOptions } from './crawl.js';
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
