// Compatibility entry: the surface crawler lives in src/crawl/.
export { crawlAndCapture, removeSurfaceCaptureArtifacts } from './crawl/sweep.js';
export { runSetup } from './crawl/page.js';
export { CRAWL_DEFAULTS } from './crawl/types.js';
export type {
  CrawlCoverage,
  CrawlReport,
  CrawlStep,
  CrawledSurface,
  IncompleteUiObservation,
  SetupStep,
  SurfaceCrawlOptions,
} from './crawl/types.js';
