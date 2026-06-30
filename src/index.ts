export { captureStyleMap, saveStyleMap, loadStyleMap, trackInflightRequests } from './capture.js';
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
export { selectCrawlLinks, defaultLinkKey } from './crawl.js';
export type { CrawlLink, LinkMatch, SelectLinksOptions } from './crawl.js';
export { diffStyleMaps, diffStyleMapDirs, diffContentMaps, diffContentDirs, findingLabel } from './diff.js';
export type { Finding, PropChange, SurfaceDiff, DiffCounts, ContentChange } from './diff.js';
export { generateStyleMapReport, summarizeProps, prettyLabel } from './report.js';
export type { ReportOptions, ReportResult } from './report.js';
