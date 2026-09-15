// Side effect first: under STYLEPROOF_FREEZE_SPEC_CLOCK=1 (set by styleproof-map)
// this pins the spec process's Date before the importing spec evaluates its own
// module-level fixture constants — see src/spec-clock.ts for why.
import './spec-clock.js';

// ---------------------------------------------------------------------------
// Spec API — what consumer-authored spec files and styleproof.config.ts import.
// Everything else is internal: import the leaf module (src/<name>.ts /
// dist/<name>.js) instead of the package root.
// ---------------------------------------------------------------------------

// Frozen-clock escape hatch for spec files that need real wall time.
export {
  DEFAULT_CLOCK_TIME,
  realNow,
  resolveSpecClockFreeze,
  installFrozenSpecClock,
  restoreRealSpecClock,
  frozenSpecClockInstant,
} from './spec-clock.js';

// Capture definitions.
export { defineStyleMapCapture, defineCrawlCapture, isSelfCheckCaptureFailure } from './runner.js';
export type {
  Surface,
  SurfaceLiveState,
  SurfaceVariant,
  PopupCaptureOptions,
  DefineOptions,
  CrawlOptions,
} from './runner.js';

// Surface discovery helpers for spec files.
export { discoverNextRoutes } from './routes.js';
export type { DiscoveredRoute } from './routes.js';
export { discoverComponentFiles, componentCatalogSurfaces } from './components.js';
export type {
  DiscoveredComponent,
  DiscoverComponentFilesOptions,
  ComponentCatalogSurfaceOptions,
} from './components.js';
export { collectManifestDiagnostics } from './manifest-harness.js';
export type {
  StaticModuleExports,
  ComponentStaticRegistry,
  ManifestDiagnosticKind,
  ManifestDiagnostic,
  CollectManifestDiagnosticsOptions,
} from './manifest-harness.js';
export {
  validateComponentManifest,
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
  ComponentManifestCatalogPathOptions,
  ComponentManifestCatalogSurfaceOptions,
} from './component-manifest.js';

// Affected-surface scoping for config `affected` blocks.
export { affectedSurfaces, classifyStyleChange, explainAffectedSurfaces } from './affected-surfaces.js';
export type { ModuleEdge, AffectedSurfacesInput, AffectedSurfaces } from './affected-surfaces.js';

// Determinism oracle for proving capture stability inside specs.
export { assessDeterminismOracle, determinismRunReceipt, hashDeterminismMap } from './determinism-oracle.js';
export type { DeterminismRunReceipt, DeterminismFlakeReason, DeterminismOracleVerdict } from './determinism-oracle.js';

// State recipes declared by spec surfaces and the productState config.
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

// Viewport discovery helpers for spec files.
export { detectViewportWidths, mediaTextWidthBoundaries, widthsFromBoundaries } from './breakpoints.js';

// Config files.
export { defineConfig, env } from './config.js';
export type {
  StyleProofConfig,
  AffectedConfig,
  CrawlConfig,
  AuthConfig,
  MapStoreConfig,
  AncestorBaselineConfig,
  CoverageConfig,
  ProductStateConfig,
  EnvRef,
} from './config.js';

// ---------------------------------------------------------------------------
// Core functions — capture, diff, report.
// ---------------------------------------------------------------------------

export {
  captureStyleMap,
  saveStyleMap,
  loadStyleMap,
  trackInflightRequests,
  validateProductStateIdentity,
  ProductStateIdentityError,
} from './capture.js';
export type {
  StyleMap,
  CaptureOptions,
  ForcedStateLimits,
  CaptureMetadata,
  ProductStateIdentity,
  StateRecipeCaptureProvenance,
  ElementEntry,
  LiveRegionCandidate,
  CapturedOverlay,
  Rect,
} from './capture.js';

export { diffStyleMaps, diffStyleMapDirs } from './diff.js';
export type {
  Finding,
  PropChange,
  SurfaceDiff,
  DiffCounts,
  DiffStyleOptions,
  ProductStateComparabilityStatus,
  SurfaceComparability,
  ComparabilitySummary,
} from './diff.js';

export { generateStyleMapReport } from './report.js';
export type { ReportOptions, ReportResult, ComparisonTruth } from './report.js';
